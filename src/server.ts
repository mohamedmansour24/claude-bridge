/**
 * The loopback HTTP surface.
 *
 * SPEC.md invariant 3: bind 127.0.0.1 only, refuse any Host/Origin that is not
 * loopback, and require a bearer key (CLAUDE_BRIDGE_KEY, >= 32 chars, compared
 * in constant time) on every request except /healthz.
 *
 * SPEC.md invariant 4: the log lines this file writes carry ids, counts,
 * durations, model names and outcome codes only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { realClock, type Clock } from './clock.js';
import { loadConfig, type BridgeConfig } from './config.js';
import { BridgeError, asBridgeError, badRequestError, bodyTooLargeError, errorBody, forbiddenHostError, unauthorizedError } from './errors.js';
import { handleChatCompletions, type ChatSink, type HandlerDeps } from './handler.js';
import { createLogger, type Logger } from './log.js';
import { createScriptedQueryFactory, buildFakePolicyProgram, createRecordingSpawner } from './fake.js';
import { defaultMcpServerFactory } from './mcp.js';
import { EXPOSED_MODEL_IDS } from './models.js';
import { ProcessPool } from './pool.js';
import { ClaudeProcess, type ProcessDeps } from './process.js';
import { GroupSpawner, describeClaudeBinary, resolveClaudeBinarySource, type ResolvedClaudeBinary } from './spawn.js';
import type { OpenAiChunk } from './openai-types.js';

/** The only host names that count as loopback, spelled exactly as SPEC.md does. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost']);
const LOOPBACK_V6 = '::1';

/**
 * `host[:port]`, with a bracketed IPv6 literal or a bare name, and nothing else.
 * A value that does not match completely (trailing text, a path, userinfo, a
 * second colon, an unbracketed IPv6) is not a loopback host.
 */
const HOST_PATTERN = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+))(?::([0-9]{1,5}))?$/;

function isValidPort(port: string): boolean {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * True only for a strict loopback Host/Origin host value (port optional).
 *
 * Invariant 3 says "refuse any Host/Origin that is not loopback", so this is a
 * parser rather than a substring test: `127.0.0.1:8801@evil.com`,
 * `[::1].attacker.com`, `127.0.0.1.evil.com` and `localhost.attacker.com` are
 * all refused. Only `127.0.0.1`, `localhost` and the *bracketed* `[::1]` are
 * accepted; an unbracketed `::1` is refused because it is indistinguishable
 * from `host:port` and is not a valid Host header value in the first place.
 */
export function isLoopbackHost(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  // Userinfo (`@`), a path, a backslash or any whitespace means the value is
  // claiming a host it is not. HOST_PATTERN already excludes these characters;
  // this stays as an explicit, cheap first refusal that survives any later
  // change to the pattern. The value is never trimmed, so `'127.0.0.1 '` is
  // refused rather than quietly accepted.
  if (/[@/\\\s]/.test(value)) return false;
  const match = HOST_PATTERN.exec(value);
  if (match === null) return false;
  const [, bracketed, bare, port] = match;
  if (port !== undefined && !isValidPort(port)) return false;
  if (bracketed !== undefined) return bracketed.toLowerCase() === LOOPBACK_V6;
  return bare !== undefined && LOOPBACK_NAMES.has(bare.toLowerCase());
}

/**
 * `Origin: undefined` (a non-browser client sends none) is accepted; every
 * other value must be an http(s) origin whose host is loopback. `Origin: null`
 * and any other scheme are NOT loopback and are refused.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // An origin never carries userinfo: `http://127.0.0.1:1@evil.com` is evil.com.
    if (url.username.length > 0 || url.password.length > 0) return false;
    return isLoopbackHost(url.host);
  } catch {
    return false;
  }
}

/** Constant-time compare; hashing first makes the lengths equal. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

class HttpChatSink implements ChatSink {
  private headersWritten = false;
  private finished = false;
  private closed = false;
  private closeCallbacks: Array<() => void> = [];

  constructor(
    readonly streaming: boolean,
    private readonly response: ServerResponse,
    private readonly completionId: string,
    private readonly created: number,
    private readonly model: string,
  ) {
    this.response.on('close', () => {
      if (this.finished) return;
      this.closed = true;
      for (const callback of this.closeCallbacks) callback();
    });
  }

  private writeSseHeaders(): void {
    if (this.headersWritten) return;
    this.headersWritten = true;
    this.response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }

  sendChunk(chunk: OpenAiChunk): void {
    if (!this.streaming) return;
    this.writeSseHeaders();
    this.response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  sendCompletion(body: unknown): void {
    if (this.headersWritten) return;
    this.headersWritten = true;
    this.finished = true;
    const payload = JSON.stringify(body);
    this.response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    this.response.end(payload);
  }

  sendDone(): void {
    if (!this.streaming) return;
    this.writeSseHeaders();
    this.response.write('data: [DONE]\n\n');
    this.finished = true;
    this.response.end();
  }

  sendError(error: BridgeError): void {
    if (this.finished) return;
    if (!this.headersWritten) {
      this.headersWritten = true;
      this.finished = true;
      const payload = JSON.stringify(errorBody(error));
      this.response.writeHead(error.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...error.headers,
      });
      this.response.end(payload);
      return;
    }
    // Mid-stream: an OpenAI error object on a choiceless chunk, which Hermes
    // turns into a ProviderStreamError rather than pretending success
    // (docs/HERMES-CLIENT-FACTS.md §3.7/§3.8).
    this.writeSseHeaders();
    const frame = {
      id: this.completionId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
      error_type: error.type,
      error_code: error.code,
      error_message: error.message,
    };
    this.response.write(`data: ${JSON.stringify(frame)}\n\n`);
    this.response.write('data: [DONE]\n\n');
    this.finished = true;
    this.response.end();
  }

  clientGone(): boolean {
    return this.closed;
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }
}

function jsonResponse(response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(headers ?? {}),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        // Stop reading now: never buffer the chunk that pushed us past the cap,
        // and never buffer anything after it either. Pause rather than destroy
        // so the socket survives long enough to carry the 413 response back;
        // the server closes the connection once that response is flushed.
        rejected = true;
        request.pause();
        reject(bodyTooLargeError(maxBodyBytes));
        return;
      }
      parts.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      resolve(Buffer.concat(parts).toString('utf8'));
    });
    request.on('error', error => {
      if (rejected) return;
      reject(asBridgeError(error));
    });
  });
}

export interface BridgeServerDeps {
  readonly config: BridgeConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly processDeps: ProcessDeps;
  readonly claudeAvailable: boolean;
}

export interface BridgeServer {
  readonly server: Server;
  readonly pool: ProcessPool;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export function createBridgeServer(deps: BridgeServerDeps): BridgeServer {
  const pool = new ProcessPool({
    config: deps.config,
    logger: deps.logger,
    clock: deps.clock,
    create: (init, sink) => ClaudeProcess.create(init, sink),
  });

  const handlerDeps = (requestId: string): HandlerDeps => ({
    config: deps.config,
    logger: deps.logger,
    clock: deps.clock,
    pool,
    processDeps: deps.processDeps,
    requestId,
    claudeAvailable: deps.claudeAvailable,
  });

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      const bridgeError = asBridgeError(error);
      if (!response.headersSent) {
        const extraHeaders =
          bridgeError.code === 'CLAUDE_BRIDGE_BODY_TOO_LARGE'
            ? (() => {
                // The client may still be mid-upload past the cap; once the 413 is
                // flushed, drop the connection instead of trying to drain the rest.
                response.once('finish', () => request.destroy());
                return { connection: 'close' };
              })()
            : {};
        jsonResponse(response, bridgeError.status, errorBody(bridgeError), { ...extraHeaders, ...bridgeError.headers });
      } else response.end();
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomBytes(8).toString('hex');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // Loopback only. Refuse anything that claims another host or origin.
    const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!isLoopbackHost(host)) {
      throw forbiddenHostError('Host header', String(host ?? ''));
    }
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
    if (!originIsLoopback(origin)) {
      throw forbiddenHostError('Origin header', String(origin ?? ''));
    }

    if (path === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        jsonResponse(response, 405, { error: { message: 'method not allowed', type: 'invalid_request_error', code: 'CLAUDE_BRIDGE_BAD_REQUEST' } });
        return;
      }
      jsonResponse(response, 200, { ok: true });
      return;
    }

    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const presented = bearerFrom(authorization);
    if (presented === undefined || !constantTimeEqual(presented, deps.config.key)) {
      deps.logger.log('request_unauthorized', { requestId, code: 'CLAUDE_BRIDGE_UNAUTHORIZED', status: 401, path, bearer: presented === undefined ? 'absent' : 'wrong' });
      throw unauthorizedError();
    }

    if (path === '/v1/models' || path === '/models') {
      if (request.method !== 'GET') {
        jsonResponse(response, 405, errorBody(badRequestError('claude-bridge: GET required')));
        return;
      }
      const created = Math.floor(deps.clock.now() / 1000);
      jsonResponse(response, 200, {
        object: 'list',
        data: EXPOSED_MODEL_IDS.map(id => ({ id, object: 'model', created, owned_by: 'claude-bridge' })),
      });
      return;
    }

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      if (request.method !== 'POST') {
        jsonResponse(response, 405, errorBody(badRequestError('claude-bridge: POST required')));
        return;
      }
      const raw = await readBody(request, deps.config.maxBodyBytes);
      let parsed: unknown;
      try {
        parsed = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        throw badRequestError('claude-bridge: request body is not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object') {
        throw badRequestError('claude-bridge: request body must be a JSON object');
      }
      const body = parsed as Record<string, unknown>;
      const streaming = body.stream === true;
      const model = typeof body.model === 'string' ? body.model : '';
      const completionId = `chatcmpl-${randomBytes(12).toString('hex')}`;
      const sink = new HttpChatSink(streaming, response, completionId, Math.floor(deps.clock.now() / 1000), model);
      await handleChatCompletions(body, sink, handlerDeps(requestId));
      return;
    }

    jsonResponse(response, 404, errorBody(badRequestError(`claude-bridge: no route for ${path}`)));
  }

  return {
    server,
    pool,
    async listen(port: number): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : port;
    },
    async close(): Promise<void> {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await pool.shutdownAll();
    },
  };
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

export interface BuildOptions {
  readonly env?: Record<string, string | undefined>;
  readonly argv?: readonly string[];
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Real mode passes the official Agent SDK query; tests pass a scripted fake. */
  readonly queryFnOverride?: ProcessDeps['queryFn'];
  readonly spawnerOverride?: ProcessDeps['spawner'];
  /** Seam for the PATH lookup, so the resolution order is testable without a spawn. */
  readonly exists?: (path: string) => boolean;
}

export function buildProcessDeps(
  config: BridgeConfig,
  options: BuildOptions,
): {
  processDeps: ProcessDeps;
  claudeBinary: ResolvedClaudeBinary;
  /**
   * Whether an official CLI can be spawned. `--fake` needs none, and real mode
   * always has one: the resolved binary (explicit or PATH) or the CLI the Agent
   * SDK bundles. The bridge therefore never refuses to start for a missing PATH
   * binary — it says which CLI it will use instead (FIX 2 / SPEC.md invariant 1).
   */
  claudeAvailable: boolean;
} {
  const clock = options.clock ?? realClock;
  const logger = options.logger ?? createLogger(line => process.stderr.write(line));
  const claudeBinary = resolveClaudeBinarySource({
    explicit: config.claudePath,
    env: options.env ?? process.env,
    ...(options.exists === undefined ? {} : { exists: options.exists }),
  });

  const spawner = options.spawnerOverride ?? createRecordingSpawner(clock, config.killGraceMs);
  const groupSpawner =
    options.spawnerOverride ??
    (config.fake ? spawner : new GroupSpawner({ clock, killGraceMs: config.killGraceMs }));

  const queryFn =
    options.queryFnOverride ??
    (config.fake
      ? createScriptedQueryFactory(input => buildFakePolicyProgram(input.meta.tools), { apiKeySource: 'fake' })
      : undefined);

  if (queryFn === undefined) {
    throw new Error(
      'claude-bridge: no query implementation for real mode — main() must pass the official Agent SDK query (src/real-query.ts)',
    );
  }

  // src/process.ts sets Options.pathToClaudeCodeExecutable exactly when
  // `config.claudePath` is set, so the resolved binary travels in the config the
  // process is built from. The effective config therefore carries ONLY the
  // resolved absolute path, or undefined (the SDK spawns its bundled CLI): the
  // raw `CLAUDE_BRIDGE_CLAUDE_PATH` value — relative, missing or empty — is
  // never handed to the SDK, and `resolveClaudeBinarySource` has already
  // refused to start on a value that names nothing spawnable.
  const effectiveConfig: BridgeConfig = { ...config, claudePath: claudeBinary.path };

  const processDeps: ProcessDeps = {
    queryFn,
    mcpFactory: defaultMcpServerFactory,
    clock,
    logger,
    config: effectiveConfig,
    spawner: groupSpawner,
  };
  return { processDeps, claudeBinary, claudeAvailable: true };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig({ env: process.env, argv });
  const logger = createLogger(line => process.stderr.write(line));
  const clock = realClock;
  // Real mode reaches the Agent SDK here and nowhere else (src/real-query.ts).
  const queryFnOverride = config.fake ? undefined : (await import('./real-query.js')).officialQuery;
  const { processDeps, claudeBinary, claudeAvailable } = buildProcessDeps(config, { logger, clock, queryFnOverride });

  const bridge = createBridgeServer({ config: processDeps.config, logger, clock, processDeps, claudeAvailable });
  const port = await bridge.listen(config.port);

  logger.log('bridge_listening', {
    // 127.0.0.1 is not content; the port is a number.
    model: config.exposedModels[0] ?? 'none',
    count: port,
    kind: config.fake ? 'fake' : 'real',
    // Which official CLI this bridge will spawn: explicit | path | bundled
    // (or `scripted` for --fake, which uses no CLI at all).
    phase: config.fake ? 'scripted' : claudeBinary.source,
  });
  process.stderr.write(
    `claude-bridge: listening on http://127.0.0.1:${port}/v1 (${
      config.fake ? 'fake scripted model; no claude binary used' : describeClaudeBinary(claudeBinary)
    }); models: ${config.exposedModels.join(', ')}\n`,
  );

  const shutdown = (signal: string): void => {
    logger.log('bridge_shutdown', { code: signal });
    void bridge.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.startsWith('claude-bridge:') ? '' : 'claude-bridge: '}${message}\n`);
    process.exitCode = 1;
  });
}
