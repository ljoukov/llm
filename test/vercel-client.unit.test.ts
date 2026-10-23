import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

describe("Vercel AI Gateway client", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    vi.resetModules();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "vercel-unit-test-key");
    vi.stubEnv("AI_GATEWAY_BASE_URL", "");
    vi.stubEnv("AI_GATEWAY_TIMEOUT_MS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("authenticates the OpenAI-compatible endpoint with the gateway key", async () => {
    const { getVercelClient } = await import("../src/vercel/client.js");
    const client = getVercelClient();
    expect(client.apiKey).toBe("vercel-unit-test-key");
    expect(client.baseURL).toBe("https://ai-gateway.vercel.sh/v1");
    expect(client.timeout).toBe(15 * 60_000);
    expect(getVercelClient()).toBe(client);
  });

  it("supports a custom gateway endpoint and timeout", async () => {
    vi.stubEnv("AI_GATEWAY_BASE_URL", " https://gateway.example/v1 ");
    vi.stubEnv("AI_GATEWAY_TIMEOUT_MS", "12000");
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", " custom-key ");
    const { getVercelClient } = await import("../src/vercel/client.js");
    const client = getVercelClient();
    expect(client.apiKey).toBe("custom-key");
    expect(client.baseURL).toBe("https://gateway.example/v1");
    expect(client.timeout).toBe(12000);
  });

  it("requires gateway credentials even when Fireworks is configured", async () => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", " ");
    vi.stubEnv("FIREWORKS_API_KEY", "fireworks-unit-test-key");
    const { getVercelClient } = await import("../src/vercel/client.js");
    expect(getVercelClient).toThrow("VERCEL_AI_GATEWAY_API_KEY must be provided");
  });

  it("rejects the old credential variable without the new key", async () => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "old-credential-must-not-be-used");
    const { getVercelClient } = await import("../src/vercel/client.js");
    expect(getVercelClient).toThrow("VERCEL_AI_GATEWAY_API_KEY must be provided");
  });

  it("uses the new credential when the old variable is also present", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "old-credential-must-not-be-used");
    const { getVercelClient } = await import("../src/vercel/client.js");
    expect(getVercelClient().apiKey).toBe("vercel-unit-test-key");
  });

  it.each(["invalid", "0", "-1"])("ignores an invalid timeout %s", async (timeout) => {
    vi.stubEnv("AI_GATEWAY_TIMEOUT_MS", timeout);
    const { getVercelClient } = await import("../src/vercel/client.js");
    expect(getVercelClient().timeout).toBe(15 * 60_000);
  });
});
