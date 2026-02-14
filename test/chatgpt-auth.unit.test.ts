import { describe, expect, it, vi } from "vitest";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("chatgpt-auth", () => {
  it("extracts chatgpt_account_id from the namespaced JWT claim", async () => {
    vi.resetModules();

    process.env.CHATGPT_AUTH_SERVER_URL = "";
    process.env.CHATGPT_AUTH_API_KEY = "";

    process.env.CHATGPT_AUTH_JSON = "";
    process.env.CHATGPT_AUTH_JSON_B64 = "";
    delete process.env.CHATGPT_ACCOUNT_ID;

    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    process.env.CHATGPT_ACCESS_TOKEN = makeJwt({
      exp: expSeconds,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_123" },
    });
    process.env.CHATGPT_REFRESH_TOKEN = "rt_test";

    const { getChatGptAuthProfile } = await import("../src/openai/chatgpt-auth.js");
    const profile = await getChatGptAuthProfile();

    expect(profile.accountId).toBe("acct_test_123");
    expect(profile.access).toContain(".");
  });

  it("reuses known account id when refreshed tokens are opaque", async () => {
    vi.resetModules();

    process.env.CHATGPT_AUTH_SERVER_URL = "";
    process.env.CHATGPT_AUTH_API_KEY = "";
    process.env.CHATGPT_AUTH_SERVER_STORE = "";

    process.env.CHATGPT_AUTH_JSON = "";
    process.env.CHATGPT_AUTH_JSON_B64 = "";
    delete process.env.CHATGPT_ACCOUNT_ID;

    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const expiredMillis = Date.now() - 60_000;
    process.env.CHATGPT_EXPIRES = String(expiredMillis);
    process.env.CHATGPT_ACCESS_TOKEN = makeJwt({
      exp: expSeconds,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_opaque" },
    });
    process.env.CHATGPT_ID_TOKEN = makeJwt({
      exp: expSeconds,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_opaque" },
    });
    process.env.CHATGPT_REFRESH_TOKEN = "rt_test";

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(init?.method).toBe("POST");
      expect(String(init?.body ?? "")).toContain("grant_type=refresh_token");
      return new Response(
        JSON.stringify({
          access_token: "opaque_access_token",
          refresh_token: "opaque_refresh_token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getChatGptAuthProfile } = await import("../src/openai/chatgpt-auth.js");
    const profile = await getChatGptAuthProfile();

    expect(profile.accountId).toBe("acct_test_opaque");
    expect(profile.access).toBe("opaque_access_token");
    expect(profile.refresh).toBe("opaque_refresh_token");
    expect(profile.idToken).toBe(process.env.CHATGPT_ID_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses CHATGPT_AUTH_SERVER_URL when configured (no local refresh)", async () => {
    vi.resetModules();

    process.env.CHATGPT_AUTH_SERVER_URL = "https://example.invalid";
    process.env.CHATGPT_AUTH_API_KEY = "k_test";
    process.env.CHATGPT_AUTH_SERVER_STORE = "kv";

    process.env.CHATGPT_AUTH_JSON = "";
    process.env.CHATGPT_AUTH_JSON_B64 = "";
    process.env.CHATGPT_ACCESS_TOKEN = "";
    process.env.CHATGPT_REFRESH_TOKEN = "";

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      expect(url).toContain("/v1/token");
      expect(url).toContain("store=kv");
      return new Response(
        JSON.stringify({
          accessToken: "at_test",
          accountId: "acct_test",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getChatGptAuthProfile } = await import("../src/openai/chatgpt-auth.js");
    const a = await getChatGptAuthProfile();
    const b = await getChatGptAuthProfile();

    expect(a.access).toBe("at_test");
    expect(a.accountId).toBe("acct_test");
    expect(b.access).toBe("at_test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
