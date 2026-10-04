/**
 * The scripted fake.
 *
 * Two jobs:
 *  1. tests: a deterministic `query()` replacement that emits exactly the SDK
 *     message sequence a real CLI would, and drives tool calls through the SAME
 *     bridge code path (`mcp.invoke`, which is the MCP request handler);
 *  2. `--fake` mode: a policy that behaves like a cooperative model, so the
 *     bridge can be exercised end to end without the real binary.
 *
 * It never spawns claude and never touches the network.
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PassThrough } from 'node:stream';
import type { ChildLike, GroupKill, SpawnRecord, SpawnedGroupChild } from './spawn.js';
import { GroupSpawner } from './spawn.js';
import type { Clock } from './clock.js';
import { createDeferred, type Deferred } from './deferred.js';
import type { QueryFactory, QueryFactoryInput, QueryLike } from './process.js';

export type FakeStep =
  /** Stream assistant text. */
  | { kind: 'text'; text: string }
  /** Call one or more bridged tools; the fake then blocks exactly like the CLI. */
  | { kind: 'toolCalls'; calls: ReadonlyArray<{ name: string; args?: unknown; toolUseId?: string }> }
  /**
   * Call several bridged tools in ONE assistant message, dispatched the way
   * the real CLI runs non-read-only MCP tools: serially, the next handler only
   * after the previous one returns. While blocked it emits `tool_progress`
   * heartbeats every `heartbeatMs` (real-time ms), as the CLI does.
   */
  | {
      kind: 'serialToolCalls';
      calls: ReadonlyArray<{ name: string; args?: unknown; toolUseId?: string }>;
      heartbeatMs?: number;
    }
  /** Reply with text derived from the tool result just delivered. */
  | { kind: 'toolEcho' }
  /** Wait for one more user message to be pushed before this turn's steps run. */
  | { kind: 'await' }
  /** An `assistant` frame carrying an error code (auth, rate limit, ...). */
  | { kind: 'assistantError'; error: string }
  /** An `auth_status` frame with an error. */
  | { kind: 'authStatus'; error: string }
  /** A terminal `result` frame with an error subtype. */
  | { kind: 'resultError'; subtype: string; result?: string; errors?: string[]; terminalReason?: string }
  /** Emit nothing and stay silent (the stall-watchdog path). */
  | { kind: 'silent' }
  /** Throw out of the query generator (process failure). */
  | { kind: 'throw'; message: string }
  /** End the message stream (CLI exit). */
  | { kind: 'exit' };

export interface FakeTurn {
  readonly steps: readonly FakeStep[];
}

export type FakeProgram = ReadonlyArray<readonly FakeStep[]>;

export interface ScriptedFakeOptions {
  /** Emit `stream_event` partials as well as assembled assistant frames. */
  readonly partials?: boolean;
  /** `apiKeySource` on the init frame. */
  readonly apiKeySource?: string;
  readonly usage?: { input_tokens: number; output_tokens: number };
  readonly sessionId?: string;
}

export interface ScriptedQueryFactory extends QueryFactory {
  /** Every `query()` call this fake served, in order (one per Claude process). */
  readonly calls: Array<{ index: number; options: QueryFactoryInput['options']; meta: QueryFactoryInput['meta'] }>;
  readonly closed: number[];
  /** Tool results the bridge delivered, for assertions. */
  readonly toolResults: Array<{ toolUseId: string; text: string }>;
}

const INIT: Omit<Extract<SDKMessage, { type: 'system' }>, 'apiKeySource'> = {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/claude-bridge-fake',
  tools: [],
  mcp_servers: [{ name: 'hermes', status: 'connected' }],
  model: 'fake',
  permissionMode: 'default',
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
} as unknown as Omit<Extract<SDKMessage, { type: 'system' }>, 'apiKeySource'>;

function chunk(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 12) parts.push(text.slice(i, i + 12));
  return parts.length > 0 ? parts : [''];
}

export function createScriptedQueryFactory(
  programFor: FakeProgram | ((input: QueryFactoryInput, callIndex: number) => FakeProgram),
  options: ScriptedFakeOptions = {},
): ScriptedQueryFactory {
  const partials = options.partials ?? true;
  const sessionId = options.sessionId ?? 'fake-session';
  const usage = options.usage ?? { input_tokens: 11, output_tokens: 7 };
  const calls: ScriptedQueryFactory['calls'] = [];
  const closed: number[] = [];
  const toolResults: ScriptedQueryFactory['toolResults'] = [];

  const factory = ((input: QueryFactoryInput): QueryLike => {
    const index = calls.length;
    calls.push({ index, options: input.options, meta: input.meta });
    const program = typeof programFor === 'function' ? programFor(input, index) : programFor;
    return runProgram(input, program, {
      partials,
      sessionId,
      usage,
      closed,
      index,
      toolResults,
      apiKeySource: options.apiKeySource ?? 'none',
    });
  }) as ScriptedQueryFactory;
  // Read-only views; the arrays are mutated in place.
  Object.defineProperties(factory, {
    calls: { get: () => calls, enumerable: true },
    closed: { get: () => closed, enumerable: true },
    toolResults: { get: () => toolResults, enumerable: true },
  });
  return factory;
}

interface RunState {
  readonly partials: boolean;
  readonly sessionId: string;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly closed: number[];
  readonly index: number;
  readonly toolResults: ScriptedQueryFactory['toolResults'];
  readonly apiKeySource: string;
}

function runProgram(input: QueryFactoryInput, program: FakeProgram, state: RunState): QueryLike {
  const closeSignal = createDeferred<void>();
  let closed = false;
  let toolCounter = 0;

  const pump = createPump(input.prompt);

  // The SDK spawns the CLI through `spawnClaudeCodeProcess`; the fake does the
  // same, so the bridge's process-group teardown path is exercised identically.
  try {
    input.spawn({ command: 'claude', args: [], cwd: input.options.cwd, env: {} });
  } catch {
    // No spawn seam available (e.g. a bare unit test): teardown then has no group.
  }

  const stamp = (message: unknown): SDKMessage =>
    ({ ...(message as object), uuid: `fake-${state.index}-${pump.count}-${Date.now()}`, session_id: state.sessionId }) as SDKMessage;

  const messageStart = (): SDKMessage =>
    stamp({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_fake', role: 'assistant', content: [], model: input.meta.model } },
      parent_tool_use_id: null,
    });

  const textBlockEvents = (text: string): SDKMessage[] => [
    messageStart(),
    stamp({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      parent_tool_use_id: null,
    }),
    ...chunk(text).map(part =>
      stamp({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } },
        parent_tool_use_id: null,
      }),
    ),
    stamp({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      parent_tool_use_id: null,
    }),
    stamp({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: state.usage.output_tokens } },
      parent_tool_use_id: null,
    }),
  ];

  const assistantText = (text: string): SDKMessage =>
    stamp({
      type: 'assistant',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: input.meta.model,
        content: [{ type: 'text', text }],
        stop_reason: null,
        usage: { input_tokens: state.usage.input_tokens, output_tokens: state.usage.output_tokens },
      },
      parent_tool_use_id: null,
    });

  const toolBlockEvents = (toolUseId: string, name: string, argsJson: string): SDKMessage[] => [
    messageStart(),
    stamp({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
      },
      parent_tool_use_id: null,
    }),
    ...chunk(argsJson).map(part =>
      stamp({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } },
        parent_tool_use_id: null,
      }),
    ),
    stamp({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, parent_tool_use_id: null }),
    stamp({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      parent_tool_use_id: null,
    }),
  ];

  const assistantToolUse = (calls: ReadonlyArray<{ toolUseId: string; name: string; argsJson: string }>): SDKMessage =>
    stamp({
      type: 'assistant',
      message: {
        id: 'msg_fake_tools',
        type: 'message',
        role: 'assistant',
        model: input.meta.model,
        content: calls.map(call => ({
          type: 'tool_use',
          id: call.toolUseId,
          name: call.name,
          input: safeParse(call.argsJson),
        })),
        stop_reason: 'tool_use',
        usage: { input_tokens: state.usage.input_tokens, output_tokens: state.usage.output_tokens },
      },
      parent_tool_use_id: null,
    });

  const result = (subtype: string, text: string, extra?: Partial<Record<string, unknown>>): SDKMessage =>
    stamp({
      type: 'result',
      subtype,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: subtype !== 'success',
      num_turns: 1,
      result: text,
      stop_reason: subtype === 'success' ? 'end_turn' : null,
      total_cost_usd: 0,
      usage: { input_tokens: state.usage.input_tokens, output_tokens: state.usage.output_tokens },
      modelUsage: {},
      permission_denials: [],
      ...(subtype === 'success' ? {} : { errors: [text] }),
      ...(extra ?? {}),
    });

  async function* generate(): AsyncGenerator<SDKMessage, void> {
    yield stamp({ ...INIT, apiKeySource: state.apiKeySource } as unknown as SDKMessage);
    // The opening user message that starts this process.
    await pump.waitFor(1, closeSignal.promise);
    if (closed) return;

    let turnIndex = 0;
    let chainText = '';
    let lastResults: Array<{ name: string; toolUseId: string; text: string }> = [];

    while (turnIndex < program.length) {
      // A chain is one prompt's processing: possibly several tool rounds, and
      // exactly ONE result frame at the end (the CLI's per-turn result).
      const chainBegin = turnIndex;
      const chainStart = program[turnIndex] ?? [];
      if (chainStart[0]?.kind === 'await') {
        await pump.waitFor(pump.count + 1, closeSignal.promise);
        if (closed) return;
      }

      while (turnIndex < program.length) {
        const current = program[turnIndex] ?? [];
        if (turnIndex > chainBegin && current[0]?.kind === 'await') break;
        turnIndex += 1;

        let pending: Array<Promise<{ name: string; toolUseId: string; text: string }>> = [];
        let exited = false;

        for (const step of current) {
          switch (step.kind) {
            case 'text': {
              if (state.partials) for (const event of textBlockEvents(step.text)) yield event;
              chainText += step.text;
              yield assistantText(step.text);
              break;
            }
            case 'toolCalls': {
              const dispatched: Array<{ toolUseId: string; name: string; argsJson: string }> = [];
              for (const call of step.calls) {
                toolCounter += 1;
                const toolUseId = call.toolUseId ?? `toolu_fake${toolCounter}`;
                const argsJson = JSON.stringify(call.args ?? {});
                if (state.partials) for (const event of toolBlockEvents(toolUseId, call.name, argsJson)) yield event;
                dispatched.push({ toolUseId, name: call.name, argsJson });
                const mcp = input.mcp;
                pending.push(
                  mcp === undefined
                    ? Promise.reject(new Error('claude-bridge fake: tool call with no MCP server'))
                    : mcp.invoke(call.name, (call.args ?? {}) as Record<string, unknown>, toolUseId).then(result => ({
                        name: call.name,
                        toolUseId,
                        text: result.content?.[0]?.text ?? '',
                      })),
                );
              }
              if (!state.partials) yield assistantToolUse(dispatched);
              break;
            }
            case 'serialToolCalls': {
              const batch = step.calls.map(call => {
                toolCounter += 1;
                return {
                  toolUseId: call.toolUseId ?? `toolu_fake${toolCounter}`,
                  name: call.name,
                  args: (call.args ?? {}) as Record<string, unknown>,
                  argsJson: JSON.stringify(call.args ?? {}),
                };
              });
              if (state.partials) {
                yield messageStart();
                for (const [index, call] of batch.entries()) {
                  yield stamp({
                    type: 'stream_event',
                    event: {
                      type: 'content_block_start',
                      index,
                      content_block: { type: 'tool_use', id: call.toolUseId, name: call.name, input: {} },
                    },
                    parent_tool_use_id: null,
                  });
                  for (const part of chunk(call.argsJson)) {
                    yield stamp({
                      type: 'stream_event',
                      event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } },
                      parent_tool_use_id: null,
                    });
                  }
                  yield stamp({ type: 'stream_event', event: { type: 'content_block_stop', index }, parent_tool_use_id: null });
                }
                yield stamp({
                  type: 'stream_event',
                  event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
                  parent_tool_use_id: null,
                });
              }
              yield assistantToolUse(batch);
              const mcp = input.mcp;
              if (mcp === undefined) throw new Error('claude-bridge fake: tool call with no MCP server');
              const done: Array<{ name: string; toolUseId: string; text: string }> = [];
              for (const call of batch) {
                const answer = mcp.invoke(call.name, call.args, call.toolUseId);
                answer.catch(() => {});
                let settledAnswer: { text: string } | undefined;
                void answer.then(
                  result => {
                    settledAnswer = { text: result.content?.[0]?.text ?? '' };
                  },
                  () => {},
                );
                for (;;) {
                  const tick = new Promise<void>(resolve => setTimeout(resolve, step.heartbeatMs ?? 50));
                  await Promise.race([answer.then(() => undefined, () => undefined), tick, closeSignal.promise]);
                  if (closed) return;
                  // Let the .then above record a just-resolved answer.
                  await Promise.resolve();
                  if (settledAnswer !== undefined) break;
                  yield stamp({
                    type: 'tool_progress',
                    tool_use_id: call.toolUseId,
                    tool_name: call.name,
                    parent_tool_use_id: null,
                    elapsed_time_seconds: 1,
                    heartbeat: true,
                  });
                }
                done.push({ name: call.name, toolUseId: call.toolUseId, text: settledAnswer.text });
              }
              lastResults = done;
              for (const entry of done) state.toolResults.push({ toolUseId: entry.toolUseId, text: entry.text });
              yield assistantToolUse(done.map(entry => ({ toolUseId: entry.toolUseId, name: entry.name, argsJson: '{}' })));
              break;
            }
            case 'toolEcho': {
              const first = lastResults[0];
              const summary =
                first === undefined
                  ? 'no tool result'
                  : `${first.name} -> ${first.text.slice(0, 120).replace(/\s+/g, ' ')}`;
              const text = `FAKE-BRIDGE: ${summary}`;
              if (state.partials) for (const event of textBlockEvents(text)) yield event;
              chainText += text;
              yield assistantText(text);
              break;
            }
            case 'await':
              break;
            case 'assistantError':
              yield stamp({
                type: 'assistant',
                message: { id: 'msg_err', role: 'assistant', content: [] },
                parent_tool_use_id: null,
                error: step.error,
              });
              break;
            case 'authStatus':
              yield stamp({ type: 'auth_status', isAuthenticating: false, output: [], error: step.error });
              break;
            case 'resultError': {
              const extra: Record<string, unknown> = {};
              if (step.errors !== undefined) extra.errors = step.errors;
              if (step.terminalReason !== undefined) extra.terminal_reason = step.terminalReason;
              yield result(step.subtype, step.result ?? '', extra);
              return;
            }
            case 'silent': {
              await closeSignal.promise;
              return;
            }
            case 'throw':
              throw new Error(step.message);
            case 'exit':
              exited = true;
              break;
            default:
              break;
          }
          if (exited) return;
        }

        if (pending.length > 0) {
          // The CLI is blocked inside the MCP handlers from here until Hermes
          // answers through the bridge.
          const resolved = await Promise.race([Promise.all(pending), closeSignal.promise.then(() => undefined)]);
          if (resolved === undefined) {
            closed = true;
            return;
          }
          lastResults = resolved;
          for (const entry of resolved) {
            state.toolResults.push({ toolUseId: entry.toolUseId, text: entry.text });
          }
          yield assistantToolUse(
            resolved.map(entry => ({ toolUseId: entry.toolUseId, name: entry.name, argsJson: '{}' })),
          );
          pending = [];
        }
      }

      yield result('success', chainText);
      chainText = '';
    }

    // Stay open like the real streaming-input CLI.
    await closeSignal.promise;
    closed = true;
  }

  const iterator = generate();
  function close(): void {
    if (!closed) state.closed.push(state.index);
    closed = true;
    closeSignal.resolve();
  }

  const query: QueryLike = {
    next: () => iterator.next(),
    return: async (value?: void) => {
      close();
      return { value: value as never, done: true };
    },
    throw: async (error?: unknown) => iterator.throw(error),
    [Symbol.asyncIterator]() {
      return this;
    },
    close,
  } as QueryLike;

  return query;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Consumes the prompt iterable the way the SDK would, so tests can gate turns. */
function createPump(prompt: AsyncIterable<SDKUserMessage>) {
  const state = { count: 0 };
  const waiters: Array<{ at: number; deferred: Deferred<void> }> = [];
  void (async () => {
    try {
      for await (const _message of prompt) {
        state.count += 1;
        for (const waiter of [...waiters]) {
          if (state.count >= waiter.at) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.deferred.resolve();
          }
        }
      }
    } catch {
      // prompt closed
    }
    for (const waiter of [...waiters]) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.deferred.resolve();
    }
  })();

  return {
    get count() {
      return state.count;
    },
    async waitFor(count: number, onClose: Promise<unknown>): Promise<void> {
      if (state.count >= count) return;
      const deferred = createDeferred<void>();
      waiters.push({ at: count, deferred });
      await Promise.race([deferred.promise, onClose]);
    },
  };
}

// ---------------------------------------------------------------------------
// `--fake` policy: a cooperative pseudo-model
// ---------------------------------------------------------------------------

export interface FakeToolSpec {
  readonly mcpName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function defaultArgs(schema: Record<string, unknown>): Record<string, unknown> {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const args: Record<string, unknown> = {};
  for (const name of required) {
    if (typeof name !== 'string') continue;
    const property = properties[name] ?? {};
    switch (property.type) {
      case 'number':
      case 'integer':
        args[name] = 1;
        break;
      case 'boolean':
        args[name] = true;
        break;
      case 'array':
        args[name] = [];
        break;
      case 'object':
        args[name] = {};
        break;
      default:
        args[name] = 'claude-bridge';
        break;
    }
  }
  return args;
}

/** Tools that are safe, argument-free and side-effect-free, in preference order. */
const PREFERRED_FAKE_TOOLS = [
  'todo_list',
  'skills_list',
  'memory',
  'session_search',
  'get_time',
  'read_file',
  'web_search',
];

export function pickFakeTool(tools: readonly FakeToolSpec[]): FakeToolSpec | undefined {
  for (const preferred of PREFERRED_FAKE_TOOLS) {
    const match = tools.find(tool => tool.mcpName === preferred || tool.mcpName.endsWith(`__${preferred}`));
    if (match !== undefined) return match;
  }
  const noRequired = tools.find(tool => {
    const required = tool.inputSchema.required;
    return !Array.isArray(required) || required.length === 0;
  });
  return (
    noRequired ??
    tools.find(tool => /time|date|echo|health|ping|status/i.test(tool.mcpName)) ??
    tools[0]
  );
}

/**
 * The `--fake` program: every new prompt does one real tool round trip through
 * the bridge, then answers with the tool's own output.
 */
export function buildFakePolicyProgram(tools: readonly FakeToolSpec[], cycles = 6): FakeProgram {
  if (tools.length === 0) {
    return [[{ kind: 'text', text: 'FAKE-AUX: claude-bridge auxiliary response.' }]];
  }
  const tool = pickFakeTool(tools);
  if (tool === undefined) return [[{ kind: 'text', text: 'FAKE-BRIDGE: no tools offered.' }]];
  const program: FakeStep[][] = [];
  for (let i = 0; i < cycles; i += 1) {
    program.push([
      ...(i === 0 ? [] : ([{ kind: 'await' }] as FakeStep[])),
      { kind: 'toolCalls', calls: [{ name: tool.mcpName, args: defaultArgs(tool.inputSchema) }] },
    ]);
    program.push([{ kind: 'toolEcho' }]);
  }
  program.push([{ kind: 'await' }, { kind: 'text', text: 'FAKE-BRIDGE: done.' }]);
  return program;
}

/** A spawner that records group kills without ever signalling a real process. */
export function createRecordingSpawner(clock: Clock, killGraceMs: number): GroupSpawner {
  let nextPid = 900000;
  const spawnChild = (): ChildLike => {
    nextPid += 1;
    const listeners = new Map<string, Array<(...args: never[]) => void>>();
    const child = {
      pid: nextPid,
      stdin: null,
      stdout: null,
      // A real child gets a piped stderr the bridge drains (src/spawn.ts).
      stderr: new PassThrough(),
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(): boolean {
        (child as { killed: boolean }).killed = true;
        return true;
      },
      on(event: string, listener: (...args: never[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return child;
      },
      once(event: string, listener: (...args: never[]) => void) {
        return child.on(event, listener);
      },
      off(event: string, listener: (...args: never[]) => void) {
        const list = listeners.get(event) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
        return child;
      },
    };
    return child as unknown as ChildLike;
  };
  const killGroup: GroupKill = () => true;
  return new GroupSpawner({ clock, killGraceMs, spawnChild, killGroup });
}

export type { SpawnRecord, SpawnedGroupChild };
