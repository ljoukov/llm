import { describe, expect, it } from "vitest";

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
