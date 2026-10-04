/**
 * Test harness: the bridge wired to a scripted fake `query` and a recording
 * spawner. No real claude, no network.
 *
 * Two entry points:
 *  - `Pipeline.post(...)` drives `handleChatCompletions` directly with a
 *    recording sink (fast, deterministic, fake clock);
 *  - `startHttpBridge(...)` runs the real HTTP server on 127.0.0.1 for the
 *    wire-level tests.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { realClock, type Clock, type TimerHandle } from '../src/clock.js';
import type { BridgeConfig } from '../src/config.js';
import { BridgeError } from '../src/errors.js';
import { createScriptedQueryFactory, type FakeProgram, type ScriptedQueryFactory } from '../src/fake.js';
import { handleChatCompletions, type ChatSink } from '../src/handler.js';
import { createMemoryLogger, type Logger } from '../src/log.js';
import { DEFAULT_AUX_MODEL, EXPOSED_MODEL_IDS } from '../src/models.js';
import { defaultMcpServerFactory } from '../src/mcp.js';
import { ProcessPool } from '../src/pool.js';
import { ClaudeProcess, type ProcessDeps, type QueryFactory } from '../src/process.js';
import { createBridgeServer, type BridgeServer } from '../src/server.js';
import type { GroupSpawner } from '../src/spawn.js';
import { createRecordingSpawner } from '../src/fake.js';
import type { OpenAiChunk, OpenAiCompletion } from '../src/openai-types.js';

export const TEST_KEY = 'test-key-0123456789abcdefghijklmnopqrstuvwxyz';

export function makeTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    key: TEST_KEY,
    port: 0,
    maxProcs: 4,
    parkedCallTimeoutMs: 30 * 60 * 1000,
    idleProcessTimeoutMs: 10 * 60 * 1000,
    requestWallClockMs: 20 * 60 * 1000,
    // Small quiet windows so tests are fast; still far above scheduling noise.
    stallWatchdogMs: 400,
    toolSettleMs: 25,
    mcpClaimBarrierMs: 200,
    killGraceMs: 25,
    maxTurns: 256,
    auxModel: DEFAULT_AUX_MODEL,
    defaultEffort: 'medium',
    modelEfforts: {},
    claudePath: undefined,
    tempBase: undefined,
    fake: false,
    exposedModels: EXPOSED_MODEL_IDS,
    maxBodyBytes: 64 * 1024 * 1024,
    ...overrides,
  };
}

/** A clock whose `now` can move independently of its timers. */
export class FakeClock implements Clock {
  private current: number;
  private timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Fire every timer due within `ms`, then move time. Lets async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter(timer => timer !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
      await settle();
    }
    this.current = Math.max(this.current, target);
    await settle();
  }

  /** Move time WITHOUT firing timers (the "deadline passed" case). */
  skew(ms: number): void {
    this.current += ms;
  }

  get pendingTimers(): number {
    return this.timers.filter(timer => !timer.cancelled).length;
  }
}

export function settle(times = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise<void>(resolve => setImmediate(resolve)));
  return chain;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Captures everything the bridge writes to this process's stdout/stderr, so a
 * test can prove that CLI stderr (or anything else content-bearing) never lands
 * there. Always call `stop()` — ideally in a `finally`.
 */
export function captureProcessWrites(): { written: string[]; stop: () => void } {
  const written: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const capture = ((chunk: unknown, ...rest: unknown[]): boolean => {
    written.push(typeof chunk === 'string' ? chunk : String(chunk));
    const callback = rest.find(entry => typeof entry === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  return {
    written,
    stop: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

/** The stderr stream of the most recently spawned fake CLI child. */
export function childStderr(bridge: Pipeline): PassThrough {
  const child = bridge.spawner.children.at(-1);
  const stream = child?.stderr;
  if (stream === null || stream === undefined) throw new Error('no spawned child with a stderr stream');
  return stream as PassThrough;
}

export interface RecordedRequest {
  readonly chunks: OpenAiChunk[];
  readonly completion: OpenAiCompletion | undefined;
  readonly done: boolean;
  readonly error: BridgeError | undefined;
  readonly headersSent: boolean;
}

/** A ChatSink that records everything and can simulate a client disconnect. */
export class RecordingSink implements ChatSink {
  readonly chunks: OpenAiChunk[] = [];
  completion: OpenAiCompletion | undefined;
  done = false;
  error: BridgeError | undefined;
  headersSentFlag = false;
  gone = false;
  private closeCallbacks: Array<() => void> = [];

  constructor(readonly streaming: boolean) {}

  sendChunk(chunk: OpenAiChunk): void {
    this.headersSentFlag = true;
    this.chunks.push(chunk);
  }

  sendCompletion(completion: OpenAiCompletion): void {
    this.headersSentFlag = true;
    this.completion = completion;
  }

  sendDone(): void {
    this.done = true;
  }

  sendError(error: BridgeError): void {
    this.error = error;
  }

  clientGone(): boolean {
    return this.gone;
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }

  /** Simulates the socket closing before the response finished. */
  disconnect(): void {
    this.gone = true;
    for (const callback of this.closeCallbacks) callback();
  }

  get text(): string {
    return this.chunks
      .map(chunk => chunk.choices[0]?.delta.content ?? '')
      .join('');
  }

  get toolCalls(): Array<{ index: number; id: string; name: string; args: string }> {
    const byIndex = new Map<number, { index: number; id: string; name: string; args: string }>();
    for (const chunk of this.chunks) {
      for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
        const entry = byIndex.get(call.index) ?? { index: call.index, id: '', name: '', args: '' };
        if (call.id !== undefined) entry.id = call.id;
        if (call.function?.name !== undefined) entry.name = call.function.name;
        if (call.function?.arguments !== undefined) entry.args += call.function.arguments;
        byIndex.set(call.index, entry);
      }
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
  }

  get finishReasons(): Array<string | null> {
    return this.chunks.map(chunk => chunk.choices[0]?.finish_reason ?? null).filter(reason => reason !== null);
  }

  get usage(): OpenAiChunk['usage'] {
    return this.chunks.find(chunk => chunk.usage !== undefined)?.usage;
  }
}

export interface PipelineOptions {
  readonly clock?: Clock;
  readonly config?: Partial<BridgeConfig>;
  readonly program?: FakeProgram | ((input: { meta: { tools: ReadonlyArray<{ mcpName: string }> } }, index: number) => FakeProgram);
  readonly fakeOptions?: Parameters<typeof createScriptedQueryFactory>[1];
  readonly queryFn?: QueryFactory;
}

export class Pipeline {
  readonly config: BridgeConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly logLines: string[];
  readonly spawner: GroupSpawner;
  readonly pool: ProcessPool;
  readonly processDeps: ProcessDeps;
  readonly factory: ScriptedQueryFactory;
  /** Every ClaudeProcess this pipeline created, in order (for teardown assertions). */
  readonly created: ClaudeProcess[] = [];

  constructor(options: PipelineOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.config = makeTestConfig(options.config ?? {});
    const memory = createMemoryLogger();
    this.logger = memory.logger;
    this.logLines = memory.lines;
    this.spawner = createRecordingSpawner(this.clock, this.config.killGraceMs);
    this.factory =
      (options.queryFn as ScriptedQueryFactory | undefined) ??
      createScriptedQueryFactory(
        (options.program as (input: { meta: { tools: ReadonlyArray<{ mcpName: string }> } }, index: number) => FakeProgram) ??
          (() => [[{ kind: 'text', text: 'default' }]]),
        options.fakeOptions ?? {},
      );
    this.processDeps = {
      queryFn: this.factory,
      mcpFactory: defaultMcpServerFactory,
      clock: this.clock,
      logger: this.logger,
      config: this.config,
      spawner: this.spawner,
    };
    this.pool = new ProcessPool({
      config: this.config,
      logger: this.logger,
      clock: this.clock,
      create: async (init, sink) => {
        const process = await ClaudeProcess.create(init, sink);
        this.created.push(process);
        return process;
      },
    });
  }

  get lastProcess(): ClaudeProcess | undefined {
    return this.created.at(-1);
  }

  get queryCallCount(): number {
    return this.factory.calls.length;
  }

  get groupKills(): Array<{ pid: number | undefined; signal: string; scope: string }> {
    return this.spawner.kills.map(kill => ({ pid: kill.pid, signal: kill.signal, scope: kill.scope }));
  }

  get tempDirs(): string[] {
    return this.pool.snapshot().map(entry => entry.id);
  }

  async post(
    body: Record<string, unknown>,
    options: { streaming?: boolean; sink?: RecordingSink } = {},
  ): Promise<RecordedRequest & { sink: RecordingSink }> {
    const sink = options.sink ?? new RecordingSink(options.streaming ?? body.stream === true);
    await handleChatCompletions(body, sink, {
      config: this.config,
      logger: this.logger,
      clock: this.clock,
      pool: this.pool,
      processDeps: this.processDeps,
      requestId: `req-${this.pool.size}-${Date.now()}`,
      claudeAvailable: true,
    });
    return {
      chunks: sink.chunks,
      completion: sink.completion,
      done: sink.done,
      error: sink.error,
      headersSent: sink.headersSentFlag,
      sink,
    };
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdownAll();
  }
}

export function userMessage(content: string): { role: string; content: string } {
  return { role: 'user', content };
}

export function assistantToolCall(calls: Array<{ id: string; name: string; args: string }>): {
  role: string;
  content: string;
  tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
} {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    })),
  };
}

export function toolResult(id: string, content: string): { role: string; tool_call_id: string; content: string } {
  return { role: 'tool', tool_call_id: id, content };
}

export interface HttpBridge {
  readonly server: BridgeServer;
  readonly port: number;
  readonly pipeline: Pipeline;
  close(): Promise<void>;
}

/** The real HTTP server on loopback, with the fake query injected. */
export async function startHttpBridge(options: PipelineOptions = {}): Promise<HttpBridge> {
  const pipeline = new Pipeline(options);
  const server = createBridgeServer({
    config: pipeline.config,
    logger: pipeline.logger,
    clock: pipeline.clock,
    processDeps: pipeline.processDeps,
    claudeAvailable: true,
  });
  const port = await server.listen(0);
  return {
    server,
    port,
    pipeline,
    async close() {
      await server.close();
    },
  };
}

export interface SseResult {
  readonly status: number;
  readonly headers: Headers;
  readonly frames: string[];
  readonly chunks: unknown[];
  readonly text: string;
  readonly sawDone: boolean;
  readonly raw: string;
}

export async function postSse(
  port: number,
  body: unknown,
  options: { key?: string; host?: string; origin?: string } = {},
): Promise<SseResult> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.key ?? TEST_KEY}`,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const frames = raw
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data:'));
  const chunks: unknown[] = [];
  let sawDone = false;
  for (const frame of frames) {
    const payload = frame.slice('data:'.length).trim();
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }
    chunks.push(JSON.parse(payload));
  }
  const text = chunks
    .map(chunk => (chunk as OpenAiChunk).choices?.[0]?.delta?.content ?? '')
    .join('');
  return { status: response.status, headers: response.headers, frames, chunks, text, sawDone, raw };
}

/** Raw HTTP over loopback, so Host/Origin headers can be controlled. */
export async function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { request } = await import('node:http');
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/v1/chat/completions',
        headers: options.headers ?? {},
      },
      response => {
        const parts: Buffer[] = [];
        response.on('data', chunk => parts.push(chunk as Buffer));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A workspace-local scratch dir for tests that need one. */
export function makeScratchDir(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export type { SDKMessage };
