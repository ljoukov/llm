export type AsyncQueue<T> = {
  push: (value: T) => void;
  close: () => void;
  fail: (error: Error) => void;
  iterable: AsyncIterable<T>;
};

export function createAsyncQueue<T>(): AsyncQueue<T> {
  let closed = false;
  let error: Error | null = null;
  const values: T[] = [];
  let pending: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (err: Error) => void;
  } | null = null;

  const push = (value: T) => {
    if (closed || error) {
      return;
    }
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve({ value, done: false });
      return;
    }
    values.push(value);
  };

  const close = () => {
    if (closed || error) {
      return;
    }
    closed = true;
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve({ value: undefined as never, done: true });
    }
  };

  const fail = (err: Error) => {
    if (closed || error) {
      return;
    }
    error = err;
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(err);
    }
  };

  async function* iterator(): AsyncIterable<T> {
    while (true) {
      if (error) {
        throw error;
      }
      if (values.length > 0) {
        yield values.shift() as T;
        continue;
      }
      if (closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        pending = { resolve, reject };
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  return { push, close, fail, iterable: iterator() };
}
