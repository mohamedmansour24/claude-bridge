/**
 * One Claude process.
 *
 * Owns: a private empty cwd (mode 0700), the Agent SDK `query()` call, the
 * in-process MCP server carrying Hermes' tools, the turn state machine, the
 * stall watchdog, the parked-call timers, and teardown (process GROUP kill +
 * temp-dir removal).
 *
 * Invariants enforced here:
 *  - 1/2 (SPEC.md): nothing is read from disk except the temp dir; no model API
 *    is called directly — the only route to Claude is `query()` spawning the CLI.
 *  - 2: `tools: []`, `settingSources: []`, `strictMcpConfig: true`,
 *    `canUseTool` denies everything but `mcp__hermes__*`, `permissionMode`
 *    stays 'default', `cwd` is the private temp dir.
 *  - 4: logs carry ids/counts/durations/model names/outcome codes only, and the
 *    CLI's own stderr never becomes bridge output (see `stderr` in buildOptions
 *    and `GroupSpawner.drainStderr`).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, chmod, rm, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

import type { EffortLevel, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Clock, TimerHandle } from './clock.js';
import { sleepOn } from './clock.js';
import type { BridgeConfig } from './config.js';
import { createDeferred, type Deferred } from './deferred.js';
import {
  BridgeError,
  asBridgeError,
  badRequestError,
  cliExitError,
  internalError,
  maxTurnsError,
  notSignedInError,
  overflowError,
  parkedTimeoutError,
  stallError,
  toolDeniedError,
} from './errors.js';
import type { RenderedImage } from './history.js';
import type { Logger } from './log.js';
import type { CallToolResultLike, McpServerFactory, McpServerHandle } from './mcp.js';
import { MCP_SERVER_NAME, ToolMirror } from './tool-mirror.js';
import type { OpenAiUsage } from './openai-types.js';
import { ParkedCalls, TurnSlots, type CallSlot, type ToolResultPayload } from './parked.js';
import type { GroupSpawner, SpawnedGroupChild } from './spawn.js';

// ---------------------------------------------------------------------------
// SDK surface (kept small and structural so the real SDK and a scripted fake
// are interchangeable; see docs/SDK-FACTS.md §1).
// ---------------------------------------------------------------------------

export type QueryLike = AsyncGenerator<SDKMessage, void> & { close?: () => void };

export interface QueryFactoryInput {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
  /** The bridge's own MCP server, when this process carries tools. */
  readonly mcp: McpServerHandle | undefined;
  /** Same spawn seam the SDK uses; scripted fakes call it to own a real group. */
  readonly spawn: (options: { command: string; args: readonly string[]; cwd?: string; env: Record<string, string | undefined> }) => SpawnedGroupChild;
  /** Process metadata (no request content) available to scripted fakes. */
  readonly meta: {
    readonly kind: ProcessKind;
    readonly model: string;
    readonly tools: readonly { mcpName: string; description: string; inputSchema: Record<string, unknown> }[];
    readonly openingPrompt: string;
  };
}

export type QueryFactory = (input: QueryFactoryInput) => QueryLike;

export type ProcessKind = 'conversation' | 'aux';

export interface ProcessDeps {
  readonly queryFn: QueryFactory;
  readonly mcpFactory: McpServerFactory;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: BridgeConfig;
  readonly spawner: GroupSpawner;
}

export interface ProcessInit {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly sdkModel: string;
  /** Effective reasoning effort passed to the SDK as `Options.effort`. */
  readonly effort: EffortLevel;
  readonly systemPrompt: string;
  readonly mirror: ToolMirror;
  /** Hash of the system prompt, part of the continuation key. */
  readonly systemHash: string;
  /** Stable hash identifying the conversation this process serves (undefined for aux). */
  readonly correlationKey: string | undefined;
  readonly openingPrompt: string;
  readonly images: readonly RenderedImage[];
  readonly maxTurns: number;
  readonly deps: ProcessDeps;
}

// ---------------------------------------------------------------------------
// Turn plumbing
// ---------------------------------------------------------------------------

export interface ToolCallOutcome {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly index: number;
}

export interface TurnOutcome {
  readonly kind: 'text' | 'tool_calls' | 'abandoned';
  readonly text: string;
  readonly toolCalls: readonly ToolCallOutcome[];
  readonly usage: OpenAiUsage;
  readonly finishReason: string;
}

/** Incremental events for the streaming client. */
export interface TurnSink {
  textDelta(text: string): void;
  toolCallStart(slot: { index: number; callId: string; name: string }): void;
  toolCallArgs(index: number, deltaJson: string): void;
  clientGone(): boolean;
}

export const noopSink: TurnSink = {
  textDelta: () => {},
  toolCallStart: () => {},
  toolCallArgs: () => {},
  clientGone: () => false,
};

interface ActiveTurn {
  readonly sink: TurnSink;
  readonly deferred: Deferred<TurnOutcome>;
  readonly slots: TurnSlots;
  readonly blockIndexToSlot: Map<number, CallSlot>;
  sawPartials: boolean;
  text: string;
  textFromAssistant: string;
  settled: boolean;
  lastStopReason: string | null;
  assistantError: string | undefined;
}

export class DisposedError extends Error {
  constructor(reason: string) {
    super(`claude-bridge: process disposed (${reason})`);
    this.name = 'DisposedError';
  }
}

const AUTH_PATTERN =
  /not logged in|please run \/login|please login|oauth token (?:expired|revoked)|401 unauthorized|authentication failed|invalid api key|oauth_org_not_allowed/i;
const OVERFLOW_PATTERN =
  /\bprompt is too long\b|\binput length and `?max_tokens`? exceed\b|context length exceeded|maximum context length|too many tokens|exceeds the max_model_len/i;

/** Explicit authentication evidence (docs/REFERENCE-NOTES.md §6). */
export function hasAuthEvidence(text: string | undefined): boolean {
  return text !== undefined && AUTH_PATTERN.test(text);
}

/** Explicit context-overflow evidence (docs/REFERENCE-NOTES.md §6). */
export function hasOverflowEvidence(text: string | undefined): boolean {
  return text !== undefined && OVERFLOW_PATTERN.test(text);
}

export function classifyFailureText(text: string | undefined, fallback: string): BridgeError {
  if (hasAuthEvidence(text)) return notSignedInError();
  if (hasOverflowEvidence(text)) return overflowError();
  return cliExitError(fallback);
}

/** SDK usage -> OpenAI usage. Derived only from real fields; zeros otherwise. */
export function mapUsage(usage: unknown): OpenAiUsage {
  const record = (usage ?? {}) as Record<string, unknown>;
  const num = (key: string): number => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const prompt = num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens');
  const completion = num('output_tokens');
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function finishReasonFor(stopReason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'refusal') return 'content_filter';
  return 'stop';
}

/** Text the CLI needs dropped from its environment for an unambiguous own-login. */
const DROPPED_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const CLAUDE_ENV_PASSTHROUGH = new Set(['CLAUDE_CONFIG_DIR']);

export function scrubEnv(
  env: Record<string, string | undefined>,
  extras: Record<string, string>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('CLAUDE_') && !CLAUDE_ENV_PASSTHROUGH.has(upper)) continue;
    if (DROPPED_ENV.has(upper)) continue;
    out[key] = value;
  }
  return { ...out, ...extras };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Prompt feed
// ---------------------------------------------------------------------------

/**
 * The SDK gets an AsyncIterable of user messages. It stays open for the life of
 * the process: the bridge never pushes a second user message (a new user turn
 * cold-starts a new process, SPEC.md §"How one request maps onto Claude"), and
 * tool results reach Claude by un-parking the MCP call instead.
 */
class PromptFeed implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter: Deferred<IteratorResult<SDKUserMessage>> | undefined;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        const waiter = createDeferred<IteratorResult<SDKUserMessage>>();
        this.waiter = waiter;
        return waiter.promise;
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export function sdkUserMessage(text: string, images: readonly RenderedImage[]): SDKUserMessage {
  const content: unknown[] = [{ type: 'text', text }];
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 },
    });
  }
  return {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

// ---------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------

export type ProcessState = 'running' | 'parked' | 'idle' | 'disposed';

export class ClaudeProcess {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly sdkModel: string;
  readonly correlationKey: string | undefined;
  readonly tempDir: string;
  readonly systemHash: string;
  readonly toolFingerprint: string;

  private readonly deps: ProcessDeps;
  private readonly mirror: ToolMirror;
  private readonly parked = new ParkedCalls();
  private readonly parkedSince = new Map<string, number>();
  private readonly parkedTimers = new Map<string, TimerHandle>();
  private readonly feed = new PromptFeed();
  private readonly controller = new AbortController();

  private query: QueryLike | undefined;
  private mcpServer: McpServerHandle | undefined;
  private child: SpawnedGroupChild | undefined;
  private turn: ActiveTurn | undefined;
  private stallTimer: TimerHandle | undefined;
  private settleTimer: TimerHandle | undefined;
  private stateValue: ProcessState = 'idle';
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private tempDirRemoved = false;
  private lastActivityAt: number;
  private turnNumber = 0;
  private servedMessagesLength = 0;
  private servedMessagesHash = '';
  /**
   * Claude tool-use ids already emitted to Hermes, with the turn number that
   * emitted them. The CLI replays a turn's assistant message after its tool
   * results resolve, and a resume must never re-emit those tool_calls.
   */
  private readonly emittedBlocks = new Map<string, number>();
  private readonly blockWaiters = new Set<Deferred<void>>();
  /**
   * Calls emitted to Hermes whose MCP handler the CLI had NOT dispatched when
   * the turn settled, keyed by Claude tool-use id. The CLI runs non-read-only
   * MCP tools one at a time, so in a parallel batch only the first handler is
   * live; the rest arrive after the earlier ones return. Each entry is a parked
   * call (Hermes answers it like any other); when the CLI finally dispatches
   * it, the handler returns this pre-supplied answer instead of parking again.
   */
  private readonly queuedCalls = new Map<string, { mcpName: string; promise: Promise<ToolResultPayload> }>();

  private constructor(init: ProcessInit, tempDir: string) {
    this.id = init.id;
    this.kind = init.kind;
    this.sdkModel = init.sdkModel;
    this.correlationKey = init.correlationKey;
    this.tempDir = tempDir;
    this.deps = init.deps;
    this.mirror = init.mirror;
    this.systemHash = init.systemHash;
    this.toolFingerprint = init.mirror.fingerprint;
    this.lastActivityAt = init.deps.clock.now();
  }

  static async create(init: ProcessInit, sink: TurnSink): Promise<ClaudeProcess> {
    const tempDir = await createPrivateTempDir(init.deps.config.tempBase);
    const process = new ClaudeProcess(init, tempDir);
    try {
      process.armTurn(sink);
      process.start(init);
    } catch (error) {
      await process.dispose('start-failure');
      throw asBridgeError(error);
    }
    return process;
  }

  // -- public surface -------------------------------------------------------

  get state(): ProcessState {
    return this.stateValue;
  }

  get parkedCount(): number {
    return this.parked.size;
  }

  get parkedCallIds(): readonly string[] {
    return this.parked.ids();
  }

  get busy(): boolean {
    return this.stateValue === 'running' || this.stateValue === 'parked';
  }

  hasParkedCall(callId: string): boolean {
    return this.parked.has(callId);
  }

  /** The (length, hash) of the message list this process last served. */
  get servedMessages(): { length: number; hash: string } {
    return { length: this.servedMessagesLength, hash: this.servedMessagesHash };
  }

  recordServedMessages(length: number, hash: string): void {
    this.servedMessagesLength = length;
    this.servedMessagesHash = hash;
  }

  /**
   * Feed a NEW user turn into the SAME process (streaming input mode). Only the
   * new live text is pushed: the process already holds the prior conversation.
   */
  async continueTurn(
    liveText: string,
    images: readonly RenderedImage[],
    sink: TurnSink,
  ): Promise<TurnOutcome> {
    if (this.disposed) throw new DisposedError('continue-after-dispose');
    if (this.parked.size > 0) throw internalError('claude-bridge: the process still holds parked calls');
    const turn = this.turn;
    if (turn !== undefined && !turn.settled) throw internalError('claude-bridge: the process already has a live turn');
    this.armTurn(sink);
    this.stateValue = 'running';
    this.feed.push(sdkUserMessage(liveText, images));
    this.rearmStall();
    return await this.currentTurn();
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  get childPid(): number | undefined {
    return this.child?.pid;
  }

  get tempDirExists(): boolean {
    return !this.tempDirRemoved;
  }

  get turnCount(): number {
    return this.turnNumber;
  }

  /**
   * Un-park exactly the listed calls with Hermes' results and continue the same
   * process. Rejects (never guesses) on unknown ids, partial groups or expired
   * parked calls.
   */
  async resumeTurn(
    results: ReadonlyArray<{ id: string; payload: ToolResultPayload }>,
    sink: TurnSink,
  ): Promise<TurnOutcome> {
    if (this.disposed) throw new DisposedError('resume-after-dispose');
    if (this.turn !== undefined && !this.turn.settled) {
      throw internalError('claude-bridge: the process already has a live turn');
    }
    const ids = results.map(result => result.id);
    if (ids.length === 0) throw internalError('claude-bridge: resume with no tool results');
    // All-or-nothing: a partial group must never be resumed (SPEC.md).
    if (new Set(ids).size !== ids.length) throw internalError('claude-bridge: duplicate tool_call_id in resume');
    if (!this.parked.hasAll(ids)) throw internalError('claude-bridge: resume asked for calls this process is not holding');
    if (this.parked.size !== ids.length) throw internalError('claude-bridge: partial resume refused');

    const now = this.deps.clock.now();
    for (const id of ids) {
      const since = this.parkedSince.get(id);
      if (since !== undefined && now - since >= this.deps.config.parkedCallTimeoutMs) {
        const error = parkedTimeoutError();
        this.failParked(error);
        await this.dispose('parked-timeout');
        throw error;
      }
    }

    this.armTurn(sink);
    const { unknown } = this.parked.resolveMany(results);
    if (unknown.length > 0) throw internalError('claude-bridge: partial resume refused');
    for (const { id } of results) {
      this.parkedTimers.get(id)?.cancel();
      this.parkedTimers.delete(id);
      this.parkedSince.delete(id);
    }
    this.stateValue = 'running';
    return await this.currentTurn();
  }

  /** The client went away mid-stream. */
  onClientGone(): void {
    this.abandonLiveTurn();
    this.cancelTurnTimers();
    if (this.parked.size === 0) {
      void this.dispose('client-disconnect');
    } else {
      // Parked calls are Hermes' to answer; the process must survive the drop.
      this.stateValue = 'parked';
    }
  }

  /**
   * The promise for the turn this process is currently serving (its opening
   * turn right after creation, or the resumed turn).
   */
  get firstTurn(): Promise<TurnOutcome> {
    return this.currentTurn();
  }

  /** Resolve a live turn as abandoned (disconnect / teardown). */
  private abandonLiveTurn(): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;
    turn.settled = true;
    const outcome: TurnOutcome = {
      kind: 'abandoned',
      text: turn.text,
      toolCalls: [],
      usage: zeroUsage(),
      finishReason: 'stop',
    };
    turn.deferred.promise.catch(() => {});
    turn.deferred.resolve(outcome);
  }

  /** Spawn through the shared seam and remember the child for group teardown. */
  private spawnChild(spawnOptions: {
    command: string;
    args: readonly string[];
    cwd?: string | undefined;
    env: Record<string, string | undefined>;
  }): SpawnedGroupChild {
    const child = this.deps.spawner.spawn(spawnOptions);
    this.child = child;
    return child;
  }

  /** Fail the live turn with a specific error and tear the process down. */
  abortTurn(error: BridgeError): void {
    this.failTurn(error, { dispose: true });
  }

  /** Reject every parked call and tear the process down. Idempotent. */
  async dispose(reason: string): Promise<void> {
    if (this.disposePromise !== undefined) return await this.disposePromise;
    this.disposePromise = this.disposeInner(reason);
    return await this.disposePromise;
  }

  private async disposeInner(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stateValue = 'disposed';
    this.cancelTimers();
    this.abandonLiveTurn();
    const error = new DisposedError(reason);
    this.parked.rejectAll(error);
    this.parkedSince.clear();
    this.queuedCalls.clear();
    try {
      this.query?.close?.();
    } catch {
      // closing an already-dead transport is not an error
    }
    this.feed.close();
    try {
      this.controller.abort();
    } catch {
      // ignore
    }
    this.child?.terminate();
    this.child = undefined;
    await this.removeTempDir();
    this.deps.logger.log('process_disposed', { procId: this.id, kind: this.kind, code: reason });
  }

  // -- internals: lifecycle -------------------------------------------------

  private start(init: ProcessInit): void {
    const options = this.buildOptions(init);
    this.query = this.deps.queryFn({
      prompt: this.feed,
      options,
      mcp: this.mcpServer,
      spawn: spawnOptions => this.spawnChild(spawnOptions),
      meta: {
        kind: init.kind,
        model: init.sdkModel,
        tools: init.mirror.tools.map(tool => ({
          mcpName: tool.mcpName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        openingPrompt: init.openingPrompt,
      },
    });
    this.stateValue = 'running';
    void this.consume();
    this.feed.push(sdkUserMessage(init.openingPrompt, init.images));
    this.rearmStall();
    this.deps.logger.log('process_started', {
      procId: this.id,
      kind: init.kind,
      model: init.sdkModel,
      effort: init.effort,
      toolCount: init.mirror.size,
      procCount: 1,
    });
  }

  private buildOptions(init: ProcessInit): Options {
    const controller = this.controller;
    const mcpServer = init.mirror.size > 0
      ? this.deps.mcpFactory({
          serverName: MCP_SERVER_NAME,
          tools: init.mirror.tools.map(tool => ({
            name: tool.mcpName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          onCall: (name, args, toolUseId) => this.onToolCall(name, args, toolUseId),
        })
      : undefined;
    this.mcpServer = mcpServer;

    const aliases: Record<string, string> = {};
    for (const tool of init.mirror.tools) aliases[tool.mcpName] = tool.visibleName;

    const env = scrubEnv(process.env, {
      // In-process MCP tool calls have no per-server timeout field; the env var
      // is the only bound (docs/SDK-FACTS.md §4).
      MCP_TOOL_TIMEOUT: String(this.deps.config.parkedCallTimeoutMs),
    });

    const options: Options = {
      abortController: controller,
      cwd: this.tempDir,
      tools: [],
      mcpServers: mcpServer === undefined ? {} : { [MCP_SERVER_NAME]: mcpServer.config as never },
      toolAliases: aliases,
      systemPrompt: init.systemPrompt,
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      persistSession: false,
      maxTurns: init.maxTurns,
      permissionMode: 'default',
      model: init.sdkModel,
      effort: init.effort,
      env,
      canUseTool: async (toolName: string) =>
        toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)
          ? { behavior: 'allow' as const }
          : {
              behavior: 'deny' as const,
              message: 'Only hermes-bridged tools are available in this session.',
            },
      onElicitation: (async () => ({ action: 'decline' as const })) as unknown as Options['onElicitation'],
      onUserDialog: (async () => ({ behavior: 'cancelled' as const })) as unknown as Options['onUserDialog'],
      // SPEC.md invariant 4: CLI stderr is never forwarded into this process's
      // console or log. The custom spawn below pipes stderr into
      // GroupSpawner.drainStderr, which counts the bytes and discards them; this
      // callback covers the SDK's own spawn path (docs/SDK-FACTS.md §2.6,
      // sdk.d.ts:2055) and drops the data the same way.
      stderr: () => {},
      spawnClaudeCodeProcess: ((spawnOptions: {
        command: string;
        args: string[];
        cwd?: string;
        env: Record<string, string | undefined>;
      }) => this.spawnChild(spawnOptions) as never) as Options['spawnClaudeCodeProcess'],
    };
    // Only an absolute path is ever handed to the SDK. The resolution layer
    // (src/spawn.ts + src/server.ts) has already refused an unusable explicit
    // value and cleared the rest, so this is the last line of defence: a raw,
    // relative or unresolvable value never becomes pathToClaudeCodeExecutable
    // (the SDK then spawns its bundled official CLI, which the startup line and
    // the `phase` field already report).
    if (this.deps.config.claudePath !== undefined && isAbsolute(this.deps.config.claudePath)) {
      options.pathToClaudeCodeExecutable = this.deps.config.claudePath;
    }
    return options;
  }

  // -- internals: turns -----------------------------------------------------

  private armTurn(sink: TurnSink): void {
    this.turnNumber += 1;
    const turn: ActiveTurn = {
      sink,
      deferred: createDeferred<TurnOutcome>(),
      slots: new TurnSlots(() => mintCallId()),
      blockIndexToSlot: new Map(),
      sawPartials: false,
      text: '',
      textFromAssistant: '',
      settled: false,
      lastStopReason: null,
      assistantError: undefined,
    };
    this.turn = turn;
  }

  private currentTurn(): Promise<TurnOutcome> {
    const turn = this.turn;
    if (turn === undefined) return Promise.reject(internalError('claude-bridge: no active turn'));
    return turn.deferred.promise;
  }

  private settleTurn(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;
    turn.settled = true;
    this.lastActivityAt = this.deps.clock.now();
    this.cancelTurnTimers();
    this.stateValue = outcome.kind === 'tool_calls' ? 'parked' : 'idle';
    turn.deferred.resolve(outcome);
    turn.deferred.promise.catch(() => {});
    this.deps.logger.log('turn_settled', {
      procId: this.id,
      kind: this.kind,
      outcome: outcome.kind,
      count: outcome.toolCalls.length,
      ms: outcome.usage.total_tokens,
      parkedCount: this.parked.size,
    });
  }

  private failTurn(error: BridgeError, options?: { dispose?: boolean }): void {
    const turn = this.turn;
    if (turn !== undefined && !turn.settled) {
      this.cancelTurnTimers();
      turn.settled = true;
      turn.deferred.reject(error);
      this.deps.logger.log('turn_failed', { procId: this.id, kind: this.kind, code: error.code, status: error.status });
    }
    // A parked process has no live turn to fail, but its teardown still runs.
    if (options?.dispose === true) void this.dispose(error.code);
  }

  private cancelTurnTimers(): void {
    this.stallTimer?.cancel();
    this.stallTimer = undefined;
    this.settleTimer?.cancel();
    this.settleTimer = undefined;
  }

  private cancelTimers(): void {
    this.cancelTurnTimers();
    for (const timer of this.parkedTimers.values()) timer.cancel();
    this.parkedTimers.clear();
  }

  /** Stall watchdog: re-armed on every SDK event, so it only fires on silence. */
  private rearmStall(): void {
    this.stallTimer?.cancel();
    this.stallTimer = this.deps.clock.setTimeout(() => {
      this.stallTimer = undefined;
      this.failTurn(stallError(), { dispose: true });
    }, this.deps.config.stallWatchdogMs);
  }

  /**
   * Tool-call turns never produce a `result` message: the CLI is blocked in the
   * MCP handler. So the turn is complete once every observed tool_use block is
   * parked AND the event stream has been quiet for the settle window.
   */
  private rearmSettle(): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;
    if (this.parked.size === 0) return;
    this.settleTimer?.cancel();
    this.settleTimer = this.deps.clock.setTimeout(() => {
      this.settleTimer = undefined;
      this.maybeSettleToolTurn();
    }, this.deps.config.toolSettleMs);
  }

  private maybeSettleToolTurn(): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;
    if (this.parked.size === 0) return;
    const undispatched = turn.slots.all().filter(slot => !slot.parked && slot.key.startsWith('toolu_'));
    if (undispatched.length > 0) {
      // A tool_use block the CLI has not dispatched. The CLI runs MCP tools
      // that are not read-only SERIALLY, so the rest of a parallel batch is
      // only dispatched after the parked call returns — which needs Hermes'
      // answer, which needs this turn to settle. Waiting here deadlocks (the
      // CLI's tool_progress heartbeats keep the stall watchdog quiet): the
      // 2026-09-24 cron stall. Once the assistant message is complete (stop
      // reason seen) and every block is closed, the batch is final: queue
      // those calls and settle with the whole batch.
      const complete = turn.lastStopReason !== null && undispatched.every(slot => slot.closed);
      if (!complete) {
        this.rearmSettle();
        return;
      }
      for (const slot of undispatched) this.queueUndispatched(slot);
    }
    this.settleTurn({
      kind: 'tool_calls',
      text: turn.text,
      toolCalls: turn.slots.all().map(slot => ({
        callId: slot.callId,
        name: slot.openaiName,
        argumentsJson: slot.argsJson.length > 0 ? slot.argsJson : '{}',
        index: slot.wireIndex,
      })),
      usage: zeroUsage(),
      finishReason: 'tool_calls',
    });
  }

  /** Park a call the CLI has not dispatched yet (see `queuedCalls`). */
  private queueUndispatched(slot: CallSlot): void {
    slot.parked = true;
    const call = this.parked.create({
      callId: slot.callId,
      key: slot.key,
      mcpName: slot.mcpName,
      openaiName: slot.openaiName,
      argsJson: slot.argsJson,
    });
    this.queuedCalls.set(slot.key, { mcpName: slot.mcpName, promise: call.promise });
    this.parkedSince.set(slot.callId, this.deps.clock.now());
    this.armParkedTimer(slot.callId);
    this.deps.logger.log('tool_call_queued', {
      procId: this.id,
      kind: this.kind,
      count: slot.wireIndex,
      parkedCount: this.parked.size,
    });
  }

  /** The pre-supplied answer for a queued call the CLI is now dispatching. */
  private takeQueued(mcpName: string, toolUseId: string | undefined): Promise<ToolResultPayload> | undefined {
    let key: string | undefined;
    if (toolUseId !== undefined) {
      if (this.queuedCalls.has(toolUseId)) key = toolUseId;
    } else {
      // No id on the MCP request: the CLI dispatches a batch in block order.
      for (const [candidate, entry] of this.queuedCalls) {
        if (entry.mcpName === mcpName) {
          key = candidate;
          break;
        }
      }
    }
    if (key === undefined) return undefined;
    const entry = this.queuedCalls.get(key);
    this.queuedCalls.delete(key);
    return entry?.promise;
  }

  private noteActivity(): void {
    this.lastActivityAt = this.deps.clock.now();
    this.rearmStall();
    this.rearmSettle();
  }

  private emitText(text: string): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled || text.length === 0) return;
    turn.text += text;
    if (!turn.sink.clientGone()) turn.sink.textDelta(text);
  }

  private emitToolStart(slot: CallSlot): void {
    const turn = this.turn;
    if (turn === undefined || slot.started) return;
    slot.started = true;
    if (!turn.sink.clientGone()) {
      turn.sink.toolCallStart({ index: slot.wireIndex, callId: slot.callId, name: slot.openaiName });
    }
  }

  private emitToolArgs(slot: CallSlot, deltaJson: string): void {
    const turn = this.turn;
    if (turn === undefined || deltaJson.length === 0) return;
    if (!turn.sink.clientGone()) turn.sink.toolCallArgs(slot.wireIndex, deltaJson);
  }

  // -- internals: MCP -------------------------------------------------------

  private async onToolCall(
    mcpName: string,
    args: Record<string, unknown>,
    toolUseId: string | undefined,
  ): Promise<CallToolResultLike> {
    const queued = this.disposed ? undefined : this.takeQueued(mcpName, toolUseId);
    if (queued !== undefined) return await queued;
    const turn = this.turn;
    if (this.disposed || turn === undefined || turn.settled) {
      return { content: [{ type: 'text', text: 'claude-bridge: tool call arrived outside a live turn' }], isError: true };
    }
    const slot = await this.claimSlot(turn, mcpName, toolUseId);
    if (slot === undefined) {
      return {
        content: [{ type: 'text', text: 'claude-bridge: could not correlate this tool call to a tool_use block' }],
        isError: true,
      };
    }
    if (slot.argsJson.length === 0) {
      slot.argsJson = safeJson(args);
      this.emitToolArgs(slot, slot.argsJson);
    }
    slot.parked = true;
    const call = this.parked.create({
      callId: slot.callId,
      key: slot.key,
      mcpName,
      openaiName: slot.openaiName,
      argsJson: slot.argsJson,
    });
    this.parkedSince.set(slot.callId, this.deps.clock.now());
    this.armParkedTimer(slot.callId);
    this.emitToolStart(slot);
    this.rearmSettle();
    this.deps.logger.log('tool_call_parked', {
      procId: this.id,
      kind: this.kind,
      count: slot.wireIndex,
      parkedCount: this.parked.size,
    });
    return await call.promise;
  }

  private async claimSlot(
    turn: ActiveTurn,
    mcpName: string,
    toolUseId: string | undefined,
  ): Promise<CallSlot | undefined> {
    const openaiName = this.mirror.openaiNameForEmitted(mcpName) ?? mcpName;
    if (toolUseId !== undefined) {
      const existing = turn.slots.byAnthropicId(toolUseId);
      if (existing !== undefined) return existing.parked ? undefined : existing;
      const emittedTurn = this.emittedBlocks.get(toolUseId);
      // Emitted in an earlier turn: already answered, never park it twice.
      if (emittedTurn !== undefined && emittedTurn < this.turnNumber) return undefined;
      this.emittedBlocks.set(toolUseId, this.turnNumber);
      const slot = turn.slots.forKey(toolUseId, mcpName, openaiName);
      this.emitToolStart(slot);
      return slot;
    }
    const known = (): CallSlot | undefined =>
      turn.slots.all().find(slot => slot.mcpName === mcpName && !slot.parked);
    const existing = known();
    if (existing !== undefined) return existing;
    // The CLI may dispatch before the streamed block reaches this consumer.
    const deadline = this.deps.clock.now() + this.deps.config.mcpClaimBarrierMs;
    const seen = createDeferred<void>();
    const wait = sleepOn(this.deps.clock, this.deps.config.mcpClaimBarrierMs);
    this.blockWaiters.add(seen);
    try {
      while (this.deps.clock.now() < deadline && !this.disposed && !turn.settled) {
        await Promise.race([seen.promise, wait.promise]);
        const match = known();
        if (match !== undefined) return match;
        if (this.disposed || turn.settled) return undefined;
      }
    } finally {
      this.blockWaiters.delete(seen);
      wait.cancel();
    }
    const match = known();
    if (match !== undefined) return match;
    const synthetic = turn.slots.forUnknownBlock(mcpName, openaiName);
    this.emitToolStart(synthetic);
    return synthetic;
  }

  private releaseBlockWaiters(): void {
    for (const waiter of this.blockWaiters) {
      this.blockWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private armParkedTimer(callId: string): void {
    this.parkedTimers.get(callId)?.cancel();
    this.parkedTimers.set(
      callId,
      this.deps.clock.setTimeout(() => {
        this.parkedTimers.delete(callId);
        this.onParkedTimeout(callId);
      }, this.deps.config.parkedCallTimeoutMs),
    );
  }

  private onParkedTimeout(callId: string): void {
    if (this.disposed || !this.parked.has(callId)) return;
    const error = parkedTimeoutError();
    this.failParked(error);
    this.failTurn(error, { dispose: true });
  }

  private failParked(error: unknown): void {
    for (const timer of this.parkedTimers.values()) timer.cancel();
    this.parkedTimers.clear();
    this.parkedSince.clear();
    this.parked.rejectAll(error);
  }

  private async removeTempDir(): Promise<void> {
    if (this.tempDirRemoved) return;
    try {
      await rm(this.tempDir, { recursive: true, force: true });
    } catch {
      // A missing temp dir is the desired end state; nothing to report.
    }
    this.tempDirRemoved = true;
  }

  // -- internals: SDK event stream -----------------------------------------

  private async consume(): Promise<void> {
    const query = this.query;
    if (query === undefined) return;
    try {
      for await (const message of query) {
        if (this.disposed) break;
        this.noteActivity();
        this.handleMessage(message);
      }
      this.onStreamEnded();
    } catch (error) {
      this.onStreamError(error);
    }
  }

  private onStreamEnded(): void {
    if (this.disposed) return;
    const turn = this.turn;
    if (turn !== undefined && !turn.settled) {
      // The CLI exited without a result message for this turn.
      this.failTurn(cliExitError('claude-bridge: the Claude process ended before finishing the turn'), { dispose: true });
      return;
    }
    // A tool turn may settle as 'tool_calls' and idle out afterwards.
    if (this.parked.size > 0) {
      const error = new DisposedError('cli-exit');
      this.failParked(error);
    }
    void this.dispose('cli-exit');
  }

  private onStreamError(error: unknown): void {
    if (this.disposed) return;
    const text = error instanceof Error ? error.message : String(error);
    this.failTurn(classifyFailureText(text, 'claude-bridge: the Claude process failed'), { dispose: true });
  }

  private handleMessage(message: SDKMessage): void {
    const type = str(asRecord(message).type);
    switch (type) {
      case 'system':
        this.handleSystem(message);
        return;
      case 'stream_event':
        this.handleStreamEvent(message);
        return;
      case 'assistant':
        this.handleAssistant(message);
        return;
      case 'result':
        this.handleResult(message);
        return;
      case 'auth_status':
        this.handleAuthStatus(message);
        return;
      default:
        return;
    }
  }

  private handleSystem(message: SDKMessage): void {
    const record = asRecord(message);
    const subtype = str(record.subtype);
    if (subtype === 'init') {
      const tools = Array.isArray(record.tools) ? (record.tools as unknown[]) : [];
      this.deps.logger.log('cli_init', {
        procId: this.id,
        kind: this.kind,
        claudeCodeVersion: str(record.claude_code_version) ?? 'unknown',
        apiKeySource: str(record.apiKeySource) ?? 'unknown',
        toolCount: tools.length,
        count: Array.isArray(record.mcp_servers) ? (record.mcp_servers as unknown[]).length : 0,
      });
      return;
    }
    if (subtype === 'permission_denied') {
      const toolName = str(record.tool_name) ?? '';
      if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) {
        this.failTurn(toolDeniedError(), { dispose: true });
      }
    }
  }

  private handleStreamEvent(message: SDKMessage): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;
    const event = asRecord(asRecord(message).event);
    const kind = str(event.type);
    if (kind === 'message_start') {
      turn.blockIndexToSlot.clear();
      turn.lastStopReason = null;
      return;
    }
    if (kind === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : -1;
      const block = asRecord(event.content_block);
      if (block.type === 'tool_use') {
        const anthropicId = str(block.id);
        const mcpName = str(block.name) ?? '';
        if (anthropicId !== undefined) {
          const emittedTurn = this.emittedBlocks.get(anthropicId);
          if (emittedTurn !== undefined && emittedTurn < this.turnNumber) return;
          this.emittedBlocks.set(anthropicId, this.turnNumber);
          const openaiName = this.mirror.openaiNameForEmitted(mcpName) ?? mcpName;
          const slot = turn.slots.forKey(anthropicId, mcpName, openaiName);
          turn.blockIndexToSlot.set(index, slot);
          this.emitToolStart(slot);
          this.releaseBlockWaiters();
        }
      } else if (block.type === 'text') {
        turn.sawPartials = true;
      }
      return;
    }
    if (kind === 'content_block_delta') {
      const delta = asRecord(event.delta);
      const deltaType = str(delta.type);
      if (deltaType === 'text_delta') {
        turn.sawPartials = true;
        this.emitText(str(delta.text) ?? '');
        return;
      }
      if (deltaType === 'input_json_delta') {
        const index = typeof event.index === 'number' ? event.index : -1;
        const slot = turn.blockIndexToSlot.get(index);
        const partial = str(delta.partial_json) ?? '';
        if (slot !== undefined && partial.length > 0) {
          slot.argsJson += partial;
          this.emitToolArgs(slot, partial);
        }
        return;
      }
      return;
    }
    if (kind === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : -1;
      const slot = turn.blockIndexToSlot.get(index);
      if (slot !== undefined) slot.closed = true;
      this.releaseBlockWaiters();
      return;
    }
    if (kind === 'message_delta') {
      const stopReason = str(asRecord(event.delta).stop_reason);
      if (stopReason !== undefined) turn.lastStopReason = stopReason;
      return;
    }
  }

  private handleAssistant(message: SDKMessage): void {
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;
    const record = asRecord(message);
    const errorCode = str(record.error);
    if (errorCode !== undefined) {
      turn.assistantError = errorCode;
      if (errorCode === 'authentication_failed' || errorCode === 'oauth_org_not_allowed' || errorCode === 'account_on_hold') {
        this.failTurn(notSignedInError(), { dispose: true });
        return;
      }
    }
    const body = asRecord(record.message);
    const content = Array.isArray(body.content) ? (body.content as unknown[]) : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      const blockType = str(block.type);
      if (blockType === 'tool_use') {
        const anthropicId = str(block.id);
        const mcpName = str(block.name) ?? '';
        if (anthropicId === undefined) continue;
        const emittedTurn = this.emittedBlocks.get(anthropicId);
        if (emittedTurn !== undefined && emittedTurn < this.turnNumber) continue;
        this.emittedBlocks.set(anthropicId, this.turnNumber);
        const openaiName = this.mirror.openaiNameForEmitted(mcpName) ?? mcpName;
        const slot = turn.slots.forKey(anthropicId, mcpName, openaiName);
        if (slot.argsJson.length === 0 && block.input !== undefined) {
          slot.argsJson = safeJson(block.input);
          this.emitToolArgs(slot, slot.argsJson);
        }
        slot.closed = true;
        // Only emit a start delta here if the partial stream never did.
        if (!turn.sawPartials) this.emitToolStart(slot);
        this.releaseBlockWaiters();
        continue;
      }
      if (blockType === 'text' && !turn.sawPartials) {
        const text = str(block.text) ?? '';
        if (text.length > 0) {
          turn.textFromAssistant += text;
          this.emitText(text);
        }
      }
    }
    if (str(body.stop_reason) !== undefined) turn.lastStopReason = str(body.stop_reason) ?? null;
  }

  private handleAuthStatus(message: SDKMessage): void {
    const record = asRecord(message);
    if (str(record.error) !== undefined) {
      this.failTurn(notSignedInError(), { dispose: true });
    }
  }

  private handleResult(message: SDKMessage): void {
    const record = asRecord(message);
    const subtype = str(record.subtype);
    const usage = mapUsage(record.usage);
    const terminalReason = str(record.terminal_reason);
    const turn = this.turn;
    if (turn === undefined || turn.settled) return;

    const evidence = collectEvidence(record);

    if (subtype === 'success' && record.is_error !== true) {
      const hasToolCalls = this.parked.size > 0;
      const text = turn.text.length > 0 ? turn.text : str(record.result) ?? turn.textFromAssistant;
      this.settleTurn({
        kind: hasToolCalls ? 'tool_calls' : 'text',
        text,
        toolCalls: turn.slots.all().map(slot => ({
          callId: slot.callId,
          name: slot.openaiName,
          argumentsJson: slot.argsJson.length > 0 ? slot.argsJson : '{}',
          index: slot.wireIndex,
        })),
        usage,
        finishReason: finishReasonFor(str(record.stop_reason), hasToolCalls),
      });
      return;
    }

    if (terminalReason === 'prompt_too_long' || hasOverflowEvidence(evidence)) {
      this.failTurn(overflowError(), { dispose: true });
      return;
    }
    if (subtype === 'error_max_turns') {
      this.failTurn(maxTurnsError(), { dispose: true });
      return;
    }
    if (hasAuthEvidence(evidence)) {
      this.failTurn(notSignedInError(), { dispose: true });
      return;
    }
    const text = turn.text.length > 0 ? turn.text : str(record.result);
    this.failTurn(classifyFailureText(text ?? evidence, 'claude-bridge: Claude Code reported an error'), { dispose: true });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function collectEvidence(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const result = str(record.result);
  if (result !== undefined) parts.push(result);
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) if (typeof item === 'string') parts.push(item);
  }
  return parts.join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function zeroUsage(): OpenAiUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** Minted ids Hermes sees: `call_<random>`. */
export function mintCallId(): string {
  return `call_${randomBytes(8).toString('hex')}`;
}

/** Private, empty cwd for one process: mkdtemp (0700) then an explicit chmod. */
export async function createPrivateTempDir(base: string | undefined): Promise<string> {
  const root = base ?? join(tmpdir(), 'claude-bridge');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'proc-'));
  await chmod(dir, 0o700);
  return dir;
}

export async function tempDirMode(dir: string): Promise<number> {
  const stats = await stat(dir);
  return stats.mode & 0o777;
}
