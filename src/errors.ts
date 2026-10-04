/**
 * OpenAI-shaped errors, carrying the exact HTTP status and structured `code`
 * Hermes' classifier reacts to (docs/HERMES-CLIENT-FACTS.md §7, §9).
 */

export type BridgeErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'rate_limit_or_stall'
  | 'timeout_error'
  | 'forbidden_error'
  | 'api_error';

export interface BridgeErrorOptions {
  status: number;
  code: string;
  type: BridgeErrorType;
  message: string;
  headers?: Record<string, string>;
}

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: BridgeErrorType;
  readonly headers: Record<string, string>;

  constructor(options: BridgeErrorOptions) {
    super(options.message);
    this.name = 'BridgeError';
    this.status = options.status;
    this.code = options.code;
    this.type = options.type;
    this.headers = options.headers ?? {};
  }
}

export interface OpenAiErrorBody {
  error: { message: string; type: BridgeErrorType; code: string };
}

export function errorBody(error: BridgeError): OpenAiErrorBody {
  return { error: { message: error.message, type: error.type, code: error.code } };
}

/** Hermes' overflow code — verified in docs/HERMES-CLIENT-FACTS.md §7.1. */
export const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';

export function stallError(detail = 'Claude produced no output within the stall watchdog window'): BridgeError {
  return new BridgeError({
    status: 503,
    code: 'CLAUDE_BRIDGE_STALL',
    type: 'rate_limit_or_stall',
    message: `${detail}. This is the subscription-cap / silent-hang path; retry after the window resets.`,
  });
}

export function notSignedInError(): BridgeError {
  return new BridgeError({
    // 503, not 401: Hermes words every 401 as "rejected your API key", which
    // sends the owner to the wrong fix. A 503 makes Hermes show the message
    // below verbatim ("Provider said: …"), which names the real fix.
    status: 503,
    code: 'CLAUDE_BRIDGE_NOT_SIGNED_IN',
    type: 'api_error',
    // The one-line fix, verbatim per SPEC.md.
    message: 'Claude is not signed in: run claude once in a terminal and sign in.',
  });
}

export function overflowError(detail = "This model's maximum context length was exceeded"): BridgeError {
  return new BridgeError({
    status: 400,
    code: CONTEXT_OVERFLOW_CODE,
    type: 'invalid_request_error',
    message: `${detail}; try again with less context (context length exceeded).`,
  });
}

export function maxProcsError(maxProcs: number, retryAfterSeconds: number): BridgeError {
  return new BridgeError({
    status: 429,
    code: 'CLAUDE_BRIDGE_MAX_PROCS',
    type: 'rate_limit_error',
    message: `claude-bridge is already running ${maxProcs} Claude processes (the configured maximum); retry shortly.`,
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}

export function parkedTimeoutError(): BridgeError {
  return new BridgeError({
    status: 504,
    code: 'CLAUDE_BRIDGE_PARKED_TIMEOUT',
    type: 'timeout_error',
    message: 'The parked Claude tool call was never answered in time and its process was torn down.',
  });
}

export function requestTimeoutError(): BridgeError {
  return new BridgeError({
    status: 504,
    code: 'CLAUDE_BRIDGE_REQUEST_TIMEOUT',
    type: 'timeout_error',
    message: 'The request exceeded the configured wall-clock limit and its Claude process was torn down.',
  });
}

/**
 * A tool-result batch whose ids are not EXACTLY the ids parked for one
 * completed assistant turn: a subset, a superset, an unknown id, a repeated id,
 * or ids belonging to two parked turns. SPEC.md: "all ids of one assistant turn
 * must come back before you resume; a missing one after the timeout = failure,
 * not a guess" — so the batch is refused as it stands, the parked process is
 * neither resumed nor disposed (its own deadline still governs), and a missing
 * id still ends in CLAUDE_BRIDGE_PARKED_TIMEOUT.
 */
export function partialToolResultsError(given: number, parked: number): BridgeError {
  return new BridgeError({
    status: 409,
    code: 'CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS',
    type: 'invalid_request_error',
    message:
      `claude-bridge: this request carries ${given} tool result id(s) for a turn with ${parked} parked call(s), and they are ` +
      'not exactly that turn\'s parked ids, each exactly once (a repeated id, a missing one, an unknown one or ids from two ' +
      'parked turns all count as a mismatch). Every parked id of that turn must come back exactly once, in one request. ' +
      'The parked call keeps its deadline and fails as CLAUDE_BRIDGE_PARKED_TIMEOUT if it is never answered.',
  });
}

export function unknownModelError(model: unknown, exposed: readonly string[]): BridgeError {
  return new BridgeError({
    status: 400,
    code: 'model_not_found',
    type: 'invalid_request_error',
    message: `Unknown model ${JSON.stringify(typeof model === 'string' ? model : null)}; this bridge exposes: ${exposed.join(', ')}.`,
  });
}

export function badRequestError(message: string): BridgeError {
  return new BridgeError({ status: 400, code: 'CLAUDE_BRIDGE_BAD_REQUEST', type: 'invalid_request_error', message });
}

/** The request body exceeded `maxBodyBytes`; caught mid-read, never after buffering it all. */
export function bodyTooLargeError(maxBodyBytes: number): BridgeError {
  return new BridgeError({
    status: 413,
    code: 'CLAUDE_BRIDGE_BODY_TOO_LARGE',
    type: 'invalid_request_error',
    message: `claude-bridge: request body exceeds the configured limit of ${maxBodyBytes} bytes (CLAUDE_BRIDGE_MAX_BODY_BYTES).`,
  });
}

export function unauthorizedError(): BridgeError {
  return new BridgeError({
    status: 401,
    code: 'CLAUDE_BRIDGE_UNAUTHORIZED',
    type: 'authentication_error',
    message: 'Missing or invalid bearer key; set Authorization: Bearer <CLAUDE_BRIDGE_KEY>.',
  });
}

export function forbiddenHostError(what: string, value: string): BridgeError {
  return new BridgeError({
    status: 403,
    code: 'CLAUDE_BRIDGE_FORBIDDEN_HOST',
    type: 'forbidden_error',
    message: `claude-bridge only serves loopback; the ${what} ${JSON.stringify(value)} is not loopback.`,
  });
}

export function toolDeniedError(): BridgeError {
  return new BridgeError({
    status: 500,
    code: 'CLAUDE_BRIDGE_TOOL_DENIED',
    type: 'api_error',
    message: 'Claude Code denied a bridged hermes tool; the turn was aborted.',
  });
}

export function maxTurnsError(): BridgeError {
  return new BridgeError({
    status: 500,
    code: 'CLAUDE_BRIDGE_MAX_TURNS',
    type: 'api_error',
    message: 'Claude Code stopped because the turn budget (maxTurns) was exhausted.',
  });
}

export function internalError(detail: string): BridgeError {
  return new BridgeError({ status: 500, code: 'CLAUDE_BRIDGE_INTERNAL', type: 'api_error', message: detail });
}

export function cliExitError(detail: string): BridgeError {
  return new BridgeError({ status: 502, code: 'CLAUDE_BRIDGE_CLI_EXIT', type: 'api_error', message: detail });
}

export function notConfiguredError(detail: string): BridgeError {
  return new BridgeError({ status: 503, code: 'CLAUDE_BRIDGE_NOT_CONFIGURED', type: 'api_error', message: detail });
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return internalError(`claude-bridge failed: ${detail}`);
}
