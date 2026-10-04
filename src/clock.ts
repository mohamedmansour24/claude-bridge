/**
 * Injectable time. Everything in the bridge that waits or measures uses this,
 * so tests can run timeouts deterministically instead of sleeping.
 */

export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
}

/** Real wall-clock implementation. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // Never let a bridge timer hold the process open on shutdown.
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * Sleep on an injectable clock. Returns a canceller alongside the promise so a
 * caller (a turn, a request) can abandon the wait without leaking a timer.
 */
export function sleepOn(clock: Clock, ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: TimerHandle | undefined;
  let settle!: () => void;
  const promise = new Promise<void>(resolve => {
    settle = resolve;
    handle = clock.setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      handle?.cancel();
      settle();
    },
  };
}
