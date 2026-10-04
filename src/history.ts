/**
 * History -> text, the way docs/REFERENCE-NOTES.md §4a describes
 * `renderNativeCliPrompt`: prior tool calls as `[called name(args)]`, tool
 * results as their text, history images hoisted with `[image #n]` placeholders,
 * unknown blocks as `[<type> block omitted]`, and the trailing run of user
 * messages kept as the live prompt (without a role prefix).
 *
 * The cold-start path uses this: a request that matches no live process gets a
 * brand-new Claude process whose opening user message is this rendering.
 */

import type { OpenAiContentPart, OpenAiMessage, OpenAiToolCall } from './openai-types.js';
import type { ToolMirror } from './tool-mirror.js';

export const TRANSCRIPT_HISTORY_BEGIN = '=== Conversation history (oldest first) ===';
export const TRANSCRIPT_HISTORY_END = '=== End of conversation history ===';

export interface RenderedImage {
  readonly mediaType: string;
  readonly dataBase64: string;
}

export interface RenderedConversation {
  readonly systemText: string;
  readonly historyText: string;
  readonly liveText: string;
  readonly images: readonly RenderedImage[];
  readonly messageCount: number;
}

const DATA_URL = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

function imageUrlOf(part: OpenAiContentPart): string | undefined {
  const raw = part.image_url;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') {
    const url = (raw as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return undefined;
}

export function renderConversation(
  messages: readonly OpenAiMessage[],
  mirror: ToolMirror,
): RenderedConversation {
  const systemParts: string[] = [];
  const conversational: OpenAiMessage[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    conversational.push(message);
  }

  const images: RenderedImage[] = [];
  let imageCounter = 0;

  const renderContent = (content: unknown, isHistory: boolean): string => {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const rawPart of content) {
      const part = rawPart as OpenAiContentPart;
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text') {
        parts.push(typeof part.text === 'string' ? part.text : '');
        continue;
      }
      if (part.type === 'image_url') {
        const url = imageUrlOf(part);
        const match = url === undefined ? null : DATA_URL.exec(url);
        imageCounter += 1;
        if (match !== null) {
          const index = images.length + 1;
          images.push({ mediaType: match[1] ?? 'image/png', dataBase64: (match[2] ?? '').replace(/\s+/g, '') });
          parts.push(`[image #${index}]`);
        } else {
          parts.push('[image omitted: not a data URL]');
        }
        continue;
      }
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      parts.push(`[${type} block omitted]`);
    }
    return parts.join('');
  };

  const renderToolCalls = (calls: readonly OpenAiToolCall[] | null | undefined): string => {
    if (!Array.isArray(calls)) return '';
    const parts: string[] = [];
    for (const call of calls) {
      if (call === null || typeof call !== 'object') continue;
      const rawName = typeof call.function?.name === 'string' ? call.function.name : '';
      if (rawName.length === 0) continue;
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
      parts.push(`[called ${mirror.transcriptNameFor(rawName)}(${args})]`);
    }
    return parts.join('');
  };

  const renderMessageBody = (message: OpenAiMessage, isHistory: boolean): string => {
    const content = renderContent(message.content, isHistory);
    if (message.role === 'assistant') return `${content}${renderToolCalls(message.tool_calls)}`;
    return content;
  };

  const trailingUserIndex = findTrailingUserRunStart(conversational);
  const historyMessages = conversational.slice(0, trailingUserIndex);
  const liveMessages = conversational.slice(trailingUserIndex);

  let historyText = '';
  if (historyMessages.length > 0) {
    const lines: string[] = [TRANSCRIPT_HISTORY_BEGIN];
    for (const message of historyMessages) {
      const role = typeof message.role === 'string' ? message.role : 'unknown';
      lines.push(`[${role}] ${renderMessageBody(message, true)}`);
    }
    lines.push(TRANSCRIPT_HISTORY_END);
    historyText = lines.join('\n');
  }

  const liveParts: string[] = [];
  for (const message of liveMessages) {
    const body = renderMessageBody(message, false);
    if (body.length > 0) liveParts.push(body);
  }

  return {
    systemText: systemParts.join('\n\n'),
    historyText,
    liveText: liveParts.join('\n\n'),
    images,
    messageCount: messages.length,
  };
}

/**
 * Start index of the trailing contiguous run of user messages — the live
 * prompt. Tool results (`role: "tool"`) break the run, matching the reference
 * behaviour where only the newest user turn is live and everything else is
 * history.
 */
function findTrailingUserRunStart(messages: readonly OpenAiMessage[]): number {
  let index = messages.length;
  while (index > 0 && messages[index - 1]?.role === 'user') index -= 1;
  return index;
}

/** The last prompt text to hand Claude; the history is prepended by the caller. */
export function composeOpeningPrompt(rendered: RenderedConversation): string {
  const sections: string[] = [];
  if (rendered.historyText.length > 0) sections.push(rendered.historyText);
  if (rendered.liveText.length > 0) sections.push(rendered.liveText);
  const prompt = sections.join('\n\n');
  return prompt.length > 0 ? prompt : '(no user message)';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const part = raw as OpenAiContentPart;
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}
