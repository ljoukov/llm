import { afterEach, describe, expect, it, vi } from "vitest";

import { createCallScheduler } from "../src/utils/scheduler.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createOverloadError(): Error & { status: number } {
  const error = new Error("rate limit");
  return Object.assign(error, { status: 429 });
}

async function flushTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createCallScheduler adaptive concurrency", () => {
  it("decreases concurrency after overload errors", async () => {
    const scheduler = createCallScheduler({
      maxParallelRequests: 4,
      initialParallelRequests: 4,
      increaseAfterConsecutiveSuccesses: 100,
      isOverloadError: (error) => (error as { status?: unknown })?.status === 429,
    });

    const gatesById = new Map<number, Deferred<void>>();
    for (const id of [2, 3, 4, 5, 6]) {
      gatesById.set(id, createDeferred<void>());
    }

    const started: number[] = [];
    const jobs = Array.from({ length: 6 }, (_, index) => {
      const id = index + 1;
      return scheduler
        .run(async () => {
          started.push(id);
          if (id === 1) {
            throw createOverloadError();
          }
          const gate = gatesById.get(id);
          if (!gate) {
            throw new Error(`Missing gate for task ${id}`);
          }
          await gate.promise;
          return id;
        })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ status: "rejected" as const, reason }),
        );
    });

    await flushTick();
    expect(started).toEqual([1, 2, 3, 4]);
    // Reading the same configured cap again must preserve adaptive backoff.
    scheduler.setMaxParallelRequests(4);

    const gate2 = gatesById.get(2);
    if (!gate2) {
      throw new Error("Missing gate 2");
    }
    gate2.resolve();
    await flushTick();
    expect(started).toEqual([1, 2, 3, 4]);

    const gate3 = gatesById.get(3);
    if (!gate3) {
      throw new Error("Missing gate 3");
    }
    gate3.resolve();
    await flushTick();
    expect(started).toContain(5);
    expect(started).not.toContain(6);

    for (const id of [4, 5, 6]) {
      const gate = gatesById.get(id);
      if (!gate) {
        throw new Error(`Missing gate ${id}`);
      }
      gate.resolve();
    }

    const settled = await Promise.all(jobs);
    expect(settled).toHaveLength(6);
    expect(settled[0]?.status).toBe("rejected");
    expect(settled.slice(1).every((entry) => entry.status === "fulfilled")).toBe(true);
  });

  it("increases concurrency after sustained successful calls", async () => {
    const scheduler = createCallScheduler({
      maxParallelRequests: 3,
      initialParallelRequests: 1,
      increaseAfterConsecutiveSuccesses: 2,
    });

    await Promise.all([scheduler.run(async () => 1), scheduler.run(async () => 2)]);

    const phaseOneGates = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
    const phaseOneStarted: number[] = [];
    const phaseOneJobs = phaseOneGates.map((gate, index) =>
      scheduler.run(async () => {
        phaseOneStarted.push(index + 1);
        await gate.promise;
        return index + 1;
      }),
    );

    await flushTick();
    expect(phaseOneStarted).toHaveLength(2);

    for (const gate of phaseOneGates) {
      gate.resolve();
    }
    await Promise.all(phaseOneJobs);

    const phaseTwoGates = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
    const phaseTwoStarted: number[] = [];
    const phaseTwoJobs = phaseTwoGates.map((gate, index) =>
      scheduler.run(async () => {
        phaseTwoStarted.push(index + 1);
        await gate.promise;
        return index + 1;
      }),
    );

    await flushTick();
    expect(phaseTwoStarted).toHaveLength(3);

    for (const gate of phaseTwoGates) {
      gate.resolve();
    }
    await Promise.all(phaseTwoJobs);
  });
});

describe("createCallScheduler dynamic concurrency", () => {
  it("increases the cap on the same queue and starts waiting jobs immediately", async () => {
    const scheduler = createCallScheduler({ maxParallelRequests: 1 });
    const gates = Array.from({ length: 3 }, () => createDeferred<void>());
    const started: number[] = [];
    const jobs = gates.map((gate, index) =>
      scheduler.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await flushTick();
    expect(started).toEqual([0]);

    scheduler.setMaxParallelRequests(3);
    await flushTick();
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) {
      gate.resolve();
    }
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2]);
  });

  it("reduces the cap without releasing active slots or losing queued jobs", async () => {
    const scheduler = createCallScheduler({
      maxParallelRequests: 3,
      initialParallelRequests: 3,
    });
    const gates = Array.from({ length: 5 }, () => createDeferred<void>());
    const started: number[] = [];
    const jobs = gates.map((gate, index) =>
      scheduler.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await flushTick();
    expect(started).toEqual([0, 1, 2]);

    scheduler.setMaxParallelRequests(1);
    gates[0]?.resolve();
    gates[1]?.resolve();
    await flushTick();
    expect(started).toEqual([0, 1, 2]);
    gates[2]?.resolve();
    await flushTick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3]?.resolve();
    await flushTick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[4]?.resolve();
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4]);
  });
});

describe("createCallScheduler cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an already aborted job without invoking its callback", async () => {
    const scheduler = createCallScheduler();
    const controller = new AbortController();
    const reason = new Error("cancelled before enqueue");
    controller.abort(reason);
    const callback = vi.fn(async () => 1);
    const onSettled = vi.fn();

    await expect(scheduler.run(callback, { signal: controller.signal, onSettled })).rejects.toBe(
      reason,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ attempts: 0 }));
    await expect(scheduler.run(async () => 2)).resolves.toBe(2);
  });

  it("removes queued jobs on abort without waiting for an active request", async () => {
    const scheduler = createCallScheduler({ maxParallelRequests: 1 });
    const gate = createDeferred<void>();
    const active = scheduler.run(async () => {
      await gate.promise;
      return "active";
    });
    await flushTick();
    const controller = new AbortController();
    const reason = new Error("cancelled in queue");
    const callback = vi.fn(async () => "cancelled");
    const onSettled = vi.fn();
    const queued = scheduler.run(callback, { signal: controller.signal, onSettled });
    const rejection = expect(queued).rejects.toBe(reason);
    const nextCallback = vi.fn(async () => "next");
    const next = scheduler.run(nextCallback);

    controller.abort(reason);
    await rejection;
    expect(callback).not.toHaveBeenCalled();
    expect(nextCallback).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ attempts: 0 }));

    gate.resolve();
    await expect(active).resolves.toBe("active");
    await expect(next).resolves.toBe("next");
    expect(callback).not.toHaveBeenCalled();
  });

  it("aborts retry backoff promptly and releases the slot to the next job", async () => {
    vi.useFakeTimers();
    const scheduler = createCallScheduler({
      maxParallelRequests: 1,
      retry: { maxAttempts: 3, getDelayMs: () => 60_000 },
    });
    const controller = new AbortController();
    const reason = new Error("cancelled during retry delay");
    const callback = vi.fn(async () => {
      throw createOverloadError();
    });
    const onSettled = vi.fn();
    const pending = scheduler.run(callback, { signal: controller.signal, onSettled });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(250);
    expect(callback).toHaveBeenCalledTimes(1);
    const next = scheduler.run(async () => "next");

    controller.abort(reason);
    await rejection;
    await expect(next).resolves.toBe("next");
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, retryDelayMs: 250, overloadCount: 1 }),
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("honors retry delays beyond the maximum timer value without retrying early", async () => {
    vi.useFakeTimers();
    const maxTimerMs = 2_147_483_647;
    const scheduler = createCallScheduler({
      retry: { maxAttempts: 2, getDelayMs: () => maxTimerMs + 1_000 },
    });
    const callback = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(createOverloadError())
      .mockResolvedValueOnce("retried");
    const pending = scheduler.run(callback);

    await vi.advanceTimersByTimeAsync(maxTimerMs);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("retried");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("can abort a later slice of an extended retry wait", async () => {
    vi.useFakeTimers();
    const maxTimerMs = 2_147_483_647;
    const scheduler = createCallScheduler({
      maxParallelRequests: 1,
      retry: { maxAttempts: 2, getDelayMs: () => maxTimerMs + 60_000 },
    });
    const controller = new AbortController();
    const reason = new Error("cancelled extended retry wait");
    const callback = vi.fn(async () => {
      throw createOverloadError();
    });
    const pending = scheduler.run(callback, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(maxTimerMs + 100);

    controller.abort(reason);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(scheduler.run(async () => "next")).resolves.toBe("next");
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ])("stops retrying when the retry policy returns an invalid delay (%s)", async (delay) => {
    const scheduler = createCallScheduler({
      retry: { maxAttempts: 3, getDelayMs: () => delay },
    });
    const error = createOverloadError();
    const callback = vi.fn(async () => {
      throw error;
    });

    await expect(scheduler.run(callback)).rejects.toBe(error);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("aborts its own start-spacing sleep and permits a replacement job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const scheduler = createCallScheduler({
      maxParallelRequests: 1,
      minIntervalBetweenStartMs: 1_000,
    });
    await scheduler.run(async () => "first");
    const controller = new AbortController();
    const reason = new Error("cancelled during start spacing");
    const callback = vi.fn(async () => "cancelled");
    const pending = scheduler.run(callback, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(100);
    const nextCallback = vi.fn(async () => "next");
    const next = scheduler.run(nextCallback);

    controller.abort(reason);
    await rejection;
    await vi.advanceTimersByTimeAsync(899);
    expect(nextCallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBe("next");
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves spacing order when a waiter behind another spacing job aborts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const scheduler = createCallScheduler({
      maxParallelRequests: 3,
      initialParallelRequests: 3,
      minIntervalBetweenStartMs: 1_000,
    });
    await scheduler.run(async () => "first");
    const starts: number[] = [];
    const second = scheduler.run(async () => {
      starts.push(Date.now());
      return "second";
    });
    const controller = new AbortController();
    const reason = new Error("cancelled while waiting for spacing turn");
    const cancelledCallback = vi.fn(async () => "cancelled");
    const pending = scheduler.run(cancelledCallback, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(100);

    controller.abort(reason);
    await rejection;
    const fourth = scheduler.run(async () => {
      starts.push(Date.now());
      return "fourth";
    });
    await vi.advanceTimersByTimeAsync(899);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe("second");
    expect(starts).toEqual([11_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(fourth).resolves.toBe("fourth");
    expect(starts).toEqual([11_000, 12_000]);
    expect(cancelledCallback).not.toHaveBeenCalled();
  });

  it("retains an active slot until its callback settles after cancellation", async () => {
    const scheduler = createCallScheduler({ maxParallelRequests: 1 });
    const gate = createDeferred<void>();
    const controller = new AbortController();
    const active = scheduler.run(
      async () => {
        await gate.promise;
        return "completed";
      },
      { signal: controller.signal },
    );
    await flushTick();
    const nextCallback = vi.fn(async () => "next");
    const next = scheduler.run(nextCallback);

    controller.abort();
    await flushTick();
    expect(nextCallback).not.toHaveBeenCalled();
    gate.resolve();
    await expect(active).resolves.toBe("completed");
    await expect(next).resolves.toBe("next");
  });

  it("does not retry a callback failure once the request has been aborted", async () => {
    const scheduler = createCallScheduler({
      maxParallelRequests: 1,
      retry: { maxAttempts: 3, getDelayMs: () => 0 },
    });
    const gate = createDeferred<void>();
    const controller = new AbortController();
    const reason = new Error("cancelled active request");
    const callback = vi.fn(async () => {
      await gate.promise;
      throw createOverloadError();
    });
    const pending = scheduler.run(callback, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBe(reason);
    await flushTick();

    controller.abort(reason);
    gate.resolve();
    await rejection;
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(scheduler.run(async () => "next")).resolves.toBe("next");
  });
});
