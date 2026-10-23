import { AsyncLocalStorage } from "node:async_hooks";

import { getRuntimeSingleton } from "./runtimeSingleton.js";

const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_MODEL_KEYS = 256;

export type RetryFetchMetrics = {
  retryCount: number;
  retryDelayMs: number;
  overloadCount: number;
};

export type RetryFetchEvent = {
  /** The next request attempt, starting at 2. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: "status" | "network";
  readonly status?: number;
  readonly model?: string;
  readonly scope?: string;
};

export type RetryingFetchOptions = {
  /** Includes the initial request. */
  readonly maxAttempts?: number;
  readonly scope?: string;
  readonly onRetry?: (event: RetryFetchEvent) => void;
};

const retryMetrics = new AsyncLocalStorage<RetryFetchMetrics>();

export async function withRetryFetchMetrics<T>(
  fn: () => Promise<T>,
  onSettled: (metrics: RetryFetchMetrics) => void,
): Promise<T> {
  const metrics: RetryFetchMetrics = { retryCount: 0, retryDelayMs: 0, overloadCount: 0 };
  return retryMetrics.run(metrics, async () => {
    try {
      return await fn();
    } finally {
      try {
        onSettled({ ...metrics });
      } catch {
        // Observability must not replace a model response or the original error.
      }
    }
  });
}

type Cooldown = { until: number; nextAdmission: number };

const sharedCooldowns = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.retryFetchCooldowns"),
  () => new Map<string, Cooldown>(),
);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

async function waitUntil(deadline: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  // Long Retry-After values are minimums, not a reason to overflow Node's timers
  // (which would turn a multi-day wait into an immediate retry).
  while (deadline > Date.now()) {
    const delay = Math.max(1, Math.min(Math.ceil(deadline - Date.now()), MAX_TIMER_MS));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      function onAbort() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(signal ? abortReason(signal) : new DOMException("Aborted", "AbortError"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
    throwIfAborted(signal);
  }
}

function parseNonnegativeNumber(value: string | null, multiplier: number): number | undefined {
  if (value === null || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    return undefined;
  }
  const ms = Number(value.trim()) * multiplier;
  return Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER - Date.now() - 1_000
    ? ms
    : undefined;
}

function serverDelayMs(headers: Headers): number | undefined {
  const milliseconds = parseNonnegativeNumber(headers.get("retry-after-ms"), 1);
  if (milliseconds !== undefined) {
    return milliseconds;
  }
  const value = headers.get("retry-after")?.trim() ?? null;
  const seconds = parseNonnegativeNumber(value, 1_000);
  if (seconds !== undefined) {
    return seconds;
  }
  // Date.parse also accepts malformed numeric values such as "-1" as dates.
  // Only pass the three HTTP-date forms through to it.
  if (
    value &&
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/i.test(
      value,
    )
  ) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return Math.max(0, timestamp - Date.now());
    }
  }
  return undefined;
}

function requestInput(input: Parameters<typeof fetch>[0]): Request | undefined {
  // An SDK may supply an undici Request rather than the global constructor.
  // Do not mistake its one-shot body for a replayable, bodyless URL request.
  return typeof input === "object" && "url" in input && "body" in input && "signal" in input
    ? (input as Request)
    : undefined;
}

function isReplayable(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (body === undefined || body === null) {
    return requestInput(input)?.body == null;
  }
  return (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function modelFromBody(body: RequestInit["body"]): string | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "model" in parsed) {
      const model = parsed.model;
      return typeof model === "string" && model.length <= 512 ? model : undefined;
    }
  } catch {
    // Bodies that are not JSON can still be sent; they share the default scope.
  }
  return undefined;
}

function retryableStatus(response: Response): boolean {
  if (response.headers.get("x-should-retry")?.trim().toLowerCase() === "false") {
    return false;
  }
  return (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    (response.status >= 500 && response.status < 600)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Retries only failures before returning an HTTP response to its consumer.
 * A successful streaming response is returned once; stream reads and tools are
 * never replayed here. An explicit scope shares per-endpoint/model cooldowns
 * across wrappers; omit it for wrapper-local cooldowns. Credentials are never
 * used as cache keys or retained in cooldown state.
 */
export function createRetryingFetch(
  fetchImpl: typeof fetch,
  options: RetryingFetchOptions = {},
): typeof fetch {
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.min(10, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)))
    : DEFAULT_MAX_ATTEMPTS;
  const cooldowns = options.scope ? sharedCooldowns : new Map<string, Cooldown>();

  async function waitForAdmission(
    key: string,
    notBefore: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let deadline = notBefore;
    while (true) {
      throwIfAborted(signal);
      const cooldown = cooldowns.get(key);
      const now = Date.now();
      if (cooldown && (cooldown.until > now || cooldown.nextAdmission > now)) {
        deadline = Math.max(deadline, cooldown.until, cooldown.nextAdmission);
        // Reserve staggered admissions so concurrent 429s do not all retry at
        // the same instant, even when the server sends an identical deadline.
        cooldown.nextAdmission = deadline + 25 + Math.random() * 75;
      }
      await waitUntil(deadline, signal);
      const latest = cooldowns.get(key);
      if (!latest || latest.until <= deadline) {
        return;
      }
    }
  }

  return async (input, init) => {
    const signal =
      init?.signal !== undefined ? (init.signal ?? undefined) : requestInput(input)?.signal;
    const replayable = isReplayable(input, init);
    const model = modelFromBody(init?.body);
    let origin = "";
    try {
      origin = new URL(requestInput(input)?.url ?? input.toString()).origin;
    } catch {
      // Let fetch report invalid URLs; retain no full URLs or query strings.
    }
    const key = JSON.stringify([options.scope ?? "", origin, model ?? ""]);
    const metrics = retryMetrics.getStore();
    const existingCooldown = cooldowns.get(key);
    const admissionStarted = Date.now();
    if (
      existingCooldown &&
      (existingCooldown.until > admissionStarted ||
        existingCooldown.nextAdmission > admissionStarted)
    ) {
      try {
        await waitForAdmission(key, 0, signal);
      } finally {
        if (metrics) {
          metrics.retryDelayMs += Math.max(0, Date.now() - admissionStarted);
        }
      }
    }

    for (let attempt = 1; ; attempt += 1) {
      throwIfAborted(signal);
      if (attempt > 1 && metrics) {
        metrics.retryCount += 1;
      }
      let response: Response | undefined;
      try {
        response = await fetchImpl(input, init);
      } catch (error) {
        if (signal?.aborted || isAbortError(error) || !replayable || attempt >= maxAttempts) {
          throw error;
        }
      }
      if (response && (!replayable || attempt >= maxAttempts || !retryableStatus(response))) {
        return response;
      }

      const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
      const jitteredBackoff = backoff * (0.75 + Math.random() * 0.25);
      const serverDelay = response ? (serverDelayMs(response.headers) ?? 0) : 0;
      const delayMs = Math.max(jitteredBackoff, serverDelay);
      const deadline = Date.now() + delayMs;
      const overload = response && [429, 503, 529].includes(response.status);
      if (overload) {
        if (cooldowns.size >= MAX_MODEL_KEYS) {
          for (const [modelKey, cooldown] of cooldowns) {
            if (cooldown.nextAdmission <= Date.now()) {
              cooldowns.delete(modelKey);
            }
          }
        }
        const previous = cooldowns.get(key);
        cooldowns.set(key, {
          until: Math.max(previous?.until ?? 0, deadline),
          nextAdmission: Math.max(previous?.nextAdmission ?? 0, deadline),
        });
      }
      // Release the failed response's connection before another request. Do not
      // drain/parse provider error bodies or touch successful response streams.
      if (response?.body) {
        try {
          await response.body.cancel();
        } catch {
          // A body already closed by the transport needs no further cleanup.
        }
      }
      throwIfAborted(signal);
      if (metrics) {
        metrics.overloadCount += overload ? 1 : 0;
      }
      try {
        options.onRetry?.({
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          reason: response ? "status" : "network",
          status: response?.status,
          model,
          scope: options.scope,
        });
      } catch {
        // Retry observers cannot break the request.
      }
      const waitStarted = Date.now();
      try {
        await waitForAdmission(key, deadline, signal);
      } finally {
        if (metrics) {
          metrics.retryDelayMs += Math.max(0, Date.now() - waitStarted);
        }
      }
    }
  };
}
