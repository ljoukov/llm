import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../src/xai/auth.js", () => ({ getXaiSubscriptionAuth: mocks.auth }));
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

describe("xAI API and subscription transport", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    vi.resetModules();
    mocks.auth.mockReset();
    mocks.fetch.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubEnv("XAI_API_KEY", "fake-api-credential");
    vi.stubEnv("XAI_BASE_URL", "");
    vi.stubEnv("XAI_TIMEOUT_MS", "");
    mocks.auth.mockResolvedValue({
      token: "fake-subscription-credential",
      clientVersion: "1.0.67",
    });
    mocks.fetch.mockResolvedValue(jsonResponse({ data: [] }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses API credentials and endpoint without touching CLI login", async () => {
    const { getXaiClient } = await import("../src/xai/client.js");
    const client = await getXaiClient("grok-4.7");
    expect(client.apiKey).toBe("fake-api-credential");
    expect(client.maxRetries).toBe(0);
    expect(client.baseURL).toBe("https://api.x.ai/v1");
    await client.models.list();
    expect(mocks.auth).not.toHaveBeenCalled();
    const headers = new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fake-api-credential");
    expect(headers.has("x-xai-token-auth")).toBe(false);
  });

  it("requires the API credential even when a CLI login is available", async () => {
    vi.stubEnv("XAI_API_KEY", " ");
    const { getXaiClient } = await import("../src/xai/client.js");
    await expect(getXaiClient("grok-4.7", "api")).rejects.toThrow("XAI_API_KEY must be provided");
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("pins subscription credentials to the official proxy and sends model routing headers", async () => {
    vi.stubEnv("XAI_BASE_URL", "https://custom-api.example/v1");
    const { getXaiClient } = await import("../src/xai/client.js");
    const client = await getXaiClient("grok-4.7", "subscription");
    expect(client.baseURL).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(client.maxRetries).toBe(0);
    await client.models.list();
    const headers = new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fake-subscription-credential");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-model-override")).toBe("grok-4.7");
    expect(headers.get("x-grok-client-version")).toBe("1.0.67");
  });

  it("adopts a CLI credential refreshed by another process before a request", async () => {
    const { getXaiClient } = await import("../src/xai/client.js");
    const client = await getXaiClient("grok-4.7", "subscription");
    mocks.auth.mockResolvedValue({ token: "fake-rotated-credential", clientVersion: "1.0.68" });
    await client.models.list();
    const headers = new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fake-rotated-credential");
    expect(headers.get("x-grok-client-version")).toBe("1.0.68");
  });

  it("retries a rejected bearer once after the official CLI produces a new credential", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    mocks.auth
      .mockResolvedValueOnce({ token: "fake-old-credential", clientVersion: "1.0.67" })
      .mockResolvedValueOnce({ token: "fake-old-credential", clientVersion: "1.0.67" })
      .mockResolvedValueOnce({ token: "fake-new-credential", clientVersion: "1.0.67" });
    const { getXaiClient } = await import("../src/xai/client.js");
    await (await getXaiClient("grok-4.7", "subscription")).models.list();
    expect(mocks.auth).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const headers = new Headers(mocks.fetch.mock.calls[1]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fake-new-credential");
  });

  it("propagates CLI login errors without using an available API key", async () => {
    mocks.auth.mockRejectedValue(new Error("Run `grok login` to authenticate."));
    const { getXaiClient } = await import("../src/xai/client.js");
    await expect(getXaiClient("grok-4.7", "subscription")).rejects.toThrow("grok login");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails clearly when CLI refresh does not replace a rejected bearer", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ error: { message: "invalid session" } }, 401));
    const { getXaiClient } = await import("../src/xai/client.js");
    await expect((await getXaiClient("grok-4.7", "subscription")).models.list()).rejects.toThrow(
      "grok login",
    );
    expect(mocks.auth).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Authentication errors never fall back to the API credential.
    for (const call of mocks.fetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe(
        "Bearer fake-subscription-credential",
      );
    }
  });

  it("supports API endpoint and timeout overrides", async () => {
    vi.stubEnv("XAI_BASE_URL", " https://custom-api.example/v1 ");
    vi.stubEnv("XAI_TIMEOUT_MS", "12000");
    const { getXaiClient } = await import("../src/xai/client.js");
    const client = await getXaiClient("grok-4.7");
    expect(client.baseURL).toBe("https://custom-api.example/v1");
    expect(client.timeout).toBe(12_000);
  });

  it.each([
    "api",
    "subscription",
  ] as const)("retries a %s 429 before streaming and merges HTTP retry metrics", async (access) => {
    vi.useFakeTimers();
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({
            id: "completion",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const { runXaiCall } = await import("../src/xai/calls.js");
    let metrics: { attempts: number; retryDelayMs: number; overloadCount: number } | undefined;
    const pending = runXaiCall(
      async (client) => {
        const stream = await client.chat.completions.create({
          model: "grok-4.7",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        });
        let text = "";
        for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
        return text;
      },
      "grok-4.7",
      access,
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
    if (access === "subscription") {
      expect(mocks.auth).not.toHaveBeenCalledWith({ forceRefresh: true });
      for (const call of mocks.fetch.mock.calls) {
        expect(new Headers(call[1]?.headers).get("authorization")).toBe(
          "Bearer fake-subscription-credential",
        );
      }
    } else {
      expect(mocks.auth).not.toHaveBeenCalled();
    }
  });

  it.each([400, 401, 402, 403])("does not retry terminal API HTTP %s", async (status) => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse({ error: { message: "terminal failure" } }, status),
    );
    const { getXaiClient } = await import("../src/xai/client.js");
    await expect((await getXaiClient("grok-4.7", "api")).models.list()).rejects.toMatchObject({
      status,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("never repeats CLI refresh after a later transient retry rejects the bearer again", async () => {
    vi.useFakeTimers();
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "invalid" } }, 401));
    mocks.auth.mockImplementation(async (options?: { forceRefresh?: boolean }) => ({
      token: options?.forceRefresh ? "fake-new-credential" : "fake-old-credential",
      clientVersion: "1.0.67",
    }));
    const { getXaiClient } = await import("../src/xai/client.js");
    const pending = (await getXaiClient("grok-4.7", "subscription")).models
      .list()
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ status: 401 });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.auth.mock.calls.filter((call) => call[0]?.forceRefresh)).toHaveLength(1);
  });

  it("bounds xAI API transient failures to four total HTTP attempts", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async () => jsonResponse({ error: { message: "busy" } }, 503));
    const { getXaiClient } = await import("../src/xai/client.js");
    const pending = (await getXaiClient("grok-4.7", "api")).models.list().catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ status: 503 });
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    "api",
    "subscription",
  ] as const)("does not replay an established %s stream after it fails", async (access) => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream disconnected"));
      },
    });
    mocks.fetch.mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const { getXaiClient } = await import("../src/xai/client.js");
    const stream = await (await getXaiClient("grok-4.7", access)).chat.completions.create({
      model: "grok-4.7",
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

  it.each([
    "api",
    "subscription",
  ] as const)("honors user aborts during %s retry backoff", async (access) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async () =>
      jsonResponse({ error: { message: "rate limited" } }, 429),
    );
    const { getXaiClient } = await import("../src/xai/client.js");
    const client = await getXaiClient("grok-4.7", access);
    const pending = client.models.list({ signal: controller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ name: "Error", message: "Request was aborted." });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.auth).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("discovers separate route catalogues and leaves subscription cost unknown", async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse({
        data: [
          { id: "grok-4.7", name: "Grok 4.7", context_window: 500_000 },
          { id: "grok-4.7", name: "Grok 4.7" },
          { id: "grok-future-model", description: "New model", contextWindow: 900_000 },
          { id: "invalid-model" },
        ],
      }),
    );
    const { discoverXaiModels } = await import("../src/xai/discovery.js");
    const api = await discoverXaiModels("api");
    expect(api.map((model) => model.id)).toEqual(["grok-4.7", "grok-future-model"]);
    expect(api[0]?.pricing).toMatchObject({ inputRate: 2 / 1_000_000 });
    expect(api[0]?.contextWindow).toBe(500_000);
    expect(api[1]?.contextWindow).toBe(900_000);
    expect(api[1]?.pricing).toBeUndefined();
    const subscription = await discoverXaiModels("subscription");
    expect(subscription.every((model) => model.pricing === undefined)).toBe(true);
  });
});
