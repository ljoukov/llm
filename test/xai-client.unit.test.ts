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
    vi.clearAllMocks();
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
    vi.unstubAllEnvs();
  });

  it("uses API credentials and endpoint without touching CLI login", async () => {
    const { getXaiClient } = await import("../src/xai/client.js");
    const client = await getXaiClient("grok-4.7");
    expect(client.apiKey).toBe("fake-api-credential");
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
    // The underlying SDK may retry transport errors, but no request switches to API auth.
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
