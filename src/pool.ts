/**
 * The live-process registry.
 *
 * Capacity is the hard cap from SPEC.md: more than CLAUDE_BRIDGE_MAX_PROCS live
 * Claude processes -> 429 with Retry-After (never a silent kill of a
 * conversation someone is waiting on).
 */

import type { BridgeConfig } from './config.js';
import { maxProcsError, notConfiguredError } from './errors.js';
import type { Logger } from './log.js';
import type { ClaudeProcess, ProcessInit, TurnSink } from './process.js';
import type { Clock } from './clock.js';

export interface PoolDeps {
  readonly config: BridgeConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly create: (init: ProcessInit, sink: TurnSink) => Promise<ClaudeProcess>;
}

export type ResultLookup =
  /** `callIds` is precisely this process's parked id set — resume it. */
  | { readonly kind: 'found'; readonly process: ClaudeProcess }
  /** Some of `callIds` belong to this process, but not exactly its parked set. */
  | { readonly kind: 'partial'; readonly process: ClaudeProcess }
  /** No live process holds any of `callIds`. */
  | { readonly kind: 'none' };

/**
 * True only when the request's ids are precisely the process's parked ids, each
 * exactly once. A subset, a superset, an unknown id or a repeated id is not a
 * match: SPEC.md requires "all ids of one assistant turn" to come back before a
 * resume, so the caller refuses the request instead of resuming it — and
 * refusing must leave the parked process (and its deadline) untouched.
 */
export function holdsExactlyParkedSet(process: ClaudeProcess, callIds: readonly string[]): boolean {
  const parked = process.parkedCallIds;
  if (callIds.length !== parked.length) return false;
  const wanted = new Map<string, number>();
  for (const id of callIds) wanted.set(id, (wanted.get(id) ?? 0) + 1);
  for (const id of parked) {
    if (wanted.get(id) !== 1) return false;
  }
  return true;
}

export class ProcessPool {
  private readonly processes = new Map<string, ClaudeProcess>();
  private counter = 0;

  constructor(private readonly deps: PoolDeps) {}

  get size(): number {
    return this.processes.size;
  }

  snapshot(): Array<{ id: string; state: string; parkedCount: number; correlationKey: string | undefined }> {
    return [...this.processes.values()].map(process => ({
      id: process.id,
      state: process.state,
      parkedCount: process.parkedCount,
      correlationKey: process.correlationKey,
    }));
  }

  /** Spawn a new process, honouring the hard cap. */
  async create(init: Omit<ProcessInit, 'id'>, sink: TurnSink): Promise<ClaudeProcess> {
    this.reap();
    if (this.processes.size >= this.deps.config.maxProcs) {
      if (!this.evictIdle()) {
        this.deps.logger.log('max_procs_refused', {
          procCount: this.processes.size,
          count: this.deps.config.maxProcs,
          code: 'CLAUDE_BRIDGE_MAX_PROCS',
        });
        throw maxProcsError(this.deps.config.maxProcs, 5);
      }
    }
    this.counter += 1;
    const id = `p${this.counter}`;
    const process = await this.deps.create({ ...init, id }, sink);
    this.processes.set(id, process);
    return process;
  }

  /**
   * Under pressure, drop the least-recently-active process that is holding
   * nothing for anyone (no parked call, no live turn). A process waiting on
   * Hermes is never taken: that would break a conversation in flight.
   */
  private evictIdle(): boolean {
    let victim: ClaudeProcess | undefined;
    for (const process of this.processes.values()) {
      if (process.busy) continue;
      if (victim === undefined || process.lastActivity < victim.lastActivity) victim = process;
    }
    if (victim === undefined) return false;
    this.processes.delete(victim.id);
    void victim.dispose('capacity-evict');
    this.deps.logger.log('process_evicted', { procId: victim.id, code: 'capacity', procCount: this.processes.size });
    return true;
  }

  /**
   * The live process whose parked call ids are EXACTLY the ids this request
   * carries, if any.
   *
   * The comparison is a multiset comparison, not a count of matches: a request
   * that repeats an id (`[A,A]` against a turn that parked `{A,B}`), drops one
   * (`[A]`), adds an unknown one (`[A,B,X]`) or mixes ids from two parked turns
   * is a `partial` mismatch — never a match. Counting matches instead of
   * comparing sets made `[A,A]` look like "found", which then threw a 500 out of
   * the resume path and tore down the live parked process.
   */
  lookupForResults(callIds: readonly string[]): ResultLookup {
    let partial: ClaudeProcess | undefined;
    for (const process of this.processes.values()) {
      if (!callIds.some(id => process.hasParkedCall(id))) continue;
      if (holdsExactlyParkedSet(process, callIds)) return { kind: 'found', process };
      partial = partial ?? process;
    }
    return partial === undefined ? { kind: 'none' } : { kind: 'partial', process: partial };
  }

  /**
   * The idle process this request continues: same system prompt, same tool
   * list, and a message list that literally begins with the one it last served.
   */
  lookupForContinuation(continues: (process: ClaudeProcess) => boolean): ClaudeProcess | undefined {
    for (const process of this.processes.values()) {
      if (process.state !== 'idle') continue;
      if (process.correlationKey === undefined) continue;
      if (continues(process)) return process;
    }
    return undefined;
  }

  /** Drop idle processes past the idle timeout. */
  reap(): void {
    const now = this.deps.clock.now();
    for (const [id, process] of this.processes) {
      if (process.busy) continue;
      if (now - process.lastActivity < this.deps.config.idleProcessTimeoutMs) continue;
      this.processes.delete(id);
      void process.dispose('idle-timeout');
      this.deps.logger.log('process_reaped', { procId: id, code: 'idle-timeout', procCount: this.processes.size });
    }
  }

  /** Forget a process and tear it down when it holds nothing for Hermes. */
  async release(process: ClaudeProcess): Promise<void> {
    this.processes.delete(process.id);
    if (process.parkedCount > 0) return;
    await process.dispose('turn-complete');
  }

  /** Forget without disposing (used when a stranded process is handed to a cold start). */
  forget(process: ClaudeProcess): void {
    this.processes.delete(process.id);
  }

  async shutdownAll(): Promise<void> {
    const all = [...this.processes.values()];
    this.processes.clear();
    await Promise.all(all.map(process => process.dispose('shutdown')));
  }

  /** Guard for the `--fake`/real bootstrap: refuse to run with no Claude. */
  requireClaudeBinary(available: boolean): void {
    if (!available) {
      throw notConfiguredError(
        'claude-bridge: no official claude binary found on PATH and CLAUDE_BRIDGE_CLAUDE_PATH is unset',
      );
    }
  }
}
