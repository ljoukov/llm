import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleCodexResponsesRequest,
  handleHealthRequest,
} from "../vercel/codex-proxy/src/handler.js";

describe("vercel codex proxy", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CODEX_PROXY_API_KEY = "proxy-key";
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL = "https://auth-worker.example";
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY = "worker-key";
    delete process.env.CHATGPT_AUTH_API_KEY;
    delete process.env.CHATGPT_AUTH_TOKEN_PROVIDER_STORE;
    delete process.env.CHATGPT_CODEX_UPSTREAM_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("requires the proxy bearer token before checking downstream config", async () => {
    const response = await handleHealthRequest(
      new Request("https://proxy.example/api/health", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("fetches a ChatGPT token and streams the upstream Codex response", async () => {
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_STORE = "d1";
    process.env.CHATGPT_CODEX_UPSTREAM_URL = "https://chatgpt.example/backend-api/codex/responses";

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://auth-worker.example/v1/token")) {
        expect(url).toBe("https://auth-worker.example/v1/token?store=d1");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer worker-key");
        expect(headers.get("x-chatgpt-auth")).toBe("worker-key");
        return Response.json({
          accessToken: "chatgpt-access",
          accountId: "chatgpt-account",
          expiresAt: Date.now() + 60_000,
        });
      }

      expect(url).toBe("https://chatgpt.example/backend-api/codex/responses");
      expect(init?.method).toBe("POST");
      expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer chatgpt-access");
      expect(headers.get("chatgpt-account-id")).toBe("chatgpt-account");
      expect(headers.get("x-codex-proxy-auth")).toBeNull();
      expect(headers.get("openai-beta")).toBe("responses=experimental");
      expect(headers.get("cf-connecting-ip")).toBeNull();
      expect(headers.get("cf-ray")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBeNull();
      expect(headers.get("x-forwarded-host")).toBeNull();
      expect(headers.get("x-vercel-id")).toBeNull();
      expect(headers.get("x-app-extra")).toBeNull();

      return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleCodexResponsesRequest(
      new Request("https://proxy.example/api/codex/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-key",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.10",
          "cf-ray": "test-ray",
          "x-forwarded-for": "203.0.113.10",
          "x-forwarded-host": "question-constellation.example",
          "x-vercel-id": "iad1::test",
          "x-app-extra": "should-not-forward",
        },
        body: JSON.stringify({
          model: "gpt-5.3-codex-spark",
          stream: true,
          input: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toContain('"delta":"OK"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
