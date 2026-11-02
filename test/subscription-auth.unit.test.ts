import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRemoteSubscriptionToken } from "../src/subscription-auth.js";
import { getXaiSubscriptionAuth } from "../src/xai/auth.js";

beforeEach(() => {
  vi.stubEnv("LLM_AUTH_URL", "https://auth.example");
  vi.stubEnv("LLM_AUTH_API_KEY", "caller-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shared subscription authentication", () => {
  it("uses remote Grok tokens without a local CLI, and pins forced refresh to the selected account", async () => {
    vi.stubEnv("PATH", "");
    vi.stubEnv("GROK_AUTH_PATH", "/missing/auth.json");
    const fetch = vi.fn(async (input: URL, init: RequestInit) => {
      expect(input.searchParams.get("provider")).toBe("xai");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer caller-secret");
      expect(init.redirect).toBe("error");
      return Response.json({
        provider: "xai",
        accessToken: "remote-token",
        accountId: "xai:person",
        clientVersion: "1.0.67",
        expiresAt: Date.now() + 3600_000,
      });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await getXaiSubscriptionAuth()).toEqual({
      token: "remote-token",
      accountId: "xai:person",
      clientVersion: "1.0.67",
    });
    await getXaiSubscriptionAuth({ forceRefresh: true, accountId: "xai:person" });
    const url = fetch.mock.calls[1]![0];
    expect(url.searchParams.get("refresh")).toBe("1");
    expect(url.searchParams.get("accountId")).toBe("xai:person");
  });
  it("fails closed for incomplete configuration, remote errors, and provider mismatches", async () => {
    vi.stubEnv("LLM_AUTH_API_KEY", "");
    await expect(getRemoteSubscriptionToken("xai")).rejects.toThrow("Set both");
    vi.stubEnv("LLM_AUTH_API_KEY", "caller-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private server error", { status: 503 })),
    );
    await expect(getRemoteSubscriptionToken("xai")).rejects.toThrow("failed (503)");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          provider: "openai",
          accessToken: "token",
          accountId: "account",
          expiresAt: Date.now() + 3600_000,
        }),
      ),
    );
    await expect(getRemoteSubscriptionToken("xai")).rejects.toThrow("invalid xai");
  });
  it("ignores retired settings and permits local auth only when the new gateway settings are absent", async () => {
    vi.stubEnv("LLM_AUTH_URL", "");
    vi.stubEnv("LLM_AUTH_API_KEY", "");
    vi.stubEnv("CHATGPT_AUTH_TOKEN_PROVIDER_URL", "https://retired.example");
    vi.stubEnv("CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY", "retired-key");
    expect(await getRemoteSubscriptionToken("openai")).toBeNull();
    vi.stubEnv("LLM_AUTH_URL", "http://remote.example");
    vi.stubEnv("LLM_AUTH_API_KEY", "caller-secret");
    await expect(getRemoteSubscriptionToken("openai")).rejects.toThrow("HTTPS");
  });
});
