import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRetryingFetch,
  type RetryFetchEvent,
  type RetryFetchMetrics,
  withRetryFetchMetrics,
} from "../src/utils/retryFetch.js";

const NOW = Date.UTC(2026, 9, 23, 12);
const URL = "https://retry-tests.example/v1/chat/completions";
const request = { method: "POST", body: JSON.stringify({ model: "publisher/model" }) };

describe("pre-response HTTP retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries 429, releases its body and reports per-call metrics", async () => {
    const cancel = vi.fn();
    const failed = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { "retry-after": "2" },
    });
    const success = new Response("ok");
    const raw = vi.fn<typeof fetch>().mockResolvedValueOnce(failed).mockResolvedValue(success);
    const events: RetryFetchEvent[] = [];
    const retried = createRetryingFetch(raw, { onRetry: (event) => events.push(event) });
    let metrics: RetryFetchMetrics | undefined;
    const result = withRetryFetchMetrics(
      () => retried(URL, request),
      (value) => {
        metrics = value;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(raw).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(raw).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(success);
    expect(events).toEqual([
      expect.objectContaining({ attempt: 2, maxAttempts: 4, delayMs: 2_000, status: 429 }),
    ]);
    expect(metrics).toEqual({ retryCount: 1, retryDelayMs: 2_000, overloadCount: 1 });
  });

  it("dispatches healthy concurrent requests immediately and reports no artificial retry delay", async () => {
    const raw = vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok"));
    const retried = createRetryingFetch(raw);
    const metrics: RetryFetchMetrics[] = [];
    const calls = [1, 2].map(() =>
      withRetryFetchMetrics(
        () => retried(URL, request),
        (value) => metrics.push(value),
      ),
    );
    expect(raw).toHaveBeenCalledTimes(2);
    // Simulate concurrent work consuming time before the fetch continuations run.
    vi.setSystemTime(NOW + 14);
    await Promise.all(calls);
    expect(metrics).toEqual([
      { retryCount: 0, retryDelayMs: 0, overloadCount: 0 },
      { retryCount: 0, retryDelayMs: 0, overloadCount: 0 },
    ]);
  });

  it.each([
    [{ "retry-after": "1.5" }, 1_500],
    [{ "retry-after": new Date(NOW + 3_000).toUTCString() }, 3_000],
    [{ "retry-after-ms": "1250", "retry-after": "10" }, 1_250],
    [{ "retry-after-ms": "invalid", "retry-after": "2" }, 2_000],
    [{ "retry-after": "-1" }, 375],
    [{ "retry-after": "1nope" }, 375],
    [{ "retry-after": "NaN" }, 375],
    [{ "retry-after": "Infinity" }, 375],
    [{ "retry-after": "99999999999999999999999999999999999999999" }, 375],
    [{ "retry-after-ms": "-100" }, 375],
    [{ "retry-after-ms": "0x10" }, 375],
    [{ "retry-after-ms": "1e100" }, 375],
    [{ "retry-after": "not a date" }, 375],
  ])("honors valid retry hints and safely falls back for %j", async (headers, delay) => {
    const raw = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers }))
      .mockResolvedValue(new Response("ok"));
    const result = createRetryingFetch(raw)(URL, request);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(raw).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).status).toBe(200);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it.each([
    400, 401, 402, 403, 404, 422,
  ])("returns terminal HTTP %i immediately", async (status) => {
    const response = new Response("terminal", { status });
    const raw = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createRetryingFetch(raw)(URL, request)).toBe(response);
    expect(raw).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects x-should-retry:false even for a 429", async () => {
    const response = new Response("stop", { status: 429, headers: { "x-should-retry": "false" } });
    const raw = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createRetryingFetch(raw)(URL, request)).toBe(response);
    expect(raw).toHaveBeenCalledOnce();
  });

  it.each([
    408, 409, 429, 500, 502, 503, 504, 529,
  ])("bounds HTTP %i retries to four total requests", async (status) => {
    const raw = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("busy", { status }));
    const result = createRetryingFetch(raw)(URL, request);
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(status);
    expect(raw).toHaveBeenCalledTimes(4);
  });

  it("retries network failures and isolates metrics and observer failures", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(new Response("ok"));
    let metrics: RetryFetchMetrics | undefined;
    const result = withRetryFetchMetrics(
      () =>
        createRetryingFetch(raw, {
          onRetry: () => {
            throw new Error("observer failed");
          },
        })(URL, request),
      (value) => {
        metrics = value;
        throw new Error("observer failed");
      },
    );
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(200);
    expect(metrics).toEqual({ retryCount: 1, retryDelayMs: 375, overloadCount: 0 });
  });

  it("throws the last network failure after the attempt limit", async () => {
    const error = new TypeError("fetch failed");
    const raw = vi.fn<typeof fetch>().mockRejectedValue(error);
    const result = createRetryingFetch(raw, { maxAttempts: 2 })(URL, request);
    const rejected = expect(result).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("does not retry an abort error", async () => {
    const error = new DOMException("Aborted", "AbortError");
    const raw = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(createRetryingFetch(raw)(URL, request)).rejects.toBe(error);
    expect(raw).toHaveBeenCalledOnce();
  });

  it("retries a transport timeout when the caller's signal has not expired", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("Headers timed out", "TimeoutError"))
      .mockResolvedValue(new Response("ok"));
    const result = createRetryingFetch(raw)(URL, request);
    await vi.runAllTimersAsync();
    expect((await result).status).toBe(200);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("cancels backoff promptly without another request", async () => {
    const controller = new AbortController();
    const raw = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "60" } }),
      )
      .mockResolvedValue(new Response("ok"));
    const result = createRetryingFetch(raw)(URL, { ...request, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    expect(raw).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports aborted backoff time without counting an HTTP attempt that was never sent", async () => {
    const controller = new AbortController();
    const raw = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "60" } }));
    let metrics: RetryFetchMetrics | undefined;
    const result = withRetryFetchMetrics(
      () => createRetryingFetch(raw)(URL, { ...request, signal: controller.signal }),
      (value) => {
        metrics = value;
      },
    );
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await rejected;
    expect(raw).toHaveBeenCalledOnce();
    expect(metrics).toEqual({ retryCount: 0, retryDelayMs: 100, overloadCount: 1 });
  });

  it("includes an initial shared cooldown wait in per-call metrics", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockImplementation(async () => new Response("ok"));
    const retried = createRetryingFetch(raw);
    const first = retried(URL, request);
    await vi.advanceTimersByTimeAsync(0);
    let metrics: RetryFetchMetrics | undefined;
    const queued = withRetryFetchMetrics(
      () => retried(URL, request),
      (value) => {
        metrics = value;
      },
    );
    await vi.runAllTimersAsync();
    await Promise.all([first, queued]);
    expect(metrics).toEqual({ retryCount: 0, retryDelayMs: 2_025, overloadCount: 0 });
  });

  it("honors multi-day minimums without timer overflow and remains abortable", async () => {
    const controller = new AbortController();
    const raw = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("busy", {
        status: 429,
        headers: { "retry-after-ms": "3000000000" },
      }),
    );
    const result = createRetryingFetch(raw)(URL, { ...request, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(raw).toHaveBeenCalledOnce();
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coordinates and staggers same-model calls while other models proceed", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockImplementation(async () => new Response("ok"));
    const retried = createRetryingFetch(raw);
    const first = retried(URL, request);
    await vi.advanceTimersByTimeAsync(0);
    const second = retried(URL, request);
    const other = retried(URL, { ...request, body: JSON.stringify({ model: "another/model" }) });
    expect((await other).status).toBe(200);
    expect(raw).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await first).status).toBe(200);
    expect(raw).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(24);
    expect(raw).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).status).toBe(200);
    expect(raw).toHaveBeenCalledTimes(4);
  });

  it("shares explicit scopes across wrappers but partitions endpoints and access", async () => {
    const overloaded = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValue(new Response("ok"));
    const fresh = vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok"));
    const first = createRetryingFetch(overloaded, { scope: "shared-test:api" })(URL, request);
    await vi.advanceTimersByTimeAsync(0);
    const queued = createRetryingFetch(fresh, { scope: "shared-test:api" })(URL, request);
    await createRetryingFetch(fresh, { scope: "shared-test:subscription" })(URL, request);
    await createRetryingFetch(fresh, { scope: "shared-test:api" })(
      "https://other.example/v1",
      request,
    );
    expect(fresh).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    await Promise.all([first, queued]);
    expect(fresh).toHaveBeenCalledTimes(3);
  });

  it("adopts a later cooldown while already waiting and permits queue cancellation", async () => {
    const raw = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "1" } }))
      .mockImplementation(async () => new Response("ok"));
    const firstFetch = createRetryingFetch(raw, { scope: "extended-test" });
    const otherRaw = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValue(new Response("ok"));
    // Dispatch both requests before either overload response establishes a wait.
    const first = firstFetch(URL, request);
    const extending = createRetryingFetch(otherRaw, { scope: "extended-test" })(URL, request);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const queued = firstFetch(URL, { ...request, signal: controller.signal });
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(raw).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await Promise.all([first, extending]);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it.each(["stream", "request"])("does not replay a %s request body", async (kind) => {
    const response = new Response("busy", { status: 429 });
    const raw = vi.fn<typeof fetch>().mockResolvedValue(response);
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const result =
      kind === "request"
        ? createRetryingFetch(raw)(new Request(URL, request))
        : createRetryingFetch(raw)(URL, {
            method: "POST",
            body: stream,
            duplex: "half",
          } as RequestInit);
    expect(await result).toBe(response);
    expect(raw).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns successful streams exactly once even when reading later fails", async () => {
    const error = new Error("stream disconnected");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
    );
    const raw = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await createRetryingFetch(raw)(URL, request);
    expect(result).toBe(response);
    await expect(result.text()).rejects.toBe(error);
    expect(raw).toHaveBeenCalledOnce();
  });
});
