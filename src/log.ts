/**
 * Structured logging with an allowlist. SPEC.md invariant 4: no message text,
 * tool arguments or tool results may ever reach the log.
 *
 * Three rules are enforced here, structurally (never by a caller's discipline):
 *
 *  1. a field is written only if its NAME is on the allowlist;
 *  2. EVERY string that is written — every field value AND the `event` name —
 *     must be a short machine-token-shaped string (SAFE_TOKEN) that is NOT
 *     credential-shaped (`looksLikeCredential`); and
 *  3. a field whose value comes from the CLI, the SDK or a request must also be
 *     a member of its closed set (or match the version shape), or it is dropped.
 *
 * Rule 2 is what makes "no credential-shaped value can be logged" structural
 * rather than field-name-dependent: it applies to every string on the line, so a
 * token passed through ANY allow-listed field — or used as the event name — is
 * dropped, not just one passed through a field that happens to have a rule.
 */

import { EXPOSED_MODEL_IDS } from './models.js';

export type LogValue = string | number | boolean;

export interface Logger {
  log(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Values that may be logged: ids, counts, durations, model names, outcome
 * codes. Deliberately excludes whitespace, quotes, braces and anything that
 * would let a sentence or a JSON blob through.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.:@/+-]{1,64}$/;

/**
 * Credential shapes. Rejected for EVERY string written to a log line — every
 * allow-listed field value and the `event` name — never just for a field list.
 *
 *  - a provider-prefixed key: `sk-…` (including `sk-ant-…`, `sk-proj-…`,
 *    `sk-live-…`, `sk-test-…`);
 *  - a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`);
 *  - a Slack token (`xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-`);
 *  - a Google API key (`AIza…`) or OAuth token (`ya29.…`);
 *  - an AWS access-key id (`AKIA…`);
 *  - a JWT: an `eyJ…` header plus at least one more dotted base64url segment;
 *  - a long opaque blob (see `isOpaqueBlob`).
 *
 * Deliberately NOT rejected, because they are values this bridge legitimately
 * logs: bridge error codes (`CLAUDE_BRIDGE_STALL`,
 * `CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS`, `context_length_exceeded`, …), hex
 * request/proc ids, exposed model ids, `code` slugs (`idle-timeout`, …),
 * versions and short enums. Those are all-lowercase, all-uppercase, or shorter
 * than 32 characters — a 32+ character base64-alphabet string that mixes upper
 * case, lower case AND digits (or carries `+`, `/`, `=`) is treated as a blob.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_-])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{10,}/,
  /(?:^|[^A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/,
  /(?:^|[^A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/,
  /(?:^|[^A-Za-z0-9_])AIza[A-Za-z0-9_-]{20,}/,
  /(?:^|[^A-Za-z0-9_])ya29\.[A-Za-z0-9_-]{10,}/,
  /(?:^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/,
];

/** The characters a base64 blob is made of. */
const BASE64_ALPHABET = /^[A-Za-z0-9+/=_-]+$/;

/** A long opaque blob: base64 punctuation, or mixed case + digits. */
function isOpaqueBlob(value: string): boolean {
  if (value.length < 32 || !BASE64_ALPHABET.test(value)) return false;
  if (/[+/=]/.test(value)) return true;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/** True for a value shaped like a credential rather than like a log token. */
export function looksLikeCredential(value: string): boolean {
  if (isOpaqueBlob(value)) return true;
  return CREDENTIAL_SHAPES.some(pattern => pattern.test(value));
}

/** Field names that may appear in a log line. */
export const LOG_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'requestId',
  'procId',
  'kind',
  'model',
  'sdkModel',
  'effort',
  'code',
  'type',
  'outcome',
  'phase',
  'status',
  'ms',
  'count',
  'toolCount',
  'messageCount',
  'parkedCount',
  'procCount',
  'retryAfterMs',
  'stream',
  'claudeCodeVersion',
  'apiKeySource',
  'subtype',
  'terminalReason',
  'signal',
  'streamed',
]);

// ---------------------------------------------------------------------------
// Closed value sets for the fields that could otherwise carry free text.
//
// The SDK defines these enums itself (docs/SDK-FACTS.md §2; sdk.d.ts:127
// ApiKeySource, :4603 result subtypes, :4773 system init subtypes, :8035
// TerminalReason); `model` is this bridge's own exposed-id list and `phase` is
// this bridge's own binary source. `fake`, `unknown`, `none` and `scripted` are
// the bridge's own labels for the --fake mode and the SDK's absent values.
// ---------------------------------------------------------------------------

const API_KEY_SOURCES: ReadonlySet<string> = new Set([
  // ApiKeySource (sdk.d.ts:127). The two values that contain a space or a slash
  // ('/login managed key') are additionally rejected by the shape check above:
  // dropping them is the safe direction.
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
  'fake',
  'unknown',
]);

const MESSAGE_SUBTYPES: ReadonlySet<string> = new Set([
  // System messages (sdk.d.ts:3161, :4758, :4773) and result messages (sdk.d.ts:4603, :4639).
  'init',
  'compact_boundary',
  'status',
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

const TERMINAL_REASONS: ReadonlySet<string> = new Set([
  // TerminalReason (sdk.d.ts:8035), verbatim.
  'blocking_limit',
  'rapid_refill_breaker',
  'prompt_too_long',
  'image_error',
  'model_error',
  'api_error',
  'malformed_tool_use_exhausted',
  'aborted_streaming',
  'aborted_tools',
  'stop_hook_prevented',
  'hook_stopped',
  'tool_deferred',
  'max_turns',
  'background_requested',
  'completed',
  'budget_exhausted',
  'structured_output_retry_exhausted',
  'tool_deferred_unavailable',
  'turn_setup_failed',
]);

/** Process kinds: the two conversation kinds plus the bridge's two modes. */
const PROCESS_KINDS: ReadonlySet<string> = new Set(['conversation', 'aux', 'fake', 'real']);

/** Turn outcomes (src/process.ts TurnOutcome.kind). */
const TURN_OUTCOMES: ReadonlySet<string> = new Set(['text', 'tool_calls', 'abandoned']);

/** Exposed model ids only; `none` is the bootstrap's "no models" label. */
const MODEL_IDS: ReadonlySet<string> = new Set([...EXPOSED_MODEL_IDS, 'none']);

/** Which official CLI is spawned (src/spawn.ts ClaudeBinarySource) or `scripted`. */
const BRIDGE_PHASES: ReadonlySet<string> = new Set(['explicit', 'path', 'bundled', 'scripted']);

/** Version-shaped and bounded: dotted numeric components with a short suffix. */
const VERSION_SHAPE = /^(?:unknown|[0-9]{1,4}(?:\.[0-9A-Za-z-]{1,8}){1,3})$/;

const ENUM_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  apiKeySource: API_KEY_SOURCES,
  subtype: MESSAGE_SUBTYPES,
  terminalReason: TERMINAL_REASONS,
  kind: PROCESS_KINDS,
  outcome: TURN_OUTCOMES,
  model: MODEL_IDS,
  effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  phase: BRIDGE_PHASES,
};

/**
 * The fields whose value must come from a closed set (or the version shape)
 * rather than from the generic token shape check — rule 3 above. Exported so a
 * test can assert the set cannot silently shrink.
 *
 * These rules add "the value is a known enum / a version", not "the value is
 * safe": credential-shaped values are rejected on their own, for every field
 * (rule 2), including fields that are not listed here.
 */
export const LOG_CONSTRAINED_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(ENUM_FIELDS),
  'claudeCodeVersion',
]);

/** A field-specific rule: closed set membership, or the version shape. */
function fieldAllowsValue(key: string, value: string): boolean {
  if (key === 'claudeCodeVersion') return VERSION_SHAPE.test(value);
  const allowed = ENUM_FIELDS[key];
  if (allowed === undefined) return true;
  return allowed.has(value);
}

function isSafeValue(key: string, value: unknown): value is LogValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    // Rule 2 (shape + credential) applies to every field; rule 3 (closed set)
    // then applies to the fields that have one.
    return SAFE_TOKEN.test(value) && !looksLikeCredential(value) && fieldAllowsValue(key, value);
  }
  return false;
}

/** Drop any field whose name or value is not provably content-free. */
export function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (fields === undefined) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_ALLOWED_FIELDS.has(key)) continue;
    if (!isSafeValue(key, value)) continue;
    out[key] = value;
  }
  return out;
}

export function createLogger(write: (line: string) => void): Logger {
  return {
    log(event, fields) {
      // The event name is a written string like any other, so rule 2 guards it
      // exactly as it guards a field value.
      const safeEvent = SAFE_TOKEN.test(event) && !looksLikeCredential(event) ? event : 'invalid_event';
      const line = JSON.stringify({ ts: new Date().toISOString(), event: safeEvent, ...sanitizeFields(fields) });
      write(`${line}\n`);
    },
  };
}

/** Collects log lines in memory; used by tests to prove nothing leaked. */
export function createMemoryLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger(line => {
    lines.push(line);
  });
  return { logger, lines };
}

/** A logger that discards everything (fake-mode default in tests). */
export const nullLogger: Logger = { log: () => {} };
