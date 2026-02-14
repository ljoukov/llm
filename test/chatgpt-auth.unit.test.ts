import { describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function makeTempCodexHome(): { dir: string; authPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-codex-"));
  const authPath = path.join(dir, "auth.json");
  return { dir, authPath };
}

function writeCodexAuthJson(
  authPath: string,
  tokens: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void {
  const doc = {
    OPENAI_API_KEY: null,
    last_refresh: "1970-01-01T00:00:00.000Z",
    tokens,
    ...(extra ?? {}),
  };
  fs.writeFileSync(authPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

describe("chatgpt-auth", () => {
  it("extracts chatgpt_account_id from the namespaced JWT claim", async () => {
    vi.resetModules();

    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL = "";
    process.env.CHATGPT_AUTH_SERVER_URL = "";
    process.env.CHATGPT_AUTH_API_KEY = "";

    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const { dir, authPath } = makeTempCodexHome();
    process.env.CODEX_HOME = dir;
    writeCodexAuthJson(authPath, {
      access_token: makeJwt({
        exp: expSeconds,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_123" },
      }),
      refresh_token: "rt_test",
    });

    const { getChatGptAuthProfile } = await import("../src/openai/chatgpt-auth.js");
    const profile = await getChatGptAuthProfile();

    expect(profile.accountId).toBe("acct_test_123");
    expect(profile.access).toContain(".");
  });

  it("reuses known account id when refreshed tokens are opaque", async () => {
    vi.resetModules();

    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL = "";
    process.env.CHATGPT_AUTH_SERVER_URL = "";
    process.env.CHATGPT_AUTH_API_KEY = "";
    process.env.CHATGPT_AUTH_SERVER_STORE = "";

    const expiredExpSeconds = Math.floor(Date.now() / 1000) - 60;
    const { dir, authPath } = makeTempCodexHome();
    process.env.CODEX_HOME = dir;
    const idToken = makeJwt({
      exp: expiredExpSeconds,
      email: "user@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_opaque" },
    });
    writeCodexAuthJson(authPath, {
      access_token: makeJwt({
        exp: expiredExpSeconds,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_opaque" },
      }),
      id_token: idToken,
      refresh_token: "rt_test",
    });

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
    expect(profile.idToken).toBe(idToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as any;
    expect(persisted.tokens.access_token).toBe("opaque_access_token");
    expect(persisted.tokens.refresh_token).toBe("opaque_refresh_token");
    expect(persisted.tokens.id_token).toBe(idToken);
    expect(persisted.tokens.account_id).toBe("acct_test_opaque");
  });

  it("uses CHATGPT_AUTH_TOKEN_PROVIDER_URL when configured (no local refresh)", async () => {
    vi.resetModules();

    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL = "https://example.invalid";
    process.env.CHATGPT_AUTH_API_KEY = "k_test";
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_STORE = "kv";
    process.env.CHATGPT_AUTH_SERVER_URL = "";

    const { dir, authPath } = makeTempCodexHome();
    process.env.CODEX_HOME = dir;
    writeCodexAuthJson(authPath, {
      access_token: makeJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_should_be_ignored" },
      }),
      refresh_token: "rt_should_be_ignored",
    });

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
