/**
 * The subset of the OpenAI Chat Completions wire that Hermes actually sends and
 * accepts. Shapes and required fields come from docs/HERMES-CLIENT-FACTS.md
 * (§2 request, §3 streaming, §4 non-streaming, §9 envelopes).
 *
 * The reader is deliberately permissive: Hermes may add `extra_body` /
 * `request_overrides` keys, and SPEC.md says the bridge must tolerate what
 * Hermes may send.
 */

export interface OpenAiFunctionSchema {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
}

export interface OpenAiTool {
  type?: unknown;
  function?: OpenAiFunctionSchema;
}

export interface OpenAiToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown } | undefined;
}

export interface OpenAiContentPart {
  type?: unknown;
  text?: unknown;
  image_url?: unknown;
}

export type OpenAiMessageContent = string | null | OpenAiContentPart[];

export interface OpenAiMessage {
  role?: unknown;
  content?: OpenAiMessageContent;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: OpenAiToolCall[] | null;
}

export interface OpenAiChatRequest {
  model?: unknown;
  messages?: OpenAiMessage[];
  tools?: OpenAiTool[] | null;
  tool_choice?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown } | null;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  temperature?: unknown;
  response_format?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAiChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: string | null;
}

export interface OpenAiChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
  usage?: OpenAiUsage;
}

export interface OpenAiCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage: OpenAiUsage;
}

export interface OpenAiModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export function chunkEnvelope(params: {
  id: string;
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
  usage?: OpenAiUsage;
}): OpenAiChunk {
  const chunk: OpenAiChunk = {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: params.choices,
  };
  if (params.usage !== undefined) chunk.usage = params.usage;
  return chunk;
}

/** `chatcmpl-<hex>` — same shape Hermes' own reference server emits (§9). */
export function newCompletionId(randomHex: string): string {
  return `chatcmpl-${randomHex}`;
}
