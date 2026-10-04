/**
 * Conversation identity and the two correlation inputs SPEC.md names:
 *  1. parked tool_call_ids (exact, all-or-nothing), and
 *  2. "a stable hash of (system prompt, tool-list fingerprint, the message
 *     history prefix)" for a new user turn.
 *
 * The prefix check is what makes "never resume on a partial match" real: a live
 * process records the canonical (length, hash) of the message list it last
 * served, and a later request may continue that process only when its own
 * message list literally begins with those same messages.
 */

import { createHash } from 'node:crypto';

import type { OpenAiMessage } from './openai-types.js';
import type { ToolResultPayload } from './parked.js';

const SEP = '\u0000';
const FIELD = '\u0001';

/** Deterministic, content-preserving canonical form of one message. */
export function canonicalMessage(message: OpenAiMessage): string {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const content =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null);
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(call => {
        const name = typeof call?.function?.name === 'string' ? call.function.name : '';
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
        const id = typeof call.id === 'string' ? call.id : '';
        return `${id}${FIELD}${name}${FIELD}${args}`;
      })
    : [];
  return [role, content, toolCallId, calls.join(FIELD)].join(FIELD);
}

/** Hash of the first `length` messages, in order. */
export function messagesPrefixHash(messages: readonly OpenAiMessage[], length: number): string {
  const hash = createHash('sha256');
  const bound = Math.min(length, messages.length);
  for (let i = 0; i < bound; i += 1) {
    const message = messages[i];
    hash.update(message === undefined ? '' : canonicalMessage(message));
    hash.update(SEP);
  }
  return hash.digest('hex').slice(0, 32);
}

export function systemTextOf(messages: readonly OpenAiMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue;
    if (typeof message.content === 'string') {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      }
    }
  }
  return parts.join('\n\n');
}

export function hashSystem(systemText: string): string {
  return createHash('sha256').update(systemText).digest('hex').slice(0, 16);
}

export interface TrailingToolResult {
  readonly id: string;
  readonly payload: ToolResultPayload;
}

function toolText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const part = raw as { type?: unknown; text?: unknown };
      if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      } else if (part !== null && typeof part === 'object' && part.type === 'image_url') {
        parts.push('[image omitted from tool result]');
      }
    }
    return parts.join('\n');
  }
  return JSON.stringify(content);
}

/**
 * The trailing contiguous run of `role: "tool"` messages — the results Hermes
 * is handing back for calls this bridge parked. Results come last
 * (docs/HERMES-CLIENT-FACTS.md §5.2).
 */
export function trailingToolResults(messages: readonly OpenAiMessage[]): TrailingToolResult[] {
  const results: TrailingToolResult[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'tool') break;
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
    if (id === undefined || id.length === 0) continue;
    results.unshift({
      id,
      payload: { content: [{ type: 'text', text: toolText(message.content) }] },
    });
  }
  return results;
}

/**
 * True when `messages` is a strict continuation of the message list a live
 * process last served: same leading messages, and the added suffix is only an
 * optional final assistant answer followed by new user turns.
 */
export function isContinuation(
  messages: readonly OpenAiMessage[],
  prevLength: number,
  prevHash: string,
): boolean {
  if (prevLength <= 0 || messages.length <= prevLength) return false;
  if (messagesPrefixHash(messages, prevLength) !== prevHash) return false;
  const suffix = messages.slice(prevLength);
  let seenUser = false;
  for (const message of suffix) {
    const role = message?.role;
    if (role === 'tool') return false;
    if (role === 'user') {
      seenUser = true;
      continue;
    }
    if (role === 'assistant' && !seenUser && !hasToolCalls(message)) continue;
    return false;
  }
  return seenUser;
}

function hasToolCalls(message: OpenAiMessage): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}
