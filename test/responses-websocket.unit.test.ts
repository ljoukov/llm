import { describe, expect, it, vi } from "vitest";

import {
  ResponsesWebSocketHttpError,
  createAdaptiveResponsesStream,
  isResponsesWebSocketUnsupportedError,
  mergeOpenAiBetaHeader,
  resolveResponsesWebSocketMode,
  toWebSocketUrl,
  type ResponsesStreamWithFinal,
} from "../src/openai/responses-websocket.js";

function makeStream<TEvent = unknown, TFinal = unknown>(
  events: readonly TEvent[],
  final: TFinal,
): ResponsesStreamWithFinal<TEvent, TFinal> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
      for (const event of events) {
        yield event;
      }
    },
    async finalResponse(): Promise<TFinal> {
      return final;
    },
    close(): void {},
  };
}

describe("responses-websocket helpers", () => {
  it("normalizes mode values and falls back to auto", () => {
    expect(resolveResponsesWebSocketMode("off")).toBe("off");
    expect(resolveResponsesWebSocketMode("only")).toBe("only");
    expect(resolveResponsesWebSocketMode("AUTO")).toBe("auto");
    expect(resolveResponsesWebSocketMode("invalid")).toBe("auto");
  });

  it("merges OpenAI-Beta header values without duplicates", () => {
    expect(mergeOpenAiBetaHeader("responses=experimental, foo=bar", "foo=bar")).toBe(
      "responses=experimental, foo=bar",
    );
    expect(mergeOpenAiBetaHeader(undefined, "responses_websockets=2026-02-06")).toBe(
      "responses_websockets=2026-02-06",
    );
  });

  it("converts HTTP endpoints to websocket URLs", () => {
    expect(toWebSocketUrl("https://api.openai.com/v1/responses")).toBe(
      "wss://api.openai.com/v1/responses",
    );
    expect(toWebSocketUrl("http://localhost:8787/v1/responses")).toBe(
      "ws://localhost:8787/v1/responses",
    );
  });

  it("detects unsupported websocket status errors", () => {
    expect(
      isResponsesWebSocketUnsupportedError(
        new ResponsesWebSocketHttpError({
          status: 426,
          message: "upgrade required",
        }),
      ),
    ).toBe(true);
    expect(
      isResponsesWebSocketUnsupportedError(
        new ResponsesWebSocketHttpError({
          status: 500,
          message: "server error",
        }),
      ),
    ).toBe(false);
  });
});

describe("createAdaptiveResponsesStream", () => {
  it("uses fallback stream when mode is off", async () => {
    const fallback = makeStream(["fallback-event"], { id: "fallback" });
    const createWebSocketStream = vi.fn(async () => makeStream(["ws-event"], { id: "ws" }));
    const stream = createAdaptiveResponsesStream({
      mode: "off",
      createWebSocketStream,
      createFallbackStream: () => fallback,
    });

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event as string);
    }
    const final = await stream.finalResponse();

    expect(createWebSocketStream).not.toHaveBeenCalled();
    expect(events).toEqual(["fallback-event"]);
    expect(final).toEqual({ id: "fallback" });
  });

  it("falls back when websocket creation fails in auto mode", async () => {
    const fallback = makeStream(["fallback-event"], { id: "fallback" });
    const onFallback = vi.fn();
    const stream = createAdaptiveResponsesStream({
      mode: "auto",
      createWebSocketStream: async () => {
        throw new Error("ws failed");
      },
      createFallbackStream: () => fallback,
      onWebSocketFallback: onFallback,
    });

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event as string);
    }
    const final = await stream.finalResponse();

    expect(events).toEqual(["fallback-event"]);
    expect(final).toEqual({ id: "fallback" });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("throws when websocket creation fails in only mode", async () => {
    const stream = createAdaptiveResponsesStream({
      mode: "only",
      createWebSocketStream: async () => {
        throw new Error("ws failed");
      },
      createFallbackStream: () => makeStream([], { id: "fallback" }),
    });

    await expect(stream.finalResponse()).rejects.toThrow("ws failed");
  });
});
