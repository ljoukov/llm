import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

const mocks = vi.hoisted(() => ({
  client: {},
  retryMetrics: { retryCount: 0, retryDelayMs: 0, overloadCount: 0 },
}));

vi.mock("../src/vercel/client.js", () => ({
  getVercelClient: () => mocks.client,
}));
vi.mock("../src/utils/retryFetch.js", () => ({
  withRetryFetchMetrics: async <T>(
    fn: () => Promise<T>,
    onSettled: (metrics: typeof mocks.retryMetrics) => void,
  ) => {
    try {
      return await fn();
    } finally {
      onSettled(mocks.retryMetrics);
    }
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Vercel call concurrency", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    vi.resetModules();
    vi.useFakeTimers();
    mocks.retryMetrics = { retryCount: 0, retryDelayMs: 0, overloadCount: 0 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts sixteen calls immediately and holds the cap until a call finishes", async () => {
    const { runVercelCall } = await import("../src/vercel/calls.js");
    const gates = Array.from({ length: 17 }, deferred);
    const starts: number[] = [];
    let active = 0;
    let peakActive = 0;
    const calls = gates.map((gate, index) =>
      runVercelCall(async (client) => {
        expect(client).toBe(mocks.client);
        starts.push(index);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await gate.promise;
        active -= 1;
      }, "reflection/beam-free"),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(16);
    expect(active).toBe(16);
    expect(vi.getTimerCount()).toBe(0);

    gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(17);
    expect(active).toBe(16);
    expect(peakActive).toBe(16);

    for (const gate of gates) gate.resolve();
    await Promise.all(calls);
  });

  it("retains the permit through the full callback after response headers arrive", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ providerCaps: { vercel: 1 } });
    const responseOpened = deferred();
    const streamFinished = deferred();
    const starts: number[] = [];
    const first = runVercelCall(async () => {
      starts.push(1);
      await responseOpened.promise;
      await streamFinished.promise;
    }, "zai/glm-5.3");
    const second = runVercelCall(async () => {
      starts.push(2);
    }, "zai/glm-5.3");

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([1]);
    responseOpened.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([1]);
    streamFinished.resolve();
    await Promise.all([first, second]);
    expect(starts).toEqual([1, 2]);
  });

  it("applies a changed configured cap after a model scheduler has been cached", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ providerCaps: { vercel: 1 } });
    await runVercelCall(async () => undefined, "zai/glm-5.3");
    configureModelConcurrency({ providerCaps: { vercel: 8 } });
    const gates = Array.from({ length: 8 }, deferred);
    let starts = 0;
    const calls = gates.map((gate) =>
      runVercelCall(async () => {
        starts += 1;
        await gate.promise;
      }, "zai/glm-5.3"),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(8);
    expect(vi.getTimerCount()).toBe(0);
    for (const gate of gates) gate.resolve();
    await Promise.all(calls);
  });

  it("retains queued calls when lowering a cap while requests are active", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ providerCaps: { vercel: 3 } });
    const gates = Array.from({ length: 6 }, deferred);
    const starts: number[] = [];
    const call = (index: number) =>
      runVercelCall(async () => {
        starts.push(index);
        await gates[index]?.promise;
      }, "zai/glm-5.3");
    const calls = Array.from({ length: 5 }, (_, index) => call(index));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2]);

    configureModelConcurrency({ providerCaps: { vercel: 1 } });
    calls.push(call(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2]);
    gates[0]?.resolve();
    gates[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2]);
    gates[2]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2, 3]);
    gates[3]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2, 3, 4]);
    gates[4]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2, 3, 4, 5]);
    gates[5]?.resolve();
    await Promise.all(calls);
  });

  it("starts previously queued work immediately when raising an active cap", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ providerCaps: { vercel: 1 } });
    const gate = deferred();
    const starts: number[] = [];
    const call = (index: number) =>
      runVercelCall(async () => {
        starts.push(index);
        await gate.promise;
      }, "zai/glm-5.3");
    const calls = [call(0), call(1), call(2)];
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);

    configureModelConcurrency({ providerCaps: { vercel: 3 } });
    calls.push(call(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 1, 2]);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve();
    await Promise.all(calls);
    expect(starts).toEqual([0, 1, 2, 3]);
  });

  it("keeps model-specific caps independent", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ globalCap: 1 });
    const gate = deferred();
    const started = vi.fn();
    const calls = ["reflection/beam-free", "zai/glm-5.3"].map((model) =>
      runVercelCall(async () => {
        started();
        await gate.promise;
      }, model),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all(calls);
  });

  it("backs off concurrency after final overload without replaying the callback", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ providerCaps: { vercel: 4 } });
    const overloaded = vi.fn(async () => {
      throw Object.assign(new Error("Rate limited"), { status: 429 });
    });
    await expect(runVercelCall(overloaded, "zai/glm-5.3")).rejects.toThrow("Rate limited");
    expect(overloaded).toHaveBeenCalledTimes(1);

    const gate = deferred();
    const started = vi.fn();
    const calls = Array.from({ length: 4 }, () =>
      runVercelCall(async () => {
        started();
        await gate.promise;
      }, "zai/glm-5.3"),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all(calls);
  });

  it("includes HTTP retry timing in scheduler metrics", async () => {
    const { runVercelCall } = await import("../src/vercel/calls.js");
    mocks.retryMetrics = { retryCount: 2, retryDelayMs: 1300, overloadCount: 1 };
    const onSettled = vi.fn();
    await runVercelCall(async () => "ok", "zai/glm-5.3", { onSettled });
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3, retryDelayMs: 1300, overloadCount: 1 }),
    );
  });

  it("does not let a metrics hook failure change a successful result", async () => {
    const { runVercelCall } = await import("../src/vercel/calls.js");
    await expect(
      runVercelCall(async () => "ok", "zai/glm-5.3", {
        onSettled: () => {
          throw new Error("Metrics sink unavailable");
        },
      }),
    ).resolves.toBe("ok");
  });

  it("forwards cancellation while a call waits for a permit", async () => {
    const { configureModelConcurrency } = await import("../src/utils/modelConcurrency.js");
    const { runVercelCall } = await import("../src/vercel/calls.js");
    configureModelConcurrency({ providerCaps: { vercel: 1 } });
    const gate = deferred();
    const running = runVercelCall(async () => gate.promise, "zai/glm-5.3");
    const controller = new AbortController();
    const queuedCallback = vi.fn(async () => "unexpected");
    const queued = runVercelCall(queuedCallback, "zai/glm-5.3", {
      signal: controller.signal,
    });
    const cancelled = expect(queued).rejects.toThrow("Request cancelled");
    controller.abort(new Error("Request cancelled"));
    await cancelled;
    expect(queuedCallback).not.toHaveBeenCalled();
    gate.resolve();
    await running;
  });
});
