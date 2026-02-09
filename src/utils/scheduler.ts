export type CallSchedulerRetryPolicy = {
  readonly maxAttempts: number;
  /**
   * Return `null` to stop retrying and surface the original error.
   * `attempt` is 1-based and indicates the attempt that just failed.
   */
  readonly getDelayMs: (attempt: number, error: unknown) => number | null;
};

export type CallSchedulerOptions = {
  readonly maxParallelRequests?: number;
  readonly minIntervalBetweenStartMs?: number;
  readonly startJitterMs?: number;
  readonly retry?: CallSchedulerRetryPolicy;
};

export type CallScheduler = {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  return new Error("Unknown error");
}

export function createCallScheduler(options: CallSchedulerOptions = {}): CallScheduler {
  const maxParallelRequests = Math.max(1, Math.floor(options.maxParallelRequests ?? 3));
  const minIntervalBetweenStartMs = Math.max(0, Math.floor(options.minIntervalBetweenStartMs ?? 0));
  const startJitterMs = Math.max(0, Math.floor(options.startJitterMs ?? 0));
  const retryPolicy = options.retry;

  let activeCount = 0;
  let lastStartTime = 0;

  // Serializes start-spacing to avoid concurrent jobs racing on lastStartTime.
  let startSpacingChain: Promise<void> = Promise.resolve();

  type QueueJob = () => Promise<void>;
  const queue: QueueJob[] = [];

  async function applyStartSpacing(): Promise<void> {
    const previous = startSpacingChain;
    let release: (() => void) | undefined;
    startSpacingChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (lastStartTime > 0 && minIntervalBetweenStartMs > 0) {
        const earliestNext = lastStartTime + minIntervalBetweenStartMs;
        const wait = Math.max(0, earliestNext - Date.now());
        if (wait > 0) {
          await sleep(wait);
        }
      }
      if (startJitterMs > 0) {
        await sleep(Math.floor(Math.random() * (startJitterMs + 1)));
      }
      lastStartTime = Date.now();
    } finally {
      release?.();
    }
  }

  async function attemptWithRetries<T>(fn: () => Promise<T>, attempt: number): Promise<T> {
    try {
      await applyStartSpacing();
      return await fn();
    } catch (error: unknown) {
      const err = toError(error);
      if (!retryPolicy || attempt >= retryPolicy.maxAttempts) {
        throw err;
      }
      let delay = retryPolicy.getDelayMs(attempt, error);
      if (delay === null) {
        throw err;
      }
      if (!Number.isFinite(delay)) {
        delay = 0;
      }
      const normalizedDelay = Math.max(0, delay);
      if (normalizedDelay > 0) {
        await sleep(normalizedDelay);
      }
      return attemptWithRetries(fn, attempt + 1);
    }
  }

  function drainQueue(): void {
    while (activeCount < maxParallelRequests && queue.length > 0) {
      const task = queue.shift();
      if (!task) {
        continue;
      }
      activeCount += 1;
      void task();
    }
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: QueueJob = async () => {
        try {
          const result = await attemptWithRetries(fn, 1);
          resolve(result);
        } catch (error: unknown) {
          reject(toError(error));
        } finally {
          activeCount -= 1;
          queueMicrotask(drainQueue);
        }
      };
      queue.push(job);
      drainQueue();
    });
  }

  return { run };
}
