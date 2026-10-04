/**
 * One Chat Completions request -> one Claude turn.
 *
 * The mapping is SPEC.md §"How one request maps onto Claude":
 *   system messages      -> Options.systemPrompt (replaces Claude Code's prompt)
 *   tools                -> the in-process `hermes` MCP server
 *   history              -> rendered text (history renderer), trailing user run live
 *   tool calls           -> minted `call_<...>` ids, parked, finish_reason tool_calls
 *   trailing tool results-> un-park exactly those calls, same process, stream on
 *   a result batch that is not exactly the parked id set
 *                        -> refused (409) and never a cold start: the parked
 *                           call keeps its deadline and fails as parked-timeout
 *   no live match        -> cold start
 *   no tools (aux)       -> cold one-shot, maxTurns 1, no MCP server
 */

import { randomBytes } from 'node:crypto';

import type { Clock, TimerHandle } from './clock.js';
import type { BridgeConfig } from './config.js';
import {
  hashSystem,
  isContinuation,
  messagesPrefixHash,
  systemTextOf,
  trailingToolResults,
} from './conversation.js';
import {
  BridgeError,
  asBridgeError,
  badRequestError,
  notConfiguredError,
  partialToolResultsError,
  requestTimeoutError,
  unknownModelError,
} from './errors.js';
import { composeOpeningPrompt, renderConversation } from './history.js';
import type { Logger } from './log.js';
import { EFFORT_LEVELS, readRequestEffort } from './effort.js';
import { sdkModelFor } from './models.js';
import {
  chunkEnvelope,
  newCompletionId,
  type OpenAiChatRequest,
  type OpenAiChunk,
  type OpenAiCompletion,
  type OpenAiUsage,
} from './openai-types.js';
import type { ProcessPool } from './pool.js';
import { ClaudeProcess, type ProcessDeps, type TurnOutcome, type TurnSink } from './process.js';
import { ToolMirror } from './tool-mirror.js';

/** Used when Hermes sends no system message: never Claude Code's own prompt. */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a model answering through a local bridge. Answer the user directly and concisely. ' +
  'If a tool is offered and needed, call it; the caller runs tools, not you.';

export interface ChatSink {
  readonly streaming: boolean;
  /** Streaming mode: one `chat.completion.chunk`. */
  sendChunk(chunk: OpenAiChunk): void;
  /** Non-streaming mode: the whole completion. */
  sendCompletion(completion: OpenAiCompletion): void;
  /** Streaming mode: the terminal `data: [DONE]` frame. */
  sendDone(): void;
  /** Any failure; the sink decides between an HTTP error and an in-stream error frame. */
  sendError(error: BridgeError): void;
  clientGone(): boolean;
  onClose(callback: () => void): void;
}

export interface HandlerDeps {
  readonly config: BridgeConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly pool: ProcessPool;
  readonly processDeps: ProcessDeps;
  readonly requestId: string;
  /** False when no official claude binary was resolvable (real mode only). */
  readonly claudeAvailable: boolean;
}

function zeroUsage(): OpenAiUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** Collects the turn while streaming it to the client. */
class StreamingTurnSink implements TurnSink {
  text = '';
  gone = false;
  completionId = '';
  created = 0;
  model = '';

  constructor(private readonly sink: ChatSink) {}

  textDelta(text: string): void {
    this.text += text;
    if (!this.sink.streaming) return;
    this.sink.sendChunk(
      chunkEnvelope({
        id: this.completionId,
        created: this.created,
        model: this.model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }),
    );
  }

  toolCallStart(slot: { index: number; callId: string; name: string }): void {
    if (!this.sink.streaming) return;
    this.sink.sendChunk(
      chunkEnvelope({
        id: this.completionId,
        created: this.created,
        model: this.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: slot.index,
                  id: slot.callId,
                  type: 'function',
                  function: { name: slot.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  toolCallArgs(index: number, deltaJson: string): void {
    if (!this.sink.streaming) return;
    this.sink.sendChunk(
      chunkEnvelope({
        id: this.completionId,
        created: this.created,
        model: this.model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: deltaJson } }] },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  clientGone(): boolean {
    return this.gone || this.sink.clientGone();
  }
}

export async function handleChatCompletions(
  request: OpenAiChatRequest,
  sink: ChatSink,
  deps: HandlerDeps,
): Promise<void> {
  const startedAt = deps.clock.now();
  const completionId = newCompletionId(randomBytes(12).toString('hex'));
  const created = Math.floor(startedAt / 1000);
  let wallClock: TimerHandle | undefined;
  let process: ClaudeProcess | undefined;
  let disconnected = false;
  let model: { exposedId: string; sdkModel: string } = {
    exposedId: deps.config.auxModel,
    sdkModel: deps.config.auxModel,
  };
  /** A disconnect may land while the process is still being created. */
  const adopt = (created: ClaudeProcess): ClaudeProcess => {
    process = created;
    if (disconnected) created.onClientGone();
    return created;
  };

  try {
    const messages = request.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw badRequestError('claude-bridge: "messages" must be a non-empty array');
    }
    if (!deps.claudeAvailable) {
      throw notConfiguredError(
        'claude-bridge: no official claude binary found on PATH (set CLAUDE_BRIDGE_CLAUDE_PATH, or install claude)',
      );
    }

    const requestedModel = typeof request.model === 'string' ? request.model : '';
    const mirror = new ToolMirror(request.tools ?? []);
    const hasTools = mirror.size > 0;
    model = resolveModel(requestedModel, hasTools, deps.config);
    const requestedEffort = readRequestEffort(request);
    if (requestedEffort.kind === 'invalid') {
      throw badRequestError(
        `claude-bridge: "reasoning.effort" / "reasoning_effort" must be one of ${EFFORT_LEVELS.join(', ')} (or none, minimal)`,
      );
    }
    const effort =
      requestedEffort.kind === 'level'
        ? requestedEffort.level
        : (deps.config.modelEfforts[model.exposedId] ?? deps.config.defaultEffort);

    const wire = new StreamingTurnSink(sink);
    wire.completionId = completionId;
    wire.created = created;
    wire.model = model.exposedId;

    // Per-request wall clock (SPEC.md: 20 min default).
    wallClock = deps.clock.setTimeout(() => {
      process?.abortTurn(requestTimeoutError());
    }, deps.config.requestWallClockMs);
    sink.onClose(() => {
      wire.gone = true;
      disconnected = true;
      process?.onClientGone();
    });

    const systemText = systemTextOf(messages);
    const rendered = renderConversation(messages, mirror);
    const messageHash = messagesPrefixHash(messages, messages.length);
    let outcome: TurnOutcome | undefined;

    if (hasTools) {
      const trailing = trailingToolResults(messages);
      if (trailing.length > 0) {
        const lookup = deps.pool.lookupForResults(trailing.map(result => result.id));
        if (lookup.kind === 'found') {
          process = adopt(lookup.process);
          deps.logger.log('resume_parked', {
            requestId: deps.requestId,
            procId: process.id,
            count: trailing.length,
            parkedCount: process.parkedCount,
          });
          outcome = await process.resumeTurn(trailing, wire);
        } else if (lookup.kind === 'partial') {
          // SPEC.md: "all ids of one assistant turn must come back before you
          // resume; a missing one after the timeout = failure, not a guess".
          // The batch must match the turn's parked ids EXACTLY — a repeat, a
          // subset, an extra unknown id or ids from two parked turns are all
          // mismatches — so it is refused as it stands: never a resume, never a
          // cold start, and the parked process is left holding its calls with
          // its own deadline running (a 500 here would have torn it down).
          deps.logger.log('partial_tool_results_refused', {
            requestId: deps.requestId,
            procId: lookup.process.id,
            count: trailing.length,
            parkedCount: lookup.process.parkedCount,
          });
          throw partialToolResultsError(trailing.length, lookup.process.parkedCount);
        }
      }
      if (process === undefined) {
        const systemHash = hashSystem(systemText);
        const continuation = deps.pool.lookupForContinuation(candidate => {
          if (candidate.systemHash !== systemHash) return false;
          if (candidate.toolFingerprint !== mirror.fingerprint) return false;
          const served = candidate.servedMessages;
          return isContinuation(messages, served.length, served.hash);
        });
        if (continuation !== undefined && rendered.liveText.length > 0) {
          process = adopt(continuation);
          deps.logger.log('continue_conversation', { requestId: deps.requestId, procId: process.id });
          outcome = await process.continueTurn(rendered.liveText, rendered.images, wire);
        }
      }
    }

    if (process === undefined) {
      const isAux = !hasTools;
      deps.logger.log('cold_start', {
        requestId: deps.requestId,
        kind: isAux ? 'aux' : 'conversation',
        model: model.exposedId,
        effort,
        toolCount: mirror.size,
        messageCount: messages.length,
      });
      process = adopt(await deps.pool.create(
        {
          kind: isAux ? 'aux' : 'conversation',
          sdkModel: model.sdkModel,
          effort,
          systemPrompt: systemText.length > 0 ? systemText : DEFAULT_SYSTEM_PROMPT,
          systemHash: hashSystem(systemText),
          mirror,
          correlationKey: isAux ? undefined : `${hashSystem(systemText)}:${mirror.fingerprint}`,
          openingPrompt: composeOpeningPrompt(rendered),
          images: rendered.images,
          maxTurns: isAux ? 1 : deps.config.maxTurns,
          deps: deps.processDeps,
        },
        wire,
      ));
      outcome = await process.firstTurn;
    }

    wallClock.cancel();
    wallClock = undefined;

    const result = outcome ?? {
      kind: 'abandoned' as const,
      text: '',
      toolCalls: [],
      usage: zeroUsage(),
      finishReason: 'stop',
    };
    if (result.kind === 'abandoned') {
      deps.logger.log('request_abandoned', {
        requestId: deps.requestId,
        procId: process.id,
        ms: deps.clock.now() - startedAt,
      });
      return;
    }

    // Remember the exact message list this process served, for continuations.
    process.recordServedMessages(messages.length, messageHash);

    emitResult(result, sink, { completionId, created, model: model.exposedId });

    deps.logger.log('request_ok', {
      requestId: deps.requestId,
      procId: process.id,
      model: model.exposedId,
      effort,
      outcome: result.kind,
      count: result.toolCalls.length,
      ms: deps.clock.now() - startedAt,
      stream: sink.streaming,
    });

    // Aux turns are one-shot; conversations stay warm for the next user turn.
    if (process.kind === 'aux') await deps.pool.release(process);
  } catch (error) {
    const bridgeError = asBridgeError(error);
    deps.logger.log('request_failed', {
      requestId: deps.requestId,
      code: bridgeError.code,
      status: bridgeError.status,
      ms: deps.clock.now() - startedAt,
    });
    if (process !== undefined) {
      deps.pool.forget(process);
      void process.dispose('request-failed');
    }
    sink.sendError(bridgeError);
  } finally {
    wallClock?.cancel();
  }
}

function resolveModel(
  requestedModel: string,
  hasTools: boolean,
  config: BridgeConfig,
): { exposedId: string; sdkModel: string } {
  const sdk = sdkModelFor(requestedModel);
  if (sdk !== undefined) return { exposedId: requestedModel, sdkModel: sdk };
  // Main requests must name an exposed model; auxiliaries fall back (SPEC.md).
  if (hasTools) throw unknownModelError(requestedModel, config.exposedModels);
  return { exposedId: config.auxModel, sdkModel: sdkModelFor(config.auxModel) ?? config.auxModel };
}

function emitResult(
  result: TurnOutcome,
  sink: ChatSink,
  context: { completionId: string; created: number; model: string },
): void {
  const { completionId, created, model } = context;
  const usage = result.usage ?? zeroUsage();

  if (!sink.streaming) {
    const completion: OpenAiCompletion = {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.text,
            ...(result.toolCalls.length > 0
              ? {
                  tool_calls: result.toolCalls.map(call => ({
                    id: call.callId,
                    type: 'function' as const,
                    function: { name: call.name, arguments: call.argumentsJson },
                  })),
                }
              : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage,
    };
    sink.sendCompletion(completion);
    return;
  }

  // Terminal choice chunk: Hermes needs a non-null finish_reason here
  // (docs/HERMES-CLIENT-FACTS.md §3.4) or it treats the stream as truncated.
  sink.sendChunk(
    chunkEnvelope({
      id: completionId,
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
    }),
  );
  // Choiceless usage chunk (§3.6/§3.7), then the sentinel (§3.2).
  sink.sendChunk(chunkEnvelope({ id: completionId, created, model, choices: [], usage }));
  sink.sendDone();
}
