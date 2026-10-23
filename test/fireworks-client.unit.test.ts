import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: mocks.fetch,
}));

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completionStream(): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "completion",
      choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("Fireworks HTTP retries", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    vi.resetModules();
    mocks.fetch.mockReset();
    vi.stubEnv("FIREWORKS_TOKEN", "fake-fireworks-credential");
    vi.stubEnv("FIREWORKS_BASE_URL", "");
    vi.stubEnv("FIREWORKS_TIMEOUT_MS", "");
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("retries 429 before streaming and exposes retry metrics without nested SDK retries", async () => {
    vi.useFakeTimers();
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(completionStream());
    const { getFireworksClient } = await import("../src/fireworks/client.js");
    const { runFireworksCall } = await import("../src/fireworks/calls.js");
    expect(getFireworksClient().maxRetries).toBe(0);
    let metrics: { attempts: number; retryDelayMs: number; overloadCount: number } | undefined;
    const pending = runFireworksCall(
      async (client) => {
        const stream = await client.chat.completions.create({
          model: "accounts/fireworks/models/glm-5p3",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        });
        let text = "";
        for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
        return text;
      },
      "glm-5.3",
      {
        onSettled: (value) => {
          metrics = value;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe("OK");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(metrics).toMatchObject({ attempts: 2, overloadCount: 1 });
    expect(metrics?.retryDelayMs).toBeGreaterThanOrEqual(375);
  });

  it.each([400, 401, 402, 403])("does not retry terminal HTTP %s", async (status) => {
    mocks.fetch.mockResolvedValue(jsonResponse({ error: { message: "terminal failure" } }, status));
    const { getFireworksClient } = await import("../src/fireworks/client.js");
    await expect(getFireworksClient().models.list()).rejects.toMatchObject({ status });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated transient failures to four total HTTP attempts", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async () =>
      jsonResponse({ error: { message: "unavailable" } }, 503),
    );
    const { getFireworksClient } = await import("../src/fireworks/client.js");
    const pending = getFireworksClient()
      .models.list()
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ status: 503 });
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it("does not replay a successful HTTP response when its stream fails", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream disconnected"));
      },
    });
    mocks.fetch.mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const { getFireworksClient } = await import("../src/fireworks/client.js");
    const stream = await getFireworksClient().chat.completions.create({
      model: "accounts/fireworks/models/glm-5p3",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    await expect(async () => {
      for await (const _chunk of stream) {
        // The stream is interrupted before its first chunk.
      }
    }).rejects.toThrow("stream disconnected");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
