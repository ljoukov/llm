import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const websocketMocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("ws", () => ({
  default: websocketMocks.create,
}));

import { createResponsesWebSocketStream } from "../src/openai/responses-websocket.js";

describe("Responses WebSocket connection failures", () => {
  let socket: EventEmitter & { terminate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    socket = Object.assign(new EventEmitter(), { terminate: vi.fn() });
    websocketMocks.create.mockReturnValue(socket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const connect = (signal?: AbortSignal) =>
    createResponsesWebSocketStream({
      url: "wss://api.openai.com/v1/responses",
      headers: {},
      request: {},
      signal,
    });

  function expectTerminationErrorsHandled() {
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(() => {
      socket.emit("error", new Error("WebSocket was closed before the connection was established"));
    }).not.toThrow();
    socket.emit("close");
    expect(socket.listenerCount("error")).toBe(0);
  }

  it("preserves HTTP upgrade errors while handling the later termination error", async () => {
    const pending = connect();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 401,
      headers: { "x-request-id": "request-401" },
      setEncoding: vi.fn(),
    });
    socket.emit("unexpected-response", {}, response);
    response.emit("data", '{"error":"invalid API key"}');
    response.emit("end");

    await expect(pending).rejects.toMatchObject({
      name: "ResponsesWebSocketHttpError",
      status: 401,
      body: '{"error":"invalid API key"}',
      headers: { "x-request-id": "request-401" },
    });
    expectTerminationErrorsHandled();
  });

  it.each([
    false,
    true,
  ])("handles termination errors when aborted (already aborted: %s)", async (alreadyAborted) => {
    const controller = new AbortController();
    if (alreadyAborted) controller.abort("cancelled");
    const pending = connect(controller.signal);
    if (!alreadyAborted) controller.abort("cancelled");

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expectTerminationErrorsHandled();
  });

  it("handles termination errors after the connection timeout", async () => {
    vi.useFakeTimers();
    const pending = connect();
    const rejected = expect(pending).rejects.toThrow("connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expectTerminationErrorsHandled();
  });

  it("handles termination errors after an initial socket error", async () => {
    const pending = connect();
    socket.emit("error", new Error("handshake failed"));

    await expect(pending).rejects.toThrow(
      "Responses WebSocket connection failed: handshake failed",
    );
    expectTerminationErrorsHandled();
  });
});
