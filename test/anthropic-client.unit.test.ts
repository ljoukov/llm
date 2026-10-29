import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAnthropicCall } from "../src/anthropic/calls.js";
import {
  AnthropicApiError,
  AnthropicClient,
  getAnthropicClient,
  type AnthropicMessageRequest,
} from "../src/anthropic/client.js";
import {
  configureModelConcurrency,
  resetModelConcurrencyConfig,
} from "../src/utils/modelConcurrency.js";

const request: AnthropicMessageRequest = {
  model: "claude-sonnet-5-5",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello" }],
};
let testModelIndex = 0;

function event(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function start(usage: Record<string, unknown> = {}): string {
  return event("message_start", {
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: request.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, ...usage },
    },
  });
}

function responseFromChunks(text: string, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function stubStream(text: string, chunkSize?: number): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => responseFromChunks(text, chunkSize));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Anthropic native Messages client", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-unit-test-secret");
    // Rate-limit cooldowns are shared by model, including across raw fetch instances.
    request.model = `claude-sonnet-5-5-unit-${++testModelIndex}`;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetModelConcurrencyConfig();
  });

  it.each([
    1, 17, 4096,
  ])("assembles UTF-8 SSE text and cumulative usage with %i-byte chunks", async (chunkSize) => {
    const stream = [
      start({ cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ": comment\n\n",
      event("ping"),
      event("new_event_type", { value: true }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello 🌍" } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      event("message_delta", {
        delta: { stop_sequence: null },
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
      event("message_stop"),
    ]
      .join("")
      .replaceAll("\n", "\r\n");
    const fetchMock = stubStream(stream, chunkSize);
    const onDelta = vi.fn();
    const signal = new AbortController().signal;
    const message = await getAnthropicClient().streamMessage(request, { signal, onDelta });

    expect(message.content).toEqual([{ type: "text", text: "Hello 🌍" }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage).toEqual({
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("response", "Hello 🌍");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        signal,
        headers: expect.objectContaining({
          "x-api-key": "anthropic-unit-test-secret",
          "anthropic-version": "2023-06-01",
        }),
        body: JSON.stringify({ ...request, stream: true }),
      }),
    );
  });

  it("streams initial block text before subsequent deltas", async () => {
    stubStream(
      [
        start(),
        event("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "Initial thought", signature: "" },
        }),
        event("content_block_stop", { index: 0 }),
        event("content_block_start", {
          index: 1,
          content_block: { type: "text", text: "Hello" },
        }),
        event("content_block_delta", {
          index: 1,
          delta: { type: "text_delta", text: " world" },
        }),
        event("content_block_stop", { index: 1 }),
        event("message_stop"),
      ].join(""),
    );
    const onDelta = vi.fn();
    const message = await new AnthropicClient().streamMessage(request, { onDelta });
    expect(onDelta.mock.calls).toEqual([
      ["thought", "Initial thought"],
      ["response", "Hello"],
      ["response", " world"],
    ]);
    expect(message.content[1]).toEqual({ type: "text", text: "Hello world" });
  });

  it.each([
    "standard",
    "fast",
  ] as const)("forwards %s speed separately from model identity and preserves serving metadata", async (speed) => {
    const fetchMock = stubStream(
      [
        start({ speed, service_tier: "standard" }),
        event("message_delta", { usage: { output_tokens: 8 } }),
        event("message_stop"),
      ].join(""),
    );

    const message = await new AnthropicClient().streamMessage({ ...request, speed });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: request.model,
      speed,
      stream: true,
    });
    expect(message.model).toBe(request.model);
    expect(message.usage).toMatchObject({ speed, service_tier: "standard", output_tokens: 8 });
  });

  it("uses final serving metadata when a later usage event updates speed or capacity tier", async () => {
    stubStream(
      [
        start({ speed: "fast", service_tier: "priority" }),
        event("message_delta", {
          usage: { output_tokens: 8, speed: "standard", service_tier: "standard" },
        }),
        event("message_stop"),
      ].join(""),
    );

    const message = await new AnthropicClient().streamMessage({ ...request, speed: "fast" });

    expect(message.usage).toMatchObject({
      speed: "standard",
      service_tier: "standard",
      output_tokens: 8,
    });
  });

  it("preserves thinking signatures, redacted blocks, tool JSON, citations, and cache details", async () => {
    stubStream(
      [
        start({ cache_creation: { ephemeral_5m_input_tokens: 2 } }),
        event("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "Checking." },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "sig-" },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "end" },
        }),
        event("content_block_stop", { index: 0 }),
        event("content_block_start", {
          index: 1,
          content_block: { type: "redacted_thinking", data: "encrypted" },
        }),
        event("content_block_stop", { index: 1 }),
        event("content_block_start", {
          index: 2,
          content_block: { type: "tool_use", id: "tool_1", name: "weather", input: {} },
        }),
        event("content_block_delta", {
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        }),
        event("content_block_delta", {
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"London"}' },
        }),
        event("content_block_stop", { index: 2 }),
        event("content_block_start", { index: 3, content_block: { type: "text", text: "" } }),
        event("content_block_delta", {
          index: 3,
          delta: {
            type: "citations_delta",
            citation: { type: "char_location", cited_text: "Source" },
          },
        }),
        event("content_block_stop", { index: 3 }),
        event("message_delta", {
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 3 } },
        }),
        event("message_stop"),
      ].join(""),
    );
    const onDelta = vi.fn();
    const message = await new AnthropicClient().streamMessage(request, { onDelta });
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Checking.", signature: "sig-end" },
      { type: "redacted_thinking", data: "encrypted" },
      { type: "tool_use", id: "tool_1", name: "weather", input: { city: "London" } },
      { type: "text", text: "", citations: [{ type: "char_location", cited_text: "Source" }] },
    ]);
    expect(message.usage.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 2,
      ephemeral_1h_input_tokens: 3,
    });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("thought", "Checking.");
  });

  it("accepts multiline SSE data and a final event without a trailing blank line", async () => {
    stubStream(
      `${start()}event: message_delta\ndata: {"type":"message_delta",\ndata: "delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}`,
    );
    expect((await new AnthropicClient().streamMessage(request)).stop_reason).toBe("end_turn");
  });

  it.each([
    [start(), "before message_stop"],
    [
      start() +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("message_stop"),
      "unfinished content blocks",
    ],
    ["event: message_start\ndata: invalid\n\n", "invalid event JSON"],
    [
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "bad" } }),
      "outside an active message",
    ],
    [
      start() +
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "bad" } }),
      "inactive block",
    ],
  ])("rejects incomplete or malformed streams", async (stream, error) => {
    stubStream(stream);
    await expect(new AnthropicClient().streamMessage(request)).rejects.toThrow(error);
  });

  it("rejects invalid completed tool input instead of returning a partial tool call", async () => {
    stubStream(
      start() +
        event("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "test", input: {} },
        }) +
        event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"broken":' },
        }) +
        event("content_block_stop", { index: 0 }) +
        event("message_stop"),
    );
    await expect(new AnthropicClient().streamMessage(request)).rejects.toThrow(
      "invalid tool input JSON",
    );
  });

  it("surfaces provider stream errors with credentials redacted", async () => {
    stubStream(
      start() +
        event("error", {
          error: {
            type: "overloaded_error",
            message: "Rejected anthropic-unit-test-secret and sk-ant-private-secret",
          },
        }),
    );
    const error = await new AnthropicClient()
      .streamMessage(request)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnthropicApiError);
    expect((error as Error).message).toBe(
      "Anthropic stream error: Rejected [redacted] and [redacted]",
    );
  });

  it("includes HTTP status and redacts provider error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Invalid anthropic-unit-test-secret" } }),
            { status: 401 },
          ),
      ),
    );
    const error = await new AnthropicClient()
      .streamMessage(request)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnthropicApiError);
    expect((error as AnthropicApiError).status).toBe(401);
    expect((error as Error).message).toBe(
      "Anthropic API request failed (HTTP 401): Invalid [redacted]",
    );
  });

  it("honors Retry-After on a rejected HTTP request and reports transport retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Rate limited" } }), {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockImplementationOnce(async () => responseFromChunks(start() + event("message_stop")));
    vi.stubGlobal("fetch", fetchMock);
    const settled = vi.fn();
    const result = runAnthropicCall((client) => client.streamMessage(request), request.model, {
      onSettled: settled,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect((await result).id).toBe("msg_test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ attempts: 2, overloadCount: 1 }),
    );
    expect(settled.mock.calls[0]?.[0].retryDelayMs).toBeGreaterThanOrEqual(2000);
  });

  it("keeps billing failures terminal and exposes only sanitized response metadata", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
          status: 402,
          headers: {
            "retry-after": "1",
            "request-id": "req_test",
            "anthropic-ratelimit-requests-remaining": "0",
            "x-api-key": "anthropic-unit-test-secret",
            "x-provider-debug": "private",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await new AnthropicClient()
      .streamMessage(request)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnthropicApiError);
    expect((error as AnthropicApiError).status).toBe(402);
    expect((error as AnthropicApiError).headers?.get("request-id")).toBe("req_test");
    expect((error as AnthropicApiError).headers?.get("retry-after")).toBe("1");
    expect((error as AnthropicApiError).headers?.get("x-api-key")).toBeNull();
    expect((error as AnthropicApiError).headers?.get("x-provider-debug")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows aborting a rate-limit backoff without issuing another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = new AnthropicClient().streamMessage(request, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never replays an accepted stream after delivering partial output", async () => {
    const fetchMock = stubStream(
      start() +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Partial" } }) +
        event("error", { error: { type: "overloaded_error", message: "Try again later" } }),
    );
    const onDelta = vi.fn();
    await expect(new AnthropicClient().streamMessage(request, { onDelta })).rejects.toThrow(
      "Try again later",
    );
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("response", "Partial");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles non-JSON HTTP errors and missing credentials without leaking request data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("gateway failure", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(new AnthropicClient().streamMessage(request)).rejects.toThrow(
      "HTTP 502",
    );
    await vi.runAllTimersAsync();
    await rejected;
    vi.stubEnv("ANTHROPIC_API_KEY", " ");
    await expect(new AnthropicClient().streamMessage(request)).rejects.toThrow(
      "ANTHROPIC_API_KEY must be provided",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("propagates aborts and cancels the stream when a delta consumer throws", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new AnthropicClient().streamMessage(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    stubStream(
      start() +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
    );
    await expect(
      new AnthropicClient().streamMessage(request, {
        onDelta: () => {
          throw new Error("consumer failed");
        },
      }),
    ).rejects.toThrow("consumer failed");
  });

  it("shares its client and schedules without retrying streamed requests", async () => {
    expect(getAnthropicClient()).toBe(getAnthropicClient());
    const settled = vi.fn();
    const fn = vi.fn(async () => {
      throw new AnthropicApiError("overloaded", 529);
    });
    await expect(runAnthropicCall(fn, request.model, { onSettled: settled })).rejects.toThrow(
      "overloaded",
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempts: 1 }));
  });

  it("starts the configured concurrency without an artificial spacing or warm-up limit", async () => {
    configureModelConcurrency({ providerCaps: { anthropic: 16 } });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = vi.fn(async () => {
      await pending;
      return "done";
    });
    const calls = Promise.all(
      Array.from({ length: 16 }, () => runAnthropicCall(fn, request.model)),
    );
    void calls.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(16));
    } finally {
      release?.();
    }
    await expect(calls).resolves.toEqual(Array(16).fill("done"));
  });
});
