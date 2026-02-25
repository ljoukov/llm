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
  run: <T>(fn: () => Promise<T>, options?: CallSchedulerRunOptions) => Promise<T>;
};

export type CallSchedulerRunMetrics = {
  readonly enqueuedAtMs: number;
  readonly dequeuedAtMs: number;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly queueWaitMs: number;
  readonly schedulerDelayMs: number;
  readonly retryDelayMs: number;
  readonly attempts: number;
  readonly overloadCount: number;
};

export type CallSchedulerRunOptions = {
  readonly onSettled?: (metrics: CallSchedulerRunMetrics) => void;
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

  type RunState = {
    enqueuedAtMs: number;
    dequeuedAtMs: number;
    startedAtMs?: number;
    completedAtMs?: number;
    schedulerDelayMs: number;
    retryDelayMs: number;
    attempts: number;
    overloadCount: number;
  };

  async function attemptWithRetries<T>(
    fn: () => Promise<T>,
    attempt: number,
    state: RunState,
  ): Promise<T> {
    try {
      const spacingStartedAtMs = Date.now();
      await applyStartSpacing();
      const callStartedAtMs = Date.now();
      state.schedulerDelayMs += Math.max(0, callStartedAtMs - spacingStartedAtMs);
      if (state.startedAtMs === undefined) {
        state.startedAtMs = callStartedAtMs;
      }
      state.attempts = Math.max(state.attempts, attempt);
      return await fn();
    } catch (error: unknown) {
      if (isOverloadError(error)) {
        state.overloadCount += 1;
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
        state.retryDelayMs += normalizedDelay;
        await sleep(normalizedDelay);
      }
      return attemptWithRetries(fn, attempt + 1, state);
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

  function run<T>(fn: () => Promise<T>, runOptions: CallSchedulerRunOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const enqueuedAtMs = Date.now();
      const job: QueueJob = async () => {
        const dequeuedAtMs = Date.now();
        const state: RunState = {
          enqueuedAtMs,
          dequeuedAtMs,
          schedulerDelayMs: 0,
          retryDelayMs: 0,
          attempts: 0,
          overloadCount: 0,
        };
        try {
          const result = await attemptWithRetries(fn, 1, state);
          state.completedAtMs = Date.now();
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
          state.completedAtMs = Date.now();
          reject(toError(error));
        } finally {
          const startedAtMs = state.startedAtMs ?? state.dequeuedAtMs;
          const completedAtMs = state.completedAtMs ?? Date.now();
          const metrics: CallSchedulerRunMetrics = {
            enqueuedAtMs: state.enqueuedAtMs,
            dequeuedAtMs: state.dequeuedAtMs,
            startedAtMs,
            completedAtMs,
            queueWaitMs: Math.max(0, state.dequeuedAtMs - state.enqueuedAtMs),
            schedulerDelayMs: Math.max(0, state.schedulerDelayMs),
            retryDelayMs: Math.max(0, state.retryDelayMs),
            attempts: Math.max(1, state.attempts),
            overloadCount: Math.max(0, state.overloadCount),
          };
          try {
            runOptions.onSettled?.(metrics);
          } catch {
            // Metrics hooks must not interfere with scheduling behavior.
          }
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
