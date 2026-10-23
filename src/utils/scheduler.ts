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
  setMaxParallelRequests: (maxParallelRequests: number) => void;
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
  readonly signal?: AbortSignal;
  readonly onSettled?: (metrics: CallSchedulerRunMetrics) => void;
};

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  let remainingMs = ms;
  do {
    throwIfAborted(signal);
    // Node reduces overflowing timeouts to 1ms. Preserve long provider retry
    // hints by waiting in valid timer-sized slices instead of retrying early.
    const sliceMs = Math.min(remainingMs, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason);
      };
      const timer = setTimeout(finish, sliceMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    remainingMs -= sliceMs;
  } while (remainingMs > 0);
}

function waitForSpacingTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    return previous;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
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
  let maxParallelRequests = Math.max(1, Math.floor(options.maxParallelRequests ?? 3));
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

  async function applyStartSpacing(signal?: AbortSignal): Promise<void> {
    const previous = startSpacingChain;
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An aborted waiter may release its own turn immediately, but successors must
    // still wait for its predecessor to finish spacing.
    startSpacingChain = previous.then(() => turn);
    try {
      await waitForSpacingTurn(previous, signal);
      throwIfAborted(signal);
      if (lastStartTime > 0 && minIntervalBetweenStartMs > 0) {
        const earliestNext = lastStartTime + minIntervalBetweenStartMs;
        const wait = Math.max(0, earliestNext - Date.now());
        if (wait > 0) {
          await sleep(wait, signal);
        }
      }
      if (startJitterMs > 0) {
        await sleep(Math.floor(Math.random() * (startJitterMs + 1)), signal);
      }
      throwIfAborted(signal);
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
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      throwIfAborted(signal);
      const spacingStartedAtMs = Date.now();
      try {
        await applyStartSpacing(signal);
      } finally {
        state.schedulerDelayMs += Math.max(0, Date.now() - spacingStartedAtMs);
      }
      throwIfAborted(signal);
      const callStartedAtMs = Date.now();
      if (state.startedAtMs === undefined) {
        state.startedAtMs = callStartedAtMs;
      }
      state.attempts = Math.max(state.attempts, attempt);
      return await fn();
    } catch (error: unknown) {
      throwIfAborted(signal);
      if (isOverloadError(error)) {
        state.overloadCount += 1;
        consecutiveSuccesses = 0;
        currentParallelLimit = Math.max(1, Math.ceil(currentParallelLimit / 2));
      }
      const err = toError(error);
      if (!retryPolicy || attempt >= retryPolicy.maxAttempts) {
        throw err;
      }
      const delay = retryPolicy.getDelayMs(attempt, error);
      if (delay === null || !Number.isFinite(delay) || delay < 0) {
        throw err;
      }
      if (delay > 0) {
        const delayStartedAtMs = Date.now();
        try {
          await sleep(delay, signal);
        } finally {
          state.retryDelayMs += Math.max(0, Date.now() - delayStartedAtMs);
        }
      }
      return attemptWithRetries(fn, attempt + 1, state, signal);
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
      let queued = true;
      const notifySettled = (state: RunState) => {
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
          attempts: Math.max(0, state.attempts),
          overloadCount: Math.max(0, state.overloadCount),
        };
        try {
          runOptions.onSettled?.(metrics);
        } catch {
          // Metrics hooks must not interfere with scheduling behavior.
        }
      };
      const onQueuedAbort = () => {
        if (!queued) {
          return;
        }
        queued = false;
        runOptions.signal?.removeEventListener("abort", onQueuedAbort);
        const index = queue.indexOf(job);
        if (index !== -1) {
          queue.splice(index, 1);
        }
        const completedAtMs = Date.now();
        reject(toError(runOptions.signal?.reason));
        notifySettled({
          enqueuedAtMs,
          dequeuedAtMs: completedAtMs,
          completedAtMs,
          schedulerDelayMs: 0,
          retryDelayMs: 0,
          attempts: 0,
          overloadCount: 0,
        });
        queueMicrotask(drainQueue);
      };
      const job: QueueJob = async () => {
        queued = false;
        runOptions.signal?.removeEventListener("abort", onQueuedAbort);
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
          const result = await attemptWithRetries(fn, 1, state, runOptions.signal);
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
          notifySettled(state);
          activeCount -= 1;
          queueMicrotask(drainQueue);
        }
      };
      if (runOptions.signal?.aborted) {
        onQueuedAbort();
        return;
      }
      queue.push(job);
      runOptions.signal?.addEventListener("abort", onQueuedAbort, { once: true });
      drainQueue();
    });
  }

  function setMaxParallelRequests(requestedLimit: number): void {
    const nextLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 1;
    if (nextLimit === maxParallelRequests) {
      return;
    }
    maxParallelRequests = nextLimit;
    currentParallelLimit = nextLimit;
    consecutiveSuccesses = 0;
    // Existing callbacks retain their slots when reducing the limit. Increasing
    // it can immediately admit jobs already waiting in this same queue.
    drainQueue();
  }

  return { run, setMaxParallelRequests };
}
