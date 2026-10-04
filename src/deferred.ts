/** A promise plus its resolvers, created before the consumer exists. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = value => {
      settled = true;
      res(value);
    };
    reject = error => {
      settled = true;
      rej(error);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}
