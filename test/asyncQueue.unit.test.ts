import { describe, expect, it } from "vitest";

import { createAsyncQueue } from "../src/utils/asyncQueue.js";

describe("createAsyncQueue", () => {
  it("yields pushed values and completes after close", async () => {
    const q = createAsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const values: number[] = [];
    for await (const value of q.iterable) {
      values.push(value);
    }

    expect(values).toEqual([1, 2]);
  });

  it("fails the iterable when fail() is called", async () => {
    const q = createAsyncQueue<number>();
    const iter = q.iterable[Symbol.asyncIterator]();
    q.fail(new Error("boom"));
    await expect(iter.next()).rejects.toThrow("boom");
  });
});
