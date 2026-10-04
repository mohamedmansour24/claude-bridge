/**
 * PARKED calls and the per-turn tool-call slots.
 *
 * A tool call Claude makes is never executed here. The MCP handler that Claude
 * Code is waiting on is parked (its promise kept pending) until Hermes posts the
 * tool results for the minted `call_<random>` ids in a following request. That
 * request un-parks exactly those calls, and Claude continues in the SAME
 * process (SPEC.md §"How one request maps onto Claude").
 */

import { createDeferred, type Deferred } from './deferred.js';

export interface ToolResultPayload {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ParkedCallInit {
  readonly callId: string;
  readonly key: string;
  readonly mcpName: string;
  readonly openaiName: string;
  readonly argsJson: string;
}

export interface ParkedCall {
  readonly callId: string;
  readonly key: string;
  readonly mcpName: string;
  readonly openaiName: string;
  readonly argsJson: string;
  readonly promise: Promise<ToolResultPayload>;
  readonly settled: boolean;
  resolve(payload: ToolResultPayload): boolean;
  reject(error: unknown): boolean;
}

export class ParkedCalls {
  private readonly calls = new Map<string, ParkedCall>();

  create(init: ParkedCallInit): ParkedCall {
    const deferred: Deferred<ToolResultPayload> = createDeferred<ToolResultPayload>();
    // Nobody may be awaiting yet (the caller always awaits, but a rejection on
    // a process teardown path must never surface as an unhandled rejection).
    deferred.promise.catch(() => {});
    let settled = false;
    const call: ParkedCall = {
      callId: init.callId,
      key: init.key,
      mcpName: init.mcpName,
      openaiName: init.openaiName,
      argsJson: init.argsJson,
      promise: deferred.promise,
      get settled() {
        return settled;
      },
      resolve: payload => {
        if (settled) return false;
        settled = true;
        deferred.resolve(payload);
        return true;
      },
      reject: error => {
        if (settled) return false;
        settled = true;
        deferred.reject(error);
        return true;
      },
    };
    this.calls.set(init.callId, call);
    return call;
  }

  get(callId: string): ParkedCall | undefined {
    return this.calls.get(callId);
  }

  has(callId: string): boolean {
    return this.calls.has(callId);
  }

  hasAll(callIds: readonly string[]): boolean {
    return callIds.length > 0 && callIds.every(id => this.calls.has(id));
  }

  get size(): number {
    return this.calls.size;
  }

  ids(): string[] {
    return [...this.calls.keys()];
  }

  /** Un-park exactly the listed calls. Unknown ids are reported, never guessed. */
  resolveMany(
    pairs: ReadonlyArray<{ id: string; payload: ToolResultPayload }>,
  ): { resolved: string[]; unknown: string[] } {
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const { id, payload } of pairs) {
      const call = this.calls.get(id);
      if (call === undefined) {
        unknown.push(id);
        continue;
      }
      if (call.resolve(payload)) resolved.push(id);
      this.calls.delete(id);
    }
    return { resolved, unknown };
  }

  rejectAll(error: unknown): void {
    for (const [id, call] of this.calls) {
      call.reject(error);
      this.calls.delete(id);
    }
  }
}

/**
 * One turn's tool-call slots. A slot is created either from an observed
 * `tool_use` content block or from an MCP handler dispatch (whichever the CLI
 * produces first), and is the single place a Claude tool call is given its
 * Hermes-facing identity.
 */
export interface CallSlot {
  readonly key: string;
  readonly wireIndex: number;
  readonly callId: string;
  readonly mcpName: string;
  readonly openaiName: string;
  argsJson: string;
  /** `content_block_stop` observed (or the block arrived whole in an assistant message). */
  closed: boolean;
  /** The `tool_calls` start delta has been emitted to the client. */
  started: boolean;
  /** Parked: an MCP handler is waiting on this call. */
  parked: boolean;
}

export class TurnSlots {
  private readonly slots: CallSlot[] = [];
  private readonly byKey = new Map<string, CallSlot>();
  private readonly byCallId = new Map<string, CallSlot>();
  private index = 0;

  constructor(private readonly mintId: () => string) {}

  /** Get or create the slot for a Claude tool-use id. */
  forKey(key: string, mcpName: string, openaiName: string): CallSlot {
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    return this.create(key, mcpName, openaiName);
  }

  /** Create a slot for a call Claude made that we have not seen a block for. */
  forUnknownBlock(mcpName: string, openaiName: string): CallSlot {
    return this.create(`synthetic_${this.index}`, mcpName, openaiName);
  }

  private create(key: string, mcpName: string, openaiName: string): CallSlot {
    const slot: CallSlot = {
      key,
      wireIndex: this.index,
      callId: this.mintId(),
      mcpName,
      openaiName,
      argsJson: '',
      closed: false,
      started: false,
      parked: false,
    };
    this.index += 1;
    this.slots.push(slot);
    this.byKey.set(key, slot);
    this.byCallId.set(slot.callId, slot);
    return slot;
  }

  byAnthropicId(key: string): CallSlot | undefined {
    return this.byKey.get(key);
  }

  byMintedId(callId: string): CallSlot | undefined {
    return this.byCallId.get(callId);
  }

  all(): readonly CallSlot[] {
    return this.slots;
  }

  get size(): number {
    return this.slots.length;
  }
}
