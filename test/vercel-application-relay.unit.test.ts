import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApplicationResponsesRequest } from "../vercel/llm-proxy/src/handler.js";
const originalEnv = { ...process.env };
const request = (key = "llmc_application") =>
  new Request("https://relay.example/api/app/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: '{"model":"gpt-6-luna","input":"Hello"}',
  });
beforeEach(() => {
  process.env.LLM_AUTH_URL = "https://auth.example";
  process.env.LLM_AUTH_API_KEY = "shared-must-not-be-used";
  process.env.LLM_PROXY_API_KEY = "shared-proxy";
  delete process.env.LLM_PROXY_OPENAI_UPSTREAM_URL;
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});
describe("per-application inference relay", () => {
  it("uses the caller grant and removes caller credentials before inference", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(url).startsWith("https://auth.example/")) {
        expect(headers.get("authorization")).toBe("Bearer llmc_application");
        return Response.json({
          provider: "openai",
          accessToken: "selected-access",
          accountId: "selected-account",
          expiresAt: Date.now() + 3600000,
        });
      }
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(headers.get("authorization")).toBe("Bearer selected-access");
      expect(headers.get("chatgpt-account-id")).toBe("selected-account");
      expect(headers.get("x-llm-proxy-auth")).toBeNull();
      return new Response("event: done\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleApplicationResponsesRequest(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not fall back to shared credentials when a caller key is rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await handleApplicationResponsesRequest(request())).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not accept the shared relay key on the caller-key endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await handleApplicationResponsesRequest(request("shared-proxy"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
