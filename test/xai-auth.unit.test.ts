import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";
import { getXaiSubscriptionAuth } from "../src/xai/auth.js";

const SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const tempDirs: string[] = [];

function session(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "test-session-token",
    auth_mode: "oidc",
    create_time: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    oidc_issuer: "https://auth.x.ai",
    refresh_token: "test-refresh-token",
    ...extra,
  };
}

async function fixture(
  store: Record<string, unknown> = { [SCOPE]: session() },
  helper = "",
): Promise<{ dir: string; authPath: string; callsPath: string; original: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-grok-auth-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  const authPath = path.join(dir, "auth.json");
  const callsPath = path.join(dir, "helper-calls.jsonl");
  const original = JSON.stringify(store, null, 3);
  await fs.writeFile(authPath, original, { mode: 0o600 });
  await fs.writeFile(
    path.join(bin, "grok"),
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("grok 1.0.67\\n");
} else {
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
    args: process.argv.slice(2),
    apiKeyPresent: !!process.env.XAI_API_KEY,
    legacyKeyPresent: !!process.env.GROK_CODE_XAI_API_KEY,
    otherKeyPresent: !!process.env.GROK_API_KEY,
    deploymentKeyPresent: !!process.env.GROK_DEPLOYMENT_KEY,
    apiKeyDisabled: process.env.GROK_DISABLE_API_KEY_AUTH,
    grokHome: process.env.GROK_HOME,
    authPath: process.env.GROK_AUTH_PATH,
  }) + "\\n");
  ${helper}
}
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH || ""}`);
  vi.stubEnv("GROK_HOME", dir);
  vi.stubEnv("GROK_AUTH_PATH", authPath);
  for (const name of [
    "GROK_AUTH",
    "GROK_OIDC_ISSUER",
    "GROK_OIDC_CLIENT_ID",
    "GROK_OAUTH2_ISSUER",
    "GROK_OAUTH2_CLIENT_ID",
  ]) {
    vi.stubEnv(name, "");
  }
  return { dir, authPath, callsPath, original };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetRuntimeSingletonsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Grok subscription authentication", () => {
  it("reuses a live CLI session without changing any credential or invoking models", async () => {
    const { authPath, callsPath, original } = await fixture({
      [SCOPE]: session(),
      "xai::api_key": { key: "separate-api-secret", auth_mode: "api_key" },
      "unrelated::scope": { custom: "preserved" },
    });
    expect(await getXaiSubscriptionAuth()).toEqual({
      token: "test-session-token",
      clientVersion: "1.0.67",
    });
    expect(await fs.readFile(authPath, "utf8")).toBe(original);
    await expect(fs.stat(callsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses GROK_HOME when no explicit auth path is set and adopts sibling changes", async () => {
    const { authPath } = await fixture();
    vi.stubEnv("GROK_AUTH_PATH", "");
    expect((await getXaiSubscriptionAuth()).token).toBe("test-session-token");
    await fs.writeFile(
      authPath,
      JSON.stringify({ [SCOPE]: session({ key: "sibling-new-token" }) }),
    );
    expect((await getXaiSubscriptionAuth()).token).toBe("sibling-new-token");
  });

  it("delegates expired credentials to one official CLI helper without API fallback", async () => {
    const expired = session({ expires_at: new Date(Date.now() - 60_000).toISOString() });
    const { dir, authPath, callsPath } = await fixture(
      { [SCOPE]: expired, untouched: { key: "not-a-selected-session" } },
      `setTimeout(() => {
        const p = process.env.GROK_AUTH_PATH;
        const store = JSON.parse(fs.readFileSync(p, "utf8"));
        store[${JSON.stringify(SCOPE)}].key = "new-session-token";
        store[${JSON.stringify(SCOPE)}].expires_at = new Date(Date.now() + 3600000).toISOString();
        fs.writeFileSync(p, JSON.stringify(store));
      }, 100);`,
    );
    vi.stubEnv("XAI_API_KEY", "must-not-fallback");
    vi.stubEnv("GROK_CODE_XAI_API_KEY", "must-not-fallback-legacy");
    vi.stubEnv("GROK_API_KEY", "must-not-fallback-either");
    vi.stubEnv("GROK_DEPLOYMENT_KEY", "must-not-use-deployment");
    const results = await Promise.all([getXaiSubscriptionAuth(), getXaiSubscriptionAuth()]);
    expect(results.map((result) => result.token)).toEqual([
      "new-session-token",
      "new-session-token",
    ]);
    const calls = (await fs.readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      {
        args: ["--no-auto-update", "models"],
        apiKeyPresent: false,
        legacyKeyPresent: false,
        otherKeyPresent: false,
        deploymentKeyPresent: false,
        apiKeyDisabled: "1",
        grokHome: dir,
        authPath,
      },
    ]);
    const after = JSON.parse(await fs.readFile(authPath, "utf8"));
    expect(after.untouched).toEqual({ key: "not-a-selected-session" });
    expect(after[SCOPE].refresh_token).toBe("test-refresh-token");
  });

  it("checks resulting freshness rather than trusting a successful cached models list", async () => {
    const { authPath, original } = await fixture({
      [SCOPE]: session({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
    });
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/expired saved session.*grok login/u);
    expect(await fs.readFile(authPath, "utf8")).toBe(original);
  });

  it("lets the lock-owning CLI finish after a caller timeout and shares that pending refresh", async () => {
    const { authPath, callsPath } = await fixture(
      { [SCOPE]: session() },
      `setTimeout(() => {
        const p = process.env.GROK_AUTH_PATH;
        const store = JSON.parse(fs.readFileSync(p, "utf8"));
        store[${JSON.stringify(SCOPE)}].key = "completed-after-caller-timeout";
        store[${JSON.stringify(SCOPE)}].expires_at = new Date(Date.now() + 3600000).toISOString();
        fs.writeFileSync(p, JSON.stringify(store));
      }, 600);`,
    );
    // Cache the safe version probe before advancing the caller's timeout clock.
    await getXaiSubscriptionAuth();
    await fs.writeFile(
      authPath,
      JSON.stringify({
        [SCOPE]: session({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      }),
    );
    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = getXaiSubscriptionAuth().catch((error: unknown) => error);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await fs.stat(callsPath).catch(() => null)) break;
      await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
    }
    expect(await fs.stat(callsPath)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(45_000);
    const timeoutError = await pending;
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toMatch(/refresh is still running/u);
    vi.useRealTimers();
    expect((await getXaiSubscriptionAuth()).token).toBe("completed-after-caller-timeout");
    expect((await fs.readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("can request a CLI-owned refresh after server rejection of a live bearer", async () => {
    const { callsPath } = await fixture();
    expect((await getXaiSubscriptionAuth({ forceRefresh: true })).token).toBe("test-session-token");
    expect((await fs.readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("does not expose helper output when refresh fails", async () => {
    await fixture(
      { [SCOPE]: session({ expires_at: new Date(Date.now() - 1_000).toISOString() }) },
      'process.stderr.write("private-token-must-never-escape"); process.exitCode = 1;',
    );
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(
      "Grok subscription authentication could not refresh its saved session. Run `grok login` and retry.",
    );
  });

  it.each([
    "api_key",
    "web_login",
    "grok",
    "unknown",
  ])("rejects %s credentials without using the API key route", async (mode) => {
    await fixture({ [SCOPE]: session({ auth_mode: mode, oidc_issuer: "https://other.example" }) });
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/current account login/u);
  });

  it("refuses enterprise issuer credentials on the pinned public subscription endpoint", async () => {
    await fixture({ [SCOPE]: session({ oidc_issuer: "https://corporate-idp.example" }) });
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/official auth.x.ai/u);
    vi.stubEnv("GROK_OIDC_ISSUER", "https://corporate-idp.example");
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/official auth.x.ai/u);
  });

  it("only accepts external-provider sessions from the official account issuer", async () => {
    const { authPath } = await fixture({ [SCOPE]: session({ auth_mode: "external" }) });
    expect((await getXaiSubscriptionAuth()).token).toBe("test-session-token");
    await fs.writeFile(
      authPath,
      JSON.stringify({
        [SCOPE]: session({ auth_mode: "external", oidc_issuer: "https://corporate-idp.example" }),
      }),
    );
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/official auth.x.ai/u);
  });

  it("resolves relative auth paths before starting the refresh owner", async () => {
    const { dir, authPath, callsPath } = await fixture();
    vi.stubEnv("GROK_HOME", path.relative(process.cwd(), dir));
    vi.stubEnv("GROK_AUTH_PATH", path.relative(process.cwd(), authPath));
    await getXaiSubscriptionAuth({ forceRefresh: true });
    const call = JSON.parse((await fs.readFile(callsPath, "utf8")).trim());
    expect(call.grokHome).toBe(dir);
    expect(call.authPath).toBe(authPath);
  });

  it("supports inline CLI credentials but never rotates or persists them", async () => {
    const { authPath, original } = await fixture();
    vi.stubEnv("GROK_AUTH", JSON.stringify(session({ key: "inline-session" })));
    expect((await getXaiSubscriptionAuth()).token).toBe("inline-session");
    vi.stubEnv(
      "GROK_AUTH",
      JSON.stringify(session({ expires_at: new Date(Date.now() - 1_000).toISOString() })),
    );
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/cannot refresh inline GROK_AUTH/u);
    expect(await fs.readFile(authPath, "utf8")).toBe(original);
  });

  it("rejects a JWT whose expiry precedes the stored expiry", async () => {
    const jwt = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    await fixture({ [SCOPE]: session({ key: jwt }) });
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(/expired saved session/u);
  });

  it("reports malformed stores without echoing their contents", async () => {
    const { authPath } = await fixture();
    await fs.writeFile(authPath, "not-json-private-secret");
    await expect(getXaiSubscriptionAuth()).rejects.toThrow(
      "Grok subscription authentication could not read a valid saved session. Run `grok login` and retry.",
    );
  });
});
