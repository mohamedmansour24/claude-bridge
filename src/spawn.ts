/**
 * Spawning the official claude binary, with process-GROUP control.
 *
 * The bridge provides `spawnClaudeCodeProcess` to the Agent SDK so that the
 * child lands in its own process group (`detached: true`) and every teardown
 * path can SIGTERM the whole group, then SIGKILL it after a grace period
 * (SPEC.md §"Lifecycle and failure": "kill the process GROUP (SIGTERM, then
 * SIGKILL after 5 s)").
 *
 * Invariant 3 is enforced here too: argv that would let Claude execute anything
 * (permission-bypass flags) is refused before spawn.
 *
 * Invariant 4 is enforced here as well: the CLI's stderr is piped into this
 * process and DISCARDED (see `drainStderr`) instead of being inherited, so no
 * CLI output — which can carry prompt or tool text — can ever reach the
 * bridge's own console stream or log.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type { Clock } from './clock.js';

export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  /** Piped, never inherited: `spawn()` drains it and throws the bytes away. */
  readonly stderr?: Readable | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

export interface ChildSpawnOptions {
  readonly cwd: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly detached: boolean;
  /**
   * stdin/stdout carry the SDK protocol; stderr is piped so the bridge can drop
   * it (`'inherit'` would put raw CLI output on the bridge's own stderr).
   */
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

export type ChildSpawn = (command: string, args: readonly string[], options: ChildSpawnOptions) => ChildLike;

export type GroupKill = (pid: number, signal: NodeJS.Signals) => boolean;

export interface SpawnedGroupChild {
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  /** SIGTERM the group now, SIGKILL it after the grace period. Idempotent. */
  terminate(): void;
}

export interface SpawnRecord {
  readonly pid: number | undefined;
  readonly signal: NodeJS.Signals;
  readonly scope: 'group' | 'child';
}

/** Prefix-matched, so the `--flag=value` spelling is refused too. */
const BYPASS_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];

/**
 * Refuse argv that would let Claude execute tools. Mirrors
 * docs/REFERENCE-NOTES.md §1 `assertClaudeSdkArgvSafe`.
 */
export function assertArgvSafe(args: readonly string[]): void {
  for (const argument of args) {
    for (const flag of BYPASS_FLAGS) {
      if (argument === flag || argument.startsWith(flag)) {
        throw new Error('claude-bridge: refused Claude Code permission-bypass argument');
      }
    }
    if (argument === '--permission-mode' || argument.startsWith('--permission-mode=')) {
      const value = argument.startsWith('--permission-mode=')
        ? argument.slice('--permission-mode='.length)
        : args[args.indexOf(argument) + 1];
      if (value !== 'default') {
        throw new Error('claude-bridge: refused a non-default Claude Code permission mode');
      }
    }
  }
}

function defaultChildSpawn(
  command: string,
  args: readonly string[],
  options: ChildSpawnOptions,
): ChildLike {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    detached: options.detached,
    stdio: [...options.stdio] as ['pipe', 'pipe', 'pipe'],
  }) as unknown as ChildLike;
}

function defaultGroupKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export interface GroupSpawnerDeps {
  readonly clock: Clock;
  readonly killGraceMs: number;
  readonly spawnChild?: ChildSpawn;
  readonly killGroup?: GroupKill;
}

/** Spawns Claude in its own process group and owns the whole-group kill ladder. */
export class GroupSpawner {
  private readonly spawnChild: ChildSpawn;
  private readonly killGroupImpl: GroupKill;
  readonly kills: SpawnRecord[] = [];
  readonly spawned: Array<{ command: string; args: readonly string[]; cwd: string | undefined }> = [];
  /** Every child handed out, in order (tests reach the child's piped streams here). */
  readonly children: ChildLike[] = [];
  /**
   * Bytes of CLI stderr consumed and thrown away. A count, never content: it
   * exists so a test can prove the drain ran without keeping a byte of it.
   */
  stderrBytes = 0;

  constructor(private readonly deps: GroupSpawnerDeps) {
    this.spawnChild = deps.spawnChild ?? defaultChildSpawn;
    this.killGroupImpl = deps.killGroup ?? defaultGroupKill;
  }

  spawn(options: {
    command: string;
    args: readonly string[];
    cwd?: string | undefined;
    env: Record<string, string | undefined>;
  }): SpawnedGroupChild {
    assertArgvSafe(options.args);
    this.spawned.push({ command: options.command, args: options.args, cwd: options.cwd });
    const child = this.spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.children.push(child);
    this.drainStderr(child);
    return this.manage(child);
  }

  /**
   * Invariant 4: the CLI's stderr is consumed here and DISCARDED. Nothing is
   * forwarded to this process's stdout/stderr and nothing is retained, so CLI
   * output can never become bridge output or a log line.
   */
  private drainStderr(child: ChildLike): void {
    const stderr = child.stderr;
    if (stderr === null || stderr === undefined) return;
    stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    });
    stderr.on('error', () => {
      // A pipe closing on a dying child is not an error worth surfacing.
    });
  }

  private manage(child: ChildLike): SpawnedGroupChild {
    const pid = child.pid;
    let terminating = false;
    let killTimer: { cancel(): void } | undefined;
    let hardKilled = false;

    const send = (signal: NodeJS.Signals): boolean => {
      if (pid === undefined) {
        this.kills.push({ pid, signal, scope: 'child' });
        return child.kill(signal);
      }
      const ok = this.killGroupImpl(pid, signal);
      this.kills.push({ pid, signal, scope: ok ? 'group' : 'child' });
      if (ok) return true;
      // The group is already gone (or never existed): fall back to the child.
      return child.kill(signal);
    };

    const clearTimer = (): void => {
      killTimer?.cancel();
      killTimer = undefined;
    };

    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      send('SIGTERM');
      killTimer = this.deps.clock.setTimeout(() => {
        hardKilled = true;
        send('SIGKILL');
      }, this.deps.killGraceMs);
      // The SDK (or the OS) may report exit before the grace expires.
      child.once('exit', () => {
        clearTimer();
      });
    };

    const handle: SpawnedGroupChild = {
      pid,
      get stdin() {
        return child.stdin;
      },
      get stdout() {
        return child.stdout;
      },
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill(signal: NodeJS.Signals) {
        if (terminating || hardKilled) return false;
        if (signal === 'SIGKILL') {
          hardKilled = true;
          terminating = true;
          clearTimer();
          send('SIGKILL');
          return true;
        }
        terminate();
        return true;
      },
      on: (event, listener) => child.on(event, listener),
      once: (event, listener) => child.once(event, listener),
      off: (event, listener) => child.off(event, listener),
      terminate,
    };
    return handle;
  }
}

/** Check executable-ness without reading anything. */
export function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveBinaryOptions {
  readonly explicit: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly exists?: (path: string) => boolean;
}

/**
 * Resolve the official claude binary. Invariant 1: the ONLY sources are an
 * explicit CLAUDE_BRIDGE_CLAUDE_PATH and PATH. The bridge never probes
 * ~/.claude, ~/.local/bin or any credential-adjacent location.
 *
 * An explicit value is honoured only when it names a real executable, so this
 * returns a path that can actually be spawned: an absolute path that exists, or
 * a bare name found in PATH (reported as the absolute candidate). `undefined`
 * means "no usable explicit value and no `claude` on PATH".
 */
export function resolveClaudeBinary(options: ResolveBinaryOptions): string | undefined {
  const exists = options.exists ?? isExecutableFile;
  const explicit = options.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (isAbsolute(explicit)) return exists(explicit) ? explicit : undefined;
    for (const dir of (options.env.PATH ?? '').split(delimiter)) {
      if (dir.length === 0) continue;
      const candidate = `${dir}/${explicit}`;
      if (exists(candidate)) return candidate;
    }
    return undefined;
  }
  for (const dir of (options.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = `${dir}/claude`;
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Which official `claude` CLI will actually be spawned, and the path the SDK is
 * told to use. SPEC.md invariant 1 forbids any second route to Claude, so the
 * three cases are exhaustive:
 *
 *  - `explicit` — `CLAUDE_BRIDGE_CLAUDE_PATH` / `--claude-path`, either absolute
 *                 and present or a bare name found on PATH (then reported as
 *                 the absolute candidate);
 *  - `path`     — no explicit value, and `claude` found on PATH;
 *  - `bundled`  — no explicit value and no PATH binary: `Options.pathToClaudeCodeExecutable`
 *                 is left unset and the Agent SDK spawns the official CLI it
 *                 ships itself. Still the official program, so the login rule
 *                 holds; the bridge does not refuse to start for this case.
 *
 * An explicit value that names nothing spawnable is NOT silently ignored: the
 * bridge refuses to start and names the value (see
 * `unusableExplicitPathError`), because falling through to a different official
 * CLI than the one the owner named would make this line a lie. The only values
 * treated as "unset" are an absent one and an empty/whitespace-only one.
 *
 * `--fake` needs no binary at all and never reaches here.
 */
export type ClaudeBinarySource = 'explicit' | 'path' | 'bundled';

export interface ResolvedClaudeBinary {
  readonly source: ClaudeBinarySource;
  /** Absolute path to spawn; undefined means "let the SDK use its bundle". */
  readonly path: string | undefined;
}

/** Startup refusal for an explicit binary value that cannot be spawned. */
export function unusableExplicitPathError(explicit: string): Error {
  return new Error(
    `claude-bridge: CLAUDE_BRIDGE_CLAUDE_PATH/--claude-path is set to ${JSON.stringify(explicit)}, which is not an executable file. ` +
      'Give an absolute path to the official claude program, or unset it to use `claude` on PATH (or the CLI bundled with the Agent SDK).',
  );
}

export function resolveClaudeBinarySource(options: ResolveBinaryOptions): ResolvedClaudeBinary {
  const explicit = options.explicit?.trim();
  const resolved = resolveClaudeBinary(options);
  if (resolved === undefined) {
    // Set but unusable: refuse rather than report `bundled` (which would be a
    // false statement about the configuration) or hand the raw value onward.
    if (explicit !== undefined && explicit.length > 0) throw unusableExplicitPathError(explicit);
    return { source: 'bundled', path: undefined };
  }
  return { source: explicit !== undefined && explicit.length > 0 ? 'explicit' : 'path', path: resolved };
}

/** The one line that states which official CLI this bridge will spawn. */
export function describeClaudeBinary(binary: ResolvedClaudeBinary): string {
  switch (binary.source) {
    case 'explicit':
      return `official claude at ${binary.path} (from CLAUDE_BRIDGE_CLAUDE_PATH)`;
    case 'path':
      return `official claude at ${binary.path} (found on PATH)`;
    case 'bundled':
      return 'official claude CLI bundled with @anthropic-ai/claude-agent-sdk (no claude on PATH and CLAUDE_BRIDGE_CLAUDE_PATH unset)';
  }
}
