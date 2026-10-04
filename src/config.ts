/**
 * Startup configuration. Everything the owner can tune lives here, with the
 * defaults from SPEC.md §"Lifecycle and failure".
 *
 * Invariant 4: the bridge refuses to start without CLAUDE_BRIDGE_KEY (>= 32
 * characters). The key is read from the environment only — never generated,
 * printed, logged or written anywhere by the bridge.
 */

import { DEFAULT_EFFORT, effortEnvName, parseConfiguredEffort } from './effort.js';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_AUX_MODEL, EXPOSED_MODEL_IDS, isExposedModel, type ExposedModelId } from './models.js';

export const MIN_KEY_LENGTH = 32;
export const DEFAULT_PORT = 8765;

export interface BridgeConfig {
  /** Bearer key required on every request. Never logged. */
  readonly key: string;
  readonly port: number;
  readonly maxProcs: number;
  /** How long a parked tool call may wait for Hermes before its process is torn down. */
  readonly parkedCallTimeoutMs: number;
  readonly idleProcessTimeoutMs: number;
  readonly requestWallClockMs: number;
  readonly stallWatchdogMs: number;
  /** Quiet window after which a tool-call turn is considered fully emitted. */
  readonly toolSettleMs: number;
  readonly mcpClaimBarrierMs: number;
  readonly killGraceMs: number;
  readonly maxTurns: number;
  readonly auxModel: ExposedModelId;
  /** Effort used when a request names none (CLAUDE_BRIDGE_DEFAULT_EFFORT, default medium). */
  readonly defaultEffort: EffortLevel;
  /** Per-model default effort (CLAUDE_BRIDGE_EFFORT_<MODEL_ID>), beats defaultEffort. */
  readonly modelEfforts: Readonly<Record<string, EffortLevel>>;
  /** Explicit path to the official claude binary; undefined = resolve on PATH. */
  readonly claudePath: string | undefined;
  /** Directory mkdtemp bases the per-process private cwd on (tests override). */
  readonly tempBase: string | undefined;
  readonly fake: boolean;
  readonly exposedModels: readonly string[];
  /** Hard cap on a request body's size, enforced while reading it (never buffered past). */
  readonly maxBodyBytes: number;
}

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ConfigSources {
  env: Record<string, string | undefined>;
  argv: readonly string[];
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`claude-bridge: ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function loadConfig(sources: ConfigSources): BridgeConfig {
  const { env, argv } = sources;

  const key = env.CLAUDE_BRIDGE_KEY;
  if (key === undefined || key.length < MIN_KEY_LENGTH) {
    throw new Error(
      `claude-bridge: CLAUDE_BRIDGE_KEY must be set and at least ${MIN_KEY_LENGTH} characters long (set it yourself; the bridge never generates one).`,
    );
  }

  let port = parsePositiveInt(env.CLAUDE_BRIDGE_PORT, DEFAULT_PORT, 'CLAUDE_BRIDGE_PORT');
  let fake = false;
  let claudePath = env.CLAUDE_BRIDGE_CLAUDE_PATH?.trim() || undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fake') {
      fake = true;
    } else if (arg === '--port') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error('claude-bridge: --port requires a value');
      port = parsePositiveInt(raw, DEFAULT_PORT, '--port');
      i += 1;
    } else if (arg?.startsWith('--port=')) {
      port = parsePositiveInt(arg.slice('--port='.length), DEFAULT_PORT, '--port');
    } else if (arg === '--claude-path') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error('claude-bridge: --claude-path requires a value');
      claudePath = raw;
      i += 1;
    } else if (arg?.startsWith('--claude-path=')) {
      claudePath = arg.slice('--claude-path='.length);
    }
  }

  const auxRaw = env.CLAUDE_BRIDGE_AUX_MODEL?.trim() || DEFAULT_AUX_MODEL;
  if (!isExposedModel(auxRaw)) {
    throw new Error(
      `claude-bridge: CLAUDE_BRIDGE_AUX_MODEL must be one of ${EXPOSED_MODEL_IDS.join(', ')}, got ${JSON.stringify(auxRaw)}`,
    );
  }

  const modelEfforts: Record<string, EffortLevel> = {};
  for (const id of EXPOSED_MODEL_IDS) {
    const name = effortEnvName(id);
    const level = parseConfiguredEffort(env[name], name);
    if (level !== undefined) modelEfforts[id] = level;
  }
  const defaultEffort =
    parseConfiguredEffort(env.CLAUDE_BRIDGE_DEFAULT_EFFORT, 'CLAUDE_BRIDGE_DEFAULT_EFFORT') ?? DEFAULT_EFFORT;

  if (port === 0) throw new Error('claude-bridge: --port must be a positive port number');

  return {
    key,
    port,
    maxProcs: parsePositiveInt(env.CLAUDE_BRIDGE_MAX_PROCS, 4, 'CLAUDE_BRIDGE_MAX_PROCS'),
    parkedCallTimeoutMs: parsePositiveInt(env.CLAUDE_BRIDGE_PARKED_TIMEOUT_MS, 30 * 60 * 1000, 'CLAUDE_BRIDGE_PARKED_TIMEOUT_MS'),
    idleProcessTimeoutMs: parsePositiveInt(env.CLAUDE_BRIDGE_IDLE_TIMEOUT_MS, 10 * 60 * 1000, 'CLAUDE_BRIDGE_IDLE_TIMEOUT_MS'),
    requestWallClockMs: parsePositiveInt(env.CLAUDE_BRIDGE_REQUEST_TIMEOUT_MS, 20 * 60 * 1000, 'CLAUDE_BRIDGE_REQUEST_TIMEOUT_MS'),
    stallWatchdogMs: parsePositiveInt(env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS, 90 * 1000, 'CLAUDE_BRIDGE_STALL_TIMEOUT_MS'),
    toolSettleMs: parsePositiveInt(env.CLAUDE_BRIDGE_TOOL_SETTLE_MS, 250, 'CLAUDE_BRIDGE_TOOL_SETTLE_MS'),
    mcpClaimBarrierMs: parsePositiveInt(env.CLAUDE_BRIDGE_MCP_BARRIER_MS, 2000, 'CLAUDE_BRIDGE_MCP_BARRIER_MS'),
    killGraceMs: parsePositiveInt(env.CLAUDE_BRIDGE_KILL_GRACE_MS, 5000, 'CLAUDE_BRIDGE_KILL_GRACE_MS'),
    maxTurns: parsePositiveInt(env.CLAUDE_BRIDGE_MAX_TURNS, 256, 'CLAUDE_BRIDGE_MAX_TURNS'),
    auxModel: auxRaw,
    defaultEffort,
    modelEfforts,
    claudePath,
    tempBase: env.CLAUDE_BRIDGE_TEMP_BASE?.trim() || undefined,
    fake,
    exposedModels: EXPOSED_MODEL_IDS,
    maxBodyBytes: parsePositiveInt(env.CLAUDE_BRIDGE_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 'CLAUDE_BRIDGE_MAX_BODY_BYTES'),
  };
}
