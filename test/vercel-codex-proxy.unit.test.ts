import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleCodexImagesRequest,
  handleCodexResponsesRequest,
  handleCodexUsageRequest,
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
    delete process.env.CHATGPT_CODEX_IMAGES_UPSTREAM_URL;
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

  it("requires proxy authorization and a valid POST body for subscription usage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (
        await handleCodexUsageRequest(
          new Request("https://proxy.example/api/codex/usage", { method: "POST", body: "invalid" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleCodexUsageRequest(
          new Request("https://proxy.example/api/codex/usage", {
            headers: { authorization: "Bearer proxy-key" },
          }),
        )
      ).status,
    ).toBe(405);
    for (const body of ["invalid", "null", "[]", '{"accessToken":"token"}']) {
      const result = await handleCodexUsageRequest(
        new Request("https://proxy.example/api/codex/usage", {
          method: "POST",
          headers: { authorization: "Bearer proxy-key" },
          body,
        }),
      );
      expect(result.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up the selected account without selecting another pool account or leaking credentials", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer selected-access");
      expect(headers.get("chatgpt-account-id")).toBe("selected-account");
      expect(headers.get("x-codex-proxy-auth")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("cf-ray")).toBeNull();
      return Response.json({
        account_id: "selected-account",
        email: "owner@example.com",
        plan_type: "pro",
        access_token: "must-not-leak",
        rate_limit: {
          limit_reached: false,
          primary_window: {
            used_percent: 31,
            reset_at: 1800000000,
            limit_window_seconds: 18000,
            refresh_token: "also-private",
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleCodexUsageRequest(
      new Request("https://proxy.example/api/codex/usage", {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-key",
          cookie: "must-not-forward",
          "cf-ray": "must-not-forward",
        },
        body: JSON.stringify({
          accessToken: "selected-access",
          accountId: "selected-account",
          upstreamUrl: "https://untrusted.example",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      account_id: "selected-account",
      email: "owner@example.com",
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 31 } },
    });
    for (const secret of ["selected-access", "proxy-key", "must-not-leak", "also-private"])
      expect(text).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched usage account and sanitizes upstream failures", async () => {
    const request = () =>
      new Request("https://proxy.example/api/codex/usage", {
        method: "POST",
        headers: { authorization: "Bearer proxy-key" },
        body: JSON.stringify({ accessToken: "access", accountId: "selected-account" }),
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ account_id: "wrong-account", email: "wrong@example.com" })),
    );
    const mismatch = await handleCodexUsageRequest(request());
    expect(mismatch.status).toBe(502);
    expect(await mismatch.text()).not.toContain("wrong@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private upstream error", { status: 403 })),
    );
    const failed = await handleCodexUsageRequest(request());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("private upstream error");
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
          model: "gpt-6-luna",
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

  it("forwards image generation as JSON to an endpoint derived from the Codex responses URL", async () => {
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_STORE = "d1";
    process.env.CHATGPT_CODEX_UPSTREAM_URL =
      "https://chatgpt.example/backend-api/codex/responses?workspace=test";
    const requestBody = {
      model: "gpt-image-2",
      prompt: "Draw a small lighthouse at dusk.",
      background: "auto",
      quality: "high",
      size: "1024x1024",
    };

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://auth-worker.example/v1/token")) {
        return Response.json({
          accessToken: "chatgpt-access",
          accountId: "chatgpt-account",
          expiresAt: Date.now() + 60_000,
        });
      }

      expect(url).toBe(
        "https://chatgpt.example/backend-api/codex/images/generations?workspace=test",
      );
      expect(init?.method).toBe("POST");
      expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("openai-beta")).toBeNull();
      expect(headers.get("authorization")).toBe("Bearer chatgpt-access");
      expect(headers.get("chatgpt-account-id")).toBe("chatgpt-account");
      expect(headers.get("x-codex-proxy-auth")).toBeNull();
      expect(headers.get("originator")).toBe("llm-vercel-codex-proxy");
      await expect(new Response(init?.body).json()).resolves.toEqual(requestBody);

      return Response.json(
        {
          created: 1,
          data: [{ b64_json: "generated-image" }],
          quality: "high",
          size: "1024x1024",
        },
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleCodexImagesRequest(
      new Request("https://proxy.example/api/codex/images/generations", {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-key",
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          "x-codex-proxy-auth": "must-not-forward",
        },
        body: JSON.stringify(requestBody),
      }),
      "generations",
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      data: [{ b64_json: "generated-image" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards image edits to the configured images upstream without Responses headers", async () => {
    process.env.CHATGPT_CODEX_IMAGES_UPSTREAM_URL =
      "https://images.example/backend-api/codex/images/generations?region=iad";
    const requestBody = {
      model: "gpt-image-2",
      prompt: "Replace the sky with an aurora.",
      images: [{ image_url: "data:image/png;base64,source-image" }],
      background: "auto",
      quality: "auto",
      size: "auto",
    };

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://auth-worker.example/v1/token")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer worker-key");
        return Response.json({
          access_token: "chatgpt-edit-access",
          account_id: "chatgpt-edit-account",
          expires_at: Math.floor(Date.now() / 1000) + 60,
        });
      }

      expect(url).toBe("https://images.example/backend-api/codex/images/edits?region=iad");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("openai-beta")).toBeNull();
      expect(headers.get("authorization")).toBe("Bearer chatgpt-edit-access");
      expect(headers.get("chatgpt-account-id")).toBe("chatgpt-edit-account");
      expect(headers.get("x-codex-proxy-auth")).toBeNull();
      await expect(new Response(init?.body).json()).resolves.toEqual(requestBody);

      return Response.json({
        created: 2,
        data: [{ b64_json: "edited-image" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleCodexImagesRequest(
      new Request("https://proxy.example/api/codex/images/edits", {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }),
      "edits",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      created: 2,
      data: [{ b64_json: "edited-image" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
