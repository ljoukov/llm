import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { streamFireworksChatCompletion } from "../src/fireworks/stream.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function mockClient(stream: AsyncIterable<unknown> & { controller?: AbortController }) {
  const create = vi.fn(async (_request: unknown, _options?: unknown) => stream);
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

describe("Fireworks SSE accumulation", () => {
  it("emits exact thought and response deltas while inference is still pending", async () => {
    const paused = deferred<void>();
    const started = deferred<void>();
    const deltas: Array<[string, string]> = [];
    const { client, create } = mockClient({
      async *[Symbol.asyncIterator]() {
        yield {
          model: "deepseek-real",
          choices: [{ index: 0, delta: { reasoning_content: "  Think\n" } }],
        };
        started.resolve();
        await paused.promise;
        yield { choices: [{ index: 0, delta: { reasoning_content: "more " } }] };
        yield { choices: [{ index: 0, delta: { content: " answer\n" }, finish_reason: "stop" }] };
      },
    });
    let settled = false;
    const result = streamFireworksChatCompletion(
      client,
      { model: "deepseek-requested", stream: false, stream_options: { include_usage: false } },
      { onDelta: (channel, text) => deltas.push([channel, text]) },
    ).finally(() => {
      settled = true;
    });
    await started.promise;
    expect(settled).toBe(false);
    expect(deltas).toEqual([["thought", "  Think\n"]]);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    paused.resolve();
    const response = await result;
    expect(response.model).toBe("deepseek-real");
    expect(response.choices[0]?.message).toEqual({
      role: "assistant",
      content: " answer\n",
      reasoning_content: "  Think\nmore ",
    });
    expect(response.choices[0]?.finish_reason).toBe("stop");
    expect(deltas).toEqual([
      ["thought", "  Think\n"],
      ["thought", "more "],
      ["response", " answer\n"],
    ]);
  });

  it("assembles interleaved parallel tool fragments and trailing usage-only chunks", async () => {
    const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
    const { client } = mockClient({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            { index: 1, delta: { content: "ignored" } },
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 1, id: "call_", function: { name: "add", arguments: '{"b":' } },
                  { index: 0, id: "first", function: { name: "multi", arguments: '{"a":' } },
                ],
              },
            },
          ],
        };
        yield {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "ply", arguments: "2}" } },
                  { index: 1, id: "second", function: { arguments: "3}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
        yield { model: "deepseek-final", choices: [], usage };
      },
    });
    const response = await streamFireworksChatCompletion(client, { model: "deepseek" });
    expect(response.model).toBe("deepseek-final");
    expect(response.usage).toEqual(usage);
    expect(response.choices[0]?.finish_reason).toBe("tool_calls");
    expect(response.choices[0]?.message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "first", type: "function", function: { name: "multiply", arguments: '{"a":2}' } },
        { id: "call_second", type: "function", function: { name: "add", arguments: '{"b":3}' } },
      ],
    });
  });

  it("preserves already-emitted thoughts and closes the transport after a stream error", async () => {
    const controller = new AbortController();
    const closed = vi.fn();
    const deltas = vi.fn();
    const error = new Error("connection interrupted");
    const { client, create } = mockClient({
      controller,
      async *[Symbol.asyncIterator]() {
        try {
          yield { choices: [{ delta: { reasoning_content: "partial thought" } }] };
          throw error;
        } finally {
          closed();
        }
      },
    });
    await expect(
      streamFireworksChatCompletion(client, { model: "deepseek" }, { onDelta: deltas }),
    ).rejects.toBe(error);
    expect(deltas).toHaveBeenCalledWith("thought", "partial thought");
    expect(closed).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects and closes a stalled stream promptly when aborted", async () => {
    const signalController = new AbortController();
    const transportController = new AbortController();
    const started = deferred<void>();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const { client, create } = mockClient({
      controller: transportController,
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            started.resolve();
            return await new Promise<IteratorResult<unknown>>(() => undefined);
          },
          return: returned,
        };
      },
    });
    const removeListener = vi.spyOn(signalController.signal, "removeEventListener");
    const result = streamFireworksChatCompletion(
      client,
      { model: "deepseek" },
      { signal: signalController.signal },
    );
    await started.promise;
    const reason = new Error("cancelled by user");
    signalController.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(transportController.signal.aborted).toBe(true);
    expect(returned).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects an already aborted request before contacting the provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, create } = mockClient({ async *[Symbol.asyncIterator]() {} });
    await expect(
      streamFireworksChatCompletion(client, { model: "deepseek" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a clean EOF without a finish reason while retaining emitted thoughts", async () => {
    const controller = new AbortController();
    const deltas = vi.fn();
    const { client, create } = mockClient({
      controller,
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ index: 0, delta: { reasoning_content: "incomplete thought" } }] };
      },
    });
    await expect(
      streamFireworksChatCompletion(client, { model: "deepseek" }, { onDelta: deltas }),
    ).rejects.toThrow("Fireworks stream ended before the first choice supplied a finish reason.");
    expect(deltas).toHaveBeenCalledWith("thought", "incomplete thought");
    expect(controller.signal.aborted).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects when the SDK silently ends an aborted transport", async () => {
    const controller = new AbortController();
    const { client } = mockClient({
      controller,
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { reasoning_content: "partial" } }] };
        controller.abort();
      },
    });
    await expect(
      streamFireworksChatCompletion(client, { model: "deepseek" }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
