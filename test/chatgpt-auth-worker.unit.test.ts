import fs from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker from "../workers/chatgpt-auth/src/index.js";

const openDatabases: DatabaseSync[] = [];

class MemoryD1 {
  readonly database = new DatabaseSync(":memory:");
  constructor() {
    openDatabases.push(this.database);
    const migrations = new URL("../workers/chatgpt-auth/migrations/", import.meta.url);
    for (const name of fs
      .readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.database.exec(fs.readFileSync(new URL(name, migrations), "utf8"));
    }
  }
  prepare(query: string) {
    const statement = this.database.prepare(query);
    let values: SQLInputValue[] = [];
    const wrapper = {
      bind(...input: unknown[]) {
        values = input as SQLInputValue[];
        return wrapper;
      },
      async first<T>() {
        return (statement.get(...values) ?? null) as T | null;
      },
      async all<T>() {
        return { results: statement.all(...values) as T[] };
      },
      async run() {
        return { meta: { changes: Number(statement.run(...values).changes) } };
      },
    };
    return wrapper;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of openDatabases.splice(0)) db.close();
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function adminRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://auth.example${path}`, {
    ...init,
    headers: { authorization: "Bearer admin-secret", ...(init?.headers ?? {}) },
  });
}

async function readJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

type JsonObject = Record<string, any>;

describe("chatgpt-auth worker", () => {
  it("tests the pasted caller key with its real scope without exposing subscription credentials", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database };
    for (const accountId of ["a", "b"]) {
      await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            email: `${accountId}@example.com`,
            accessToken: `private-access-${accountId}`,
            refreshToken: `private-refresh-${accountId}`,
            expiresAt: Date.now() + 7200000,
          }),
        }),
        env,
      );
    }
    const created = await readJson(
      await worker.fetch(
        adminRequest("/v1/clients", {
          method: "POST",
          body: JSON.stringify({ name: "Checked app", accountIds: ["b"] }),
        }),
        env,
      ),
    );
    const test = (token: string, clientId?: string) =>
      worker.fetch(
        adminRequest("/v1/clients/test", {
          method: "POST",
          body: JSON.stringify({ token, ...(clientId ? { clientId } : {}) }),
        }),
        env,
      );
    expect(
      (
        await worker.fetch(
          new Request("https://auth.example/v1/clients/test", { method: "POST" }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request("https://auth.example/v1/clients/test", {
            method: "POST",
            headers: { authorization: `Bearer ${created.token}` },
            body: JSON.stringify({ token: created.token }),
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect((await worker.fetch(adminRequest("/v1/clients/test"), env)).status).toBe(405);
    expect((await test(" ")).status).toBe(400);
    expect((await test("x".repeat(4097))).status).toBe(400);
    expect(await readJson(await test("wrong-key"))).toMatchObject({
      ok: false,
      code: "invalid_key",
    });
    expect(await readJson(await test("admin-secret"))).toMatchObject({
      ok: false,
      code: "admin_key",
    });
    expect(await readJson(await test(created.token, "another-client"))).toMatchObject({
      ok: false,
      code: "wrong_key",
    });

    const response = await test(created.token, created.client.id);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      code: "ready",
      client: { id: created.client.id, name: "Checked app" },
      subscription: { accountId: "b", email: "b@example.com" },
    });
    expect(text).not.toContain(created.token);
    expect(text).not.toContain("private-access");
    expect(text).not.toContain("private-refresh");
    expect(text).not.toContain("accessToken");
    expect(
      (await readJson(await worker.fetch(adminRequest("/v1/clients"), env))).clients[0]
        .requestCount,
    ).toBe(1);

    await worker.fetch(
      adminRequest(`/v1/clients/${created.client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
      env,
    );
    expect(await readJson(await test(created.token))).toMatchObject({
      ok: false,
      code: "key_disabled",
    });
    await worker.fetch(
      adminRequest(`/v1/clients/${created.client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true, accountIds: [] }),
      }),
      env,
    );
    expect(await readJson(await test(created.token))).toMatchObject({
      ok: false,
      code: "no_usable_subscription",
    });
    await worker.fetch(
      adminRequest(`/v1/clients/${created.client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountIds: ["b"] }),
      }),
      env,
    );
    await worker.fetch(
      adminRequest("/v1/accounts/b", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env,
    );
    expect(await readJson(await test(created.token))).toMatchObject({
      ok: false,
      code: "no_usable_subscription",
    });
    await worker.fetch(
      adminRequest("/v1/accounts/b", { method: "PATCH", body: JSON.stringify({ enabled: true }) }),
      env,
    );

    const rotated = await readJson(
      await worker.fetch(
        adminRequest(`/v1/clients/${created.client.id}/rotate`, { method: "POST" }),
        env,
      ),
    );
    expect(await readJson(await test(created.token))).toMatchObject({
      ok: false,
      code: "invalid_key",
    });
    expect(await readJson(await test(rotated.token))).toMatchObject({
      ok: true,
      subscription: { accountId: "b" },
    });
    database.database
      .prepare("UPDATE chatgpt_auth_state SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 60000, "b");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    expect(await readJson(await test(rotated.token))).toMatchObject({
      ok: false,
      code: "no_usable_subscription",
    });
    await worker.fetch(adminRequest(`/v1/clients/${created.client.id}`, { method: "DELETE" }), env);
    expect(await readJson(await test(rotated.token))).toMatchObject({
      ok: false,
      code: "invalid_key",
    });
  });

  it("keeps admin cookies separate from a failed pasted-key check and rejects cross-origin checks", async () => {
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: new MemoryD1() };
    const login = await worker.fetch(
      new Request("https://auth.example/admin/session", {
        method: "POST",
        headers: { origin: "https://auth.example", "content-type": "application/json" },
        body: JSON.stringify({ key: "admin-secret" }),
      }),
      env,
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const check = (origin: string) =>
      worker.fetch(
        new Request("https://auth.example/v1/clients/test", {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ token: "invalid-pasted-key" }),
        }),
        env,
      );
    expect((await check("https://other.example")).status).toBe(403);
    const response = await check("https://auth.example");
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ ok: false, code: "invalid_key" });
    expect(
      (
        await worker.fetch(
          new Request("https://auth.example/v1/session", { headers: { cookie } }),
          env,
        )
      ).status,
    ).toBe(200);
  });

  it("uses a Google redirect with PKCE and admits only verified allowlisted identities", async () => {
    const database = new MemoryD1();
    const env = {
      CHATGPT_AUTH_API_KEY: "admin-secret",
      CHATGPT_AUTH_DB: database,
      ADMIN_BASE_URL: "https://auth.example",
      ADMIN_GOOGLE_CLIENT_ID: "test-client",
      ADMIN_GOOGLE_CLIENT_SECRET: "private-google-secret",
      ADMIN_ALLOWED_EMAILS: "owner@example.com",
    };
    const pair = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "google-test-key",
      alg: "RS256",
      use: "sig",
    };
    let nonce = "";
    let email = "owner@example.com";
    let verified = true;
    let audience = "test-client";
    let issuer = "https://accounts.google.com";
    let expired = false;
    let wrongSignature = false;
    let exchanges = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://www.googleapis.com/oauth2/v3/certs")
          return Response.json({ keys: [jwk] });
        expect(url).toBe("https://oauth2.googleapis.com/token");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_secret")).toBe("private-google-secret");
        expect(body.get("code_verifier")?.length).toBe(64);
        expect(body.get("redirect_uri")).toBe("https://auth.example/auth/callback");
        exchanges++;
        const token = await new SignJWT({ email, email_verified: verified, nonce })
          .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
          .setSubject("google-user")
          .setIssuer(issuer)
          .setAudience(audience)
          .setIssuedAt()
          .setExpirationTime(Math.floor(Date.now() / 1000) + (expired ? -120 : 3600))
          .sign(wrongSignature ? other.privateKey : pair.privateKey);
        return Response.json({ id_token: token, access_token: "must-not-leak" });
      }),
    );
    const begin = async () => {
      const start = await worker.fetch(new Request("https://auth.example/auth"), env);
      expect(start.status).toBe(302);
      const target = new URL(start.headers.get("location")!);
      expect(target.origin).toBe("https://accounts.google.com");
      expect(target.searchParams.get("scope")).toBe("openid email profile");
      expect(target.searchParams.get("code_challenge_method")).toBe("S256");
      expect(target.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      nonce = target.searchParams.get("nonce")!;
      return {
        state: target.searchParams.get("state")!,
        cookie: start.headers.get("set-cookie")!.split(";")[0]!,
      };
    };
    const callback = (flow: { state: string; cookie: string }) =>
      worker.fetch(
        new Request("https://auth.example/auth/callback?code=test&state=" + flow.state, {
          headers: { cookie: flow.cookie },
        }),
        env,
      );
    const flow = await begin();
    const login = await callback(flow);
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("https://auth.example/");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).not.toContain("private-google-secret");
    expect(cookie).not.toContain("owner@example.com");
    const session = () =>
      worker.fetch(new Request("https://auth.example/v1/session", { headers: { cookie } }), env);
    expect(await readJson(await session())).toMatchObject({
      email: "owner@example.com",
      role: "admin",
    });
    const exchangeCount = exchanges;
    expect((await callback(flow)).headers.get("location")).toContain("auth_error=expired");
    expect(exchanges).toBe(exchangeCount);
    env.ADMIN_ALLOWED_EMAILS = "other@example.com";
    expect((await session()).status).toBe(401);
    env.ADMIN_ALLOWED_EMAILS = "owner@example.com";
    const config = await (
      await worker.fetch(new Request("https://auth.example/admin/config"), env)
    ).text();
    expect(JSON.parse(config)).toEqual({ googleEnabled: true, keyLoginEnabled: false });
    expect(config).not.toContain("owner@example.com");
    expect(config).not.toContain("private-google-secret");
    for (const scenario of [
      "unlisted",
      "unverified",
      "audience",
      "issuer",
      "expired",
      "signature",
      "nonce",
    ]) {
      const next = await begin();
      email = scenario === "unlisted" ? "unlisted@example.com" : "owner@example.com";
      verified = scenario !== "unverified";
      audience = scenario === "audience" ? "wrong-client" : "test-client";
      issuer = scenario === "issuer" ? "https://untrusted.example" : "https://accounts.google.com";
      expired = scenario === "expired";
      wrongSignature = scenario === "signature";
      if (scenario === "nonce") nonce = "wrong-nonce";
      const denied = await callback(next);
      expect(denied.headers.get("location")).toContain("auth_error=");
      expect(denied.headers.get("set-cookie")).not.toContain("__Host-chatgpt_admin=");
    }
    const stateFlow = await begin();
    const before = exchanges;
    await callback({ ...stateFlow, state: "0".repeat(64) });
    expect(exchanges).toBe(before);
    expect(
      Number(
        database.database
          .prepare(
            "SELECT COUNT(*) AS count FROM chatgpt_auth_admin_sessions WHERE kind = 'session'",
          )
          .get()?.count,
      ),
    ).toBe(1);
    for (let attempt = 9; attempt < 20; attempt++) await begin();
    const throttled = await worker.fetch(new Request("https://auth.example/auth"), env);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.has("set-cookie")).toBe(false);
    const anotherIp = await worker.fetch(
      new Request("https://auth.example/auth", { headers: { "cf-connecting-ip": "192.0.2.1" } }),
      env,
    );
    expect(anotherIp.status).toBe(302);
  });

  it("preserves the original single-account login during migration", () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    const migration = (name: string) =>
      fs.readFileSync(
        new URL(`../workers/chatgpt-auth/migrations/${name}`, import.meta.url),
        "utf8",
      );
    db.exec(migration("0001_init.sql"));
    db.prepare(
      "INSERT INTO chatgpt_auth_state (id, access_token, refresh_token, expires_at, account_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "default",
      "original-access",
      "original-refresh",
      Date.now() + 7200000,
      "original-account",
      Date.now(),
    );
    db.exec(migration("0002_multi_account_and_clients.sql"));
    db.exec(migration("0003_admin_dashboard.sql"));
    expect(
      db.prepare("SELECT id, access_token, refresh_token, enabled FROM chatgpt_auth_state").get(),
    ).toMatchObject({
      id: "original-account",
      access_token: "original-access",
      refresh_token: "original-refresh",
      enabled: 1,
    });
  });

  it("rotates subscription accounts and audits named callers", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000;

    for (const suffix of ["b", "a"]) {
      const accountId = `acct_${suffix}`;
      const idToken = makeJwt({ email: `${suffix}@example.com`, chatgpt_account_id: accountId });
      const response = await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            accessToken: `access_${suffix}`,
            refreshToken: `refresh_${suffix}`,
            idToken,
            expiresAt,
            accountId,
            label: `Account ${suffix.toUpperCase()}`,
          }),
        }),
        env,
      );
      expect(response.status).toBe(200);
    }

    const createResponse = await worker.fetch(
      adminRequest("/v1/clients", {
        method: "POST",
        body: JSON.stringify({ name: "Vercel production" }),
      }),
      env,
    );
    expect(createResponse.status).toBe(201);
    const created = await readJson(createResponse);
    const clientToken = String(created.token);
    const clientId = String(created.client.id);

    const selectedAccounts: string[] = [];
    for (let index = 0; index < 4; index++) {
      const response = await worker.fetch(
        new Request("https://auth.example/v1/token", {
          headers: { authorization: `Bearer ${clientToken}`, "x-request-id": `request-${index}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const payload = await readJson(response);
      selectedAccounts.push(String(payload.accountId));
      expect(payload.caller).toEqual({ id: clientId, name: "Vercel production" });
    }
    expect(selectedAccounts).toEqual(["acct_a", "acct_b", "acct_a", "acct_b"]);

    const clients = await readJson(await worker.fetch(adminRequest("/v1/clients"), env));
    expect(clients.clients[0]).toMatchObject({
      id: clientId,
      name: "Vercel production",
      requestCount: 4,
      enabled: true,
    });

    const events = await readJson(
      await worker.fetch(adminRequest(`/v1/events?clientId=${encodeURIComponent(clientId)}`), env),
    );
    expect(events.events).toHaveLength(4);
    expect(events.events[0]).toMatchObject({
      clientId,
      clientName: "Vercel production",
      accountId: "acct_b",
      outcome: "issued",
    });

    const forbidden = await worker.fetch(
      new Request("https://auth.example/v1/accounts", {
        headers: { authorization: `Bearer ${clientToken}` },
      }),
      env,
    );
    expect(forbidden.status).toBe(403);
  });

  it("skips disabled subscription accounts", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000;
    for (const accountId of ["acct_a", "acct_b"]) {
      await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            accessToken: `access_${accountId}`,
            refreshToken: `refresh_${accountId}`,
            expiresAt,
            accountId,
          }),
        }),
        env,
      );
    }

    const disable = await worker.fetch(
      adminRequest("/v1/accounts/acct_b", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
      env,
    );
    expect(disable.status).toBe(200);

    for (let index = 0; index < 3; index++) {
      const payload = await readJson(await worker.fetch(adminRequest("/v1/token"), env));
      expect(payload.accountId).toBe("acct_a");
    }
  });

  it("enforces per-key subscription selection, including empty scopes and disabled accounts", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    for (const accountId of ["a", "b"]) {
      await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            accessToken: `access-${accountId}`,
            refreshToken: `refresh-${accountId}`,
            expiresAt: Date.now() + 7200000,
          }),
        }),
        env,
      );
    }
    const created = await readJson(
      await worker.fetch(
        adminRequest("/v1/clients", {
          method: "POST",
          body: JSON.stringify({ name: "Restricted", accountIds: ["b"] }),
        }),
        env,
      ),
    );
    const tokenRequest = () =>
      worker.fetch(
        new Request("https://auth.example/v1/token?accountId=a", {
          headers: { authorization: `Bearer ${created.token}` },
        }),
        env,
      );
    for (let i = 0; i < 3; i++) expect((await readJson(await tokenRequest())).accountId).toBe("b");
    await worker.fetch(
      adminRequest("/v1/accounts/b", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env,
    );
    expect((await tokenRequest()).status).toBe(503);
    await worker.fetch(
      adminRequest(`/v1/clients/${created.client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountIds: [] }),
      }),
      env,
    );
    expect((await tokenRequest()).status).toBe(503);
    await worker.fetch(
      adminRequest(`/v1/clients/${created.client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountIds: null }),
      }),
      env,
    );
    expect((await readJson(await tokenRequest())).accountId).toBe("a");
    const invalid = await worker.fetch(
      adminRequest(`/v1/clients/${created.client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountIds: ["missing"] }),
      }),
      env,
    );
    expect(invalid.status).toBe(400);
    expect(
      (await readJson(await worker.fetch(adminRequest("/v1/clients"), env))).clients[0].accountIds,
    ).toBeNull();
    database.database
      .prepare("UPDATE chatgpt_auth_clients SET account_ids = ?")
      .run("invalid-json");
    expect((await tokenRequest()).status).toBe(503);
  });

  it("rotates keys without widening access and permanently revokes deleted keys", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const created = await readJson(
      await worker.fetch(
        adminRequest("/v1/clients", {
          method: "POST",
          body: JSON.stringify({ name: "Rotatable", accountIds: [] }),
        }),
        env,
      ),
    );
    const id = created.client.id;
    const rotated = await readJson(
      await worker.fetch(adminRequest(`/v1/clients/${id}/rotate`, { method: "POST" }), env),
    );
    const use = (token: string) =>
      worker.fetch(
        new Request("https://auth.example/v1/token", {
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
      );
    expect(rotated.client.accountIds).toEqual([]);
    expect((await use(created.token)).status).toBe(401);
    expect((await use(rotated.token)).status).toBe(503);
    await worker.fetch(adminRequest(`/v1/clients/${id}`, { method: "DELETE" }), env);
    expect((await use(rotated.token)).status).toBe(401);
    expect(
      (await readJson(await worker.fetch(adminRequest("/v1/clients"), env))).clients,
    ).toHaveLength(0);
    expect(
      (
        await worker.fetch(
          adminRequest(`/v1/clients/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled: true }),
          }),
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (await worker.fetch(adminRequest(`/v1/clients/${id}/rotate`, { method: "POST" }), env))
        .status,
    ).toBe(404);
    const events = await readJson(await worker.fetch(adminRequest("/v1/events"), env));
    expect(events.events[0].clientName).toBe("Rotatable");
  });

  it("uses secure admin sessions, rejects cross-origin writes, and consumes sign-in tickets once", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const sessionRequest = (body: unknown, origin = "https://auth.example") =>
      worker.fetch(
        new Request("https://auth.example/admin/session", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
    expect((await sessionRequest({ key: "wrong" })).status).toBe(401);
    expect((await sessionRequest({ key: "admin-secret" }, "https://evil.example")).status).toBe(
      403,
    );
    const ticketResponse = await readJson(
      await worker.fetch(adminRequest("/v1/admin-links", { method: "POST" }), env),
    );
    const ticket = new URL(ticketResponse.url).hash.slice(7);
    const login = await sessionRequest({ ticket });
    expect(login.status).toBe(200);
    expect((await sessionRequest({ ticket })).status).toBe(401);
    const cookie = login.headers.get("set-cookie") ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"])
      expect(cookie).toContain(attribute);
    const headers = { cookie: cookie.split(";")[0] ?? "" };
    expect(
      (await worker.fetch(new Request("https://auth.example/v1/clients", { headers }), env)).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          new Request("https://auth.example/v1/clients", {
            method: "POST",
            headers: { ...headers, origin: "https://evil.example" },
            body: JSON.stringify({ name: "bad" }),
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const valid = await worker.fetch(
      new Request("https://auth.example/v1/clients", {
        method: "POST",
        headers: { ...headers, origin: "https://auth.example" },
        body: JSON.stringify({ name: "Web key" }),
      }),
      env,
    );
    expect(valid.status).toBe(201);
    const listed = await (
      await worker.fetch(new Request("https://auth.example/v1/clients", { headers }), env)
    ).text();
    expect(listed).not.toContain("admin-secret");
    expect(listed).not.toContain('"token_hash"');
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await worker.fetch(
      new Request("https://auth.example/admin/session", {
        method: "DELETE",
        headers: { ...headers, origin: "https://auth.example" },
      }),
      env,
    );
    expect(
      (await worker.fetch(new Request("https://auth.example/v1/clients", { headers }), env)).status,
    ).toBe(401);
  });

  it("expires sessions and invalidates them when the admin secret changes", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database };
    const login = await worker.fetch(
      new Request("https://auth.example/admin/session", {
        method: "POST",
        headers: { origin: "https://auth.example", "content-type": "application/json" },
        body: JSON.stringify({ key: "admin-secret" }),
      }),
      env,
    );
    const headers = { cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "" };
    env.CHATGPT_AUTH_API_KEY = "new-secret";
    expect(
      (await worker.fetch(new Request("https://auth.example/v1/session", { headers }), env)).status,
    ).toBe(401);
    env.CHATGPT_AUTH_API_KEY = "admin-secret";
    database.database.prepare("UPDATE chatgpt_auth_admin_sessions SET expires_at = 0").run();
    expect(
      (await worker.fetch(new Request("https://auth.example/v1/session", { headers }), env)).status,
    ).toBe(401);
  });

  it("aggregates grants by key and account without exposing credentials", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    await worker.fetch(
      adminRequest("/v1/seed", {
        method: "POST",
        body: JSON.stringify({
          accountId: "account",
          label: "Personal",
          accessToken: "private-access",
          refreshToken: "private-refresh",
          expiresAt: Date.now() + 7200000,
        }),
      }),
      env,
    );
    const key = await readJson(
      await worker.fetch(
        adminRequest("/v1/clients", {
          method: "POST",
          body: JSON.stringify({ name: "Application" }),
        }),
        env,
      ),
    );
    await worker.fetch(
      new Request("https://auth.example/v1/token", {
        headers: { authorization: `Bearer ${key.token}` },
      }),
      env,
    );
    const statsResponse = await worker.fetch(adminRequest("/v1/stats"), env);
    const text = await statsResponse.text();
    const stats = JSON.parse(text);
    expect(stats.totals.issued).toBe(1);
    expect(stats.byKey[0]).toMatchObject({ name: "Application", issued: 1 });
    expect(stats.bySubscription[0]).toMatchObject({ name: "Personal", issued: 1 });
    expect(stats.daily[0].issued).toBe(1);
    expect(text).not.toContain("private-access");
    expect(text).not.toContain("private-refresh");
    expect(text).not.toContain(key.token);
    const denied = await worker.fetch(
      new Request("https://auth.example/v1/stats", {
        headers: { authorization: `Bearer ${key.token}` },
      }),
      env,
    );
    expect(denied.status).toBe(403);
  });

  it("completes device sign-in server-side with polling limits and sanitized responses", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    let approved = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/usercode"))
          return Response.json({
            device_auth_id: "private-device-id",
            user_code: "ABCD-EFGH",
            interval: "5",
          });
        if (url.endsWith("/deviceauth/token"))
          return approved
            ? Response.json({
                authorization_code: "private-code",
                code_verifier: "private-verifier",
              })
            : Response.json({}, { status: 403 });
        if (url.endsWith("/oauth/token")) {
          expect(String(init?.body)).toContain("code_verifier=private-verifier");
          return Response.json({
            access_token: makeJwt({ chatgpt_account_id: "new-account" }),
            refresh_token: "private-refresh",
            id_token: makeJwt({ email: "user@example.com" }),
            expires_in: 7200,
          });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const started = await readJson(
      await worker.fetch(
        adminRequest("/v1/login/start", {
          method: "POST",
          body: JSON.stringify({ label: "New subscription" }),
        }),
        env,
      ),
    );
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(started)).not.toContain("private-device-id");
    const poll = () =>
      worker.fetch(adminRequest(`/v1/login/${started.id}/poll`, { method: "POST" }), env);
    expect((await readJson(await poll())).status).toBe("pending");
    expect(requests).toHaveLength(1);
    database.database.prepare("UPDATE chatgpt_auth_login_attempts SET next_poll_at = 0").run();
    expect((await readJson(await poll())).status).toBe("pending");
    approved = true;
    database.database.prepare("UPDATE chatgpt_auth_login_attempts SET next_poll_at = 0").run();
    const completed = await readJson(await poll());
    expect(completed.status).toBe("completed");
    expect(completed.account).toMatchObject({
      accountId: "new-account",
      label: "New subscription",
    });
    expect(JSON.stringify(completed)).not.toContain("private-refresh");
    expect(
      database.database
        .prepare("SELECT device_auth_id, user_code FROM chatgpt_auth_login_attempts")
        .get(),
    ).toMatchObject({ device_auth_id: null, user_code: null });
    const count = requests.length;
    expect((await readJson(await poll())).status).toBe("completed");
    expect(requests).toHaveLength(count);
  });

  it("sanitizes subscription-limit responses and imports JWT expiry correctly", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const seeded = await readJson(
      await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            tokens: {
              access_token: makeJwt({ chatgpt_account_id: "account", exp }),
              refresh_token: "private-refresh",
            },
          }),
        }),
        env,
      ),
    );
    expect(seeded.expiresAt).toBe(exp * 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          plan_type: "pro",
          access_token: "must-not-leak",
          rate_limit: {
            primary_window: { used_percent: 24, reset_at: 1800000000, limit_window_seconds: 18000 },
          },
        }),
      ),
    );
    const usage = await worker.fetch(
      adminRequest("/v1/accounts/account/usage", { method: "POST" }),
      env,
    );
    const text = await usage.text();
    expect(JSON.parse(text)).toMatchObject({ plan: "pro", primary: { usedPercent: 24 } });
    expect(text).not.toContain("must-not-leak");
  });

  it("recovers migrated subscription email, name, and plan from identity claims", async () => {
    const database = new MemoryD1();
    const env = { CHATGPT_AUTH_API_KEY: "admin-secret", CHATGPT_AUTH_DB: database } as never;
    const access = makeJwt({
      "https://api.openai.com/profile": { email: "owner@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "account", chatgpt_plan_type: "pro" },
    });
    await worker.fetch(
      adminRequest("/v1/seed", {
        method: "POST",
        body: JSON.stringify({
          accessToken: access,
          refreshToken: "private-refresh",
          idToken: makeJwt({ name: "Example Person" }),
          expiresAt: Date.now() + 7200000,
        }),
      }),
      env,
    );
    database.database.prepare("UPDATE chatgpt_auth_state SET email = NULL").run();
    const response = await worker.fetch(adminRequest("/v1/accounts"), env);
    const text = await response.text();
    expect(JSON.parse(text).accounts[0]).toMatchObject({
      email: "owner@example.com",
      plan: "pro",
      name: "Example Person",
    });
    expect(text).not.toContain(access);
    expect(text).not.toContain("private-refresh");
  });

  it("proxies usage for exactly the selected subscription and backfills email", async () => {
    const database = new MemoryD1();
    const env = {
      CHATGPT_AUTH_API_KEY: "admin-secret",
      CHATGPT_AUTH_DB: database,
      CHATGPT_CODEX_PROXY_URL: "https://proxy.example/api/codex/responses",
      CHATGPT_CODEX_PROXY_API_KEY: "usage-proxy-key",
    };
    for (const accountId of ["a", "b"])
      await worker.fetch(
        adminRequest("/v1/seed", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            accessToken: `access-${accountId}`,
            refreshToken: `private-refresh-${accountId}`,
            expiresAt: Date.now() + 7200000,
          }),
        }),
        env,
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe("https://proxy.example/api/codex/usage");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer usage-proxy-key");
        expect(JSON.parse(String(init?.body))).toEqual({ accessToken: "access-b", accountId: "b" });
        return Response.json({
          account_id: "b",
          email: "b@example.com",
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 42 } },
        });
      }),
    );
    const response = await worker.fetch(
      adminRequest("/v1/accounts/b/usage", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      accountId: "b",
      plan: "plus",
      primary: { usedPercent: 42 },
    });
    expect(text).not.toContain("access-b");
    expect(text).not.toContain("usage-proxy-key");
    expect(
      database.database.prepare("SELECT email FROM chatgpt_auth_state WHERE id = 'b'").get(),
    ).toMatchObject({ email: "b@example.com" });
    expect(
      database.database.prepare("SELECT email FROM chatgpt_auth_state WHERE id = 'a'").get(),
    ).toMatchObject({ email: null });
  });

  it("fails closed when the configured usage proxy has no secret", async () => {
    const database = new MemoryD1();
    const env = {
      CHATGPT_AUTH_API_KEY: "admin-secret",
      CHATGPT_AUTH_DB: database,
      CHATGPT_CODEX_PROXY_URL: "https://proxy.example",
    };
    await worker.fetch(
      adminRequest("/v1/seed", {
        method: "POST",
        body: JSON.stringify({
          accountId: "account",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 7200000,
        }),
      }),
      env,
    );
    const mocked = vi.fn();
    vi.stubGlobal("fetch", mocked);
    expect(
      (await worker.fetch(adminRequest("/v1/accounts/account/usage", { method: "POST" }), env))
        .status,
    ).toBe(503);
    expect(mocked).not.toHaveBeenCalled();
  });
});
