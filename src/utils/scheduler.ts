export type CallSchedulerRetryPolicy = {
  readonly maxAttempts: number;
  /**
   * Return `null` to stop retrying and surface the original error.
   * `attempt` is 1-based and indicates the attempt that just failed.
   */
  readonly getDelayMs: (attempt: number, error: unknown) => number | null;
};

export type CallSchedulerOverloadClassifier = (error: unknown) => boolean;

export type CallSchedulerOptions = {
  /**
   * Hard upper bound for in-flight requests.
   */
  readonly maxParallelRequests?: number;
  /**
   * Starting concurrency before adaptive adjustments.
   */
  readonly initialParallelRequests?: number;
  /**
   * Number of consecutive successful calls needed to increase concurrency by one.
   */
  readonly increaseAfterConsecutiveSuccesses?: number;
  readonly minIntervalBetweenStartMs?: number;
  readonly startJitterMs?: number;
  readonly retry?: CallSchedulerRetryPolicy;
  readonly isOverloadError?: CallSchedulerOverloadClassifier;
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

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const maybe = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const candidates = [maybe.status, maybe.statusCode];
  for (const candidate of candidates) {
    if (typeof candidate === "number") {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  if (typeof maybe.code === "number") {
    return maybe.code;
  }
  return undefined;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    const code = typeof maybe.code === "string" ? maybe.code : "";
    const message = typeof maybe.message === "string" ? maybe.message : "";
    return `${code} ${message}`.trim().toLowerCase();
  }
  return "";
}

function defaultIsOverloadError(error: unknown): boolean {
  const status = getStatusCode(error);
  if (status === 429 || status === 503 || status === 529) {
    return true;
  }

  const text = getErrorText(error);
  if (!text) {
    return false;
  }
  return (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("resource exhausted") ||
    text.includes("resource_exhausted") ||
    text.includes("overload")
  );
}

export function createCallScheduler(options: CallSchedulerOptions = {}): CallScheduler {
  const maxParallelRequests = Math.max(1, Math.floor(options.maxParallelRequests ?? 3));
  const initialParallelRequests = Math.min(
    maxParallelRequests,
    Math.max(1, Math.floor(options.initialParallelRequests ?? Math.min(3, maxParallelRequests))),
  );
  const increaseAfterConsecutiveSuccesses = Math.max(
    1,
    Math.floor(options.increaseAfterConsecutiveSuccesses ?? 8),
  );
  const minIntervalBetweenStartMs = Math.max(0, Math.floor(options.minIntervalBetweenStartMs ?? 0));
  const startJitterMs = Math.max(0, Math.floor(options.startJitterMs ?? 0));
  const retryPolicy = options.retry;
  const isOverloadError = options.isOverloadError ?? defaultIsOverloadError;

  let activeCount = 0;
  let lastStartTime = 0;
  let currentParallelLimit = initialParallelRequests;
  let consecutiveSuccesses = 0;

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
      if (isOverloadError(error)) {
        consecutiveSuccesses = 0;
        currentParallelLimit = Math.max(1, Math.ceil(currentParallelLimit / 2));
      }
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
    while (activeCount < currentParallelLimit && queue.length > 0) {
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
          consecutiveSuccesses += 1;
          if (
            currentParallelLimit < maxParallelRequests &&
            consecutiveSuccesses >= increaseAfterConsecutiveSuccesses
          ) {
            currentParallelLimit += 1;
            consecutiveSuccesses = 0;
          }
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
