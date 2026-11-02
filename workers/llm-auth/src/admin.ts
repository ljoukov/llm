import type { Env, Principal } from "./index.js";
import { isAllowedAdminEmail, verifyGoogleIdentity } from "./google.js";

const COOKIE = "__Host-llm_admin";
const GOOGLE_COOKIE = "__Host-llm_google";
const SESSION_MS = 8 * 60 * 60 * 1000;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTH_ORIGIN = "https://auth.openai.com";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cookie(token: string, maxAge = SESSION_MS / 1000, name = COOKIE): string {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function cookieToken(request: Request, name = COOKIE): string | null {
  const match = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  const token = match?.slice(name.length + 1);
  return token && /^[a-f0-9]{64}$/u.test(token) ? token : null;
}

export function protectResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (!secured.headers.has("content-security-policy"))
    secured.headers.set(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  return secured;
}

export async function serveDashboard(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "GET" ||
    !(
      ["/", "/admin", "/admin/", "/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"].includes(
        path,
      ) || path.startsWith("/_app/")
    )
  )
    return null;
  if (!env.ASSETS) return json({ error: "Dashboard assets unavailable." }, 503);
  const target = new URL(request.url);
  if (["/", "/admin", "/admin/"].includes(path)) target.pathname = "/";
  const response = await env.ASSETS.fetch(new Request(target, request));
  let result = new Response(response.body, response);
  if (response.headers.get("content-type")?.includes("text/html")) {
    const html = await response.text();
    const hashes: string[] = [];
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
      if (/\bsrc\s*=/iu.test(script[1] ?? "") || !script[2]?.trim()) continue;
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script[2])),
      );
      hashes.push(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
    }
    result = new Response(html, response);
    result.headers.set(
      "content-security-policy",
      `default-src 'none'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    result.headers.set("cache-control", "no-store");
  }
  return protectResponse(result);
}

export async function authenticateSession(request: Request, env: Env): Promise<Principal | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.LLM_AUTH_DB.prepare(
    "SELECT token_hash, email, google_audience FROM llm_auth_admin_sessions WHERE token_hash = ?1 AND kind = 'session' AND expires_at > ?2 AND admin_key_hash = ?3",
  )
    .bind(await hash(token), Date.now(), await hash(env.LLM_AUTH_ADMIN_API_KEY))
    .first<{ email: string | null; google_audience: string | null }>();
  if (!row) return null;
  if (
    row.email &&
    (!isAllowedAdminEmail(env, row.email) ||
      row.google_audience !== env.ADMIN_GOOGLE_CLIENT_ID?.trim())
  )
    return null;
  return {
    id: "admin",
    name: row.email ?? "Admin",
    kind: "admin",
    ...(row.email ? { email: row.email } : {}),
  };
}

async function issueSession(
  env: Env,
  kind: "session" | "ticket",
  email: string | null = null,
): Promise<string> {
  const token = randomToken();
  await env.LLM_AUTH_DB.prepare(
    "INSERT INTO llm_auth_admin_sessions (token_hash, admin_key_hash, kind, expires_at, email, google_audience) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      await hash(token),
      await hash(env.LLM_AUTH_ADMIN_API_KEY),
      kind,
      Date.now() + (kind === "ticket" ? 60_000 : SESSION_MS),
      email,
      email ? env.ADMIN_GOOGLE_CLIENT_ID?.trim() : null,
    )
    .run();
  return token;
}

export async function handleAdminConfig(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  return json({
    googleEnabled: Boolean(
      env.ADMIN_GOOGLE_CLIENT_ID?.trim() && env.ADMIN_GOOGLE_CLIENT_SECRET?.trim(),
    ),
    keyLoginEnabled: !env.ADMIN_GOOGLE_CLIENT_ID?.trim() || env.ADMIN_ALLOW_KEY_LOGIN === "1",
  });
}

export async function handleGoogleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const clientId = env.ADMIN_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.ADMIN_GOOGLE_CLIENT_SECRET?.trim();
  const base = env.ADMIN_BASE_URL?.trim();
  if (!clientId || !clientSecret || !base)
    return json({ error: "Google sign-in is not configured." }, 503);
  const canonical = new URL(base).origin;
  const url = new URL(request.url);
  if (url.origin !== canonical) return Response.redirect(new URL("/auth", canonical).href, 302);
  const redirectUri = new URL("/auth/callback", canonical).href;
  const clearFlow = `${GOOGLE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const failure = (code: string) =>
    new Response(null, {
      status: 303,
      headers: {
        location: new URL(`/?auth_error=${code}`, canonical).href,
        "set-cookie": clearFlow,
        "cache-control": "no-store",
      },
    });
  if (url.pathname === "/auth") {
    if (await isLoginRateLimited(request, env))
      return json({ error: "Too many sign-in attempts. Try again in 10 minutes." }, 429);
    const token = randomToken();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    await env.LLM_AUTH_DB.prepare(
      "INSERT INTO llm_auth_google_logins (token_hash, state_hash, nonce_hash, code_verifier, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(await hash(token), await hash(state), await hash(nonce), verifier, Date.now() + 600_000)
      .run();
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        "set-cookie": `${GOOGLE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        "cache-control": "no-store",
      },
    });
  }
  if (url.pathname !== "/auth/callback") return json({ error: "not_found" }, 404);
  const token = cookieToken(request, GOOGLE_COOKIE);
  const state = url.searchParams.get("state");
  if (!token || !state || !/^[a-f0-9]{64}$/u.test(state)) return failure("invalid_state");
  const flow = await env.LLM_AUTH_DB.prepare(
    "DELETE FROM llm_auth_google_logins WHERE token_hash = ?1 AND state_hash = ?2 AND expires_at > ?3 RETURNING nonce_hash, code_verifier",
  )
    .bind(await hash(token), await hash(state), Date.now())
    .first<{ nonce_hash: string; code_verifier: string }>();
  if (!flow) return failure("expired");
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error")) return failure("cancelled");
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: flow.code_verifier,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return failure("verification_failed");
    const tokens = (await response.json()) as Record<string, unknown>;
    if (typeof tokens.id_token !== "string") return failure("verification_failed");
    const identity = await verifyGoogleIdentity(env, tokens.id_token);
    if ((await hash(identity.nonce)) !== flow.nonce_hash) return failure("verification_failed");
    if (!isAllowedAdminEmail(env, identity.email)) return failure("not_allowed");
    const session = await issueSession(env, "session", identity.email);
    const result = new Response(null, {
      status: 303,
      headers: {
        location: new URL("/", canonical).href,
        "set-cookie": cookie(session),
        "cache-control": "no-store",
      },
    });
    result.headers.append("set-cookie", clearFlow);
    return result;
  } catch {
    return failure("verification_failed");
  }
}

export async function handleAdminTicket(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const ticket = await issueSession(env, "ticket");
  return json({ url: `${new URL(request.url).origin}/#login=${ticket}`, expiresIn: 60 });
}

async function isLoginRateLimited(request: Request, env: Env): Promise<boolean> {
  const now = Date.now();
  const bucket = `${await hash(env.LLM_AUTH_ADMIN_API_KEY + (request.headers.get("cf-connecting-ip") ?? "local"))}:${Math.floor(now / 600_000)}`;
  const limit = await env.LLM_AUTH_DB.prepare(
    "INSERT INTO llm_auth_login_limits (bucket, attempts, expires_at) VALUES (?1, 1, ?2) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts",
  )
    .bind(bucket, now + 600_000)
    .first<{ attempts: number }>();
  return Number(limit?.attempts) > 20;
}

export async function handleAdminSession(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return json({ error: "Invalid request origin." }, 403);
  if (request.method === "DELETE") {
    const token = cookieToken(request);
    if (token)
      await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_admin_sessions WHERE token_hash = ?1")
        .bind(await hash(token))
        .run();
    return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Expected JSON." }, 400);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) return json({ error: "Expected JSON object." }, 400);
  const now = Date.now();
  if (await isLoginRateLimited(request, env))
    return json({ error: "Too many sign-in attempts. Try again in 10 minutes." }, 429);
  let authorized = false;
  if (typeof body.ticket === "string" && /^[a-f0-9]{64}$/u.test(body.ticket)) {
    const used = await env.LLM_AUTH_DB.prepare(
      "DELETE FROM llm_auth_admin_sessions WHERE token_hash = ?1 AND kind = 'ticket' AND expires_at > ?2 AND admin_key_hash = ?3 RETURNING token_hash",
    )
      .bind(await hash(body.ticket), now, await hash(env.LLM_AUTH_ADMIN_API_KEY))
      .first();
    authorized = Boolean(used);
  } else if (
    typeof body.key === "string" &&
    body.key &&
    env.LLM_AUTH_ADMIN_API_KEY &&
    (!env.ADMIN_GOOGLE_CLIENT_ID?.trim() || env.ADMIN_ALLOW_KEY_LOGIN === "1")
  ) {
    authorized = (await hash(body.key.trim())) === (await hash(env.LLM_AUTH_ADMIN_API_KEY));
  }
  if (!authorized) return json({ error: "Invalid admin key or expired sign-in link." }, 401);
  const session = await issueSession(env, "session");
  const response = json({ ok: true, expiresAt: now + SESSION_MS }, 200, {
    "set-cookie": cookie(session),
  });
  response.headers.append("set-cookie", cookie("", 0, GOOGLE_COOKIE));
  return response;
}

type SaveAccount = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export async function handleDeviceLogin(
  request: Request,
  env: Env,
  save: SaveAccount,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/login/start") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      (body.label !== undefined &&
        (typeof body.label !== "string" || body.label.trim().length > 100))
    )
      return json({ error: "Provide a label of at most 100 characters." }, 400);
    const provider = body.provider ?? "openai";
    if (provider !== "openai" && provider !== "xai")
      return json({ error: "Unsupported subscription provider." }, 400);
    if (provider === "xai" && !env.LLM_AUTH_GROK_CLIENT_VERSION)
      return json({ error: "Grok CLI version is not configured." }, 503);
    const response = await fetch(
      provider === "xai"
        ? "https://auth.x.ai/oauth2/device/code"
        : `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`,
      {
        method: "POST",
        headers: {
          "content-type":
            provider === "xai" ? "application/x-www-form-urlencoded" : "application/json",
        },
        body:
          provider === "xai"
            ? new URLSearchParams({
                client_id: GROK_CLIENT_ID,
                scope: "openid profile email offline_access grok-cli:access api:access",
              }).toString()
            : JSON.stringify({ client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok)
      return json(
        {
          error: `${provider === "xai" ? "Grok" : "OpenAI"} sign-in is unavailable (HTTP ${response.status}). Import a separate CLI auth file instead.`,
        },
        502,
      );
    const code = (await response.json()) as Record<string, unknown>;
    const userCode = code.user_code ?? code.usercode;
    const deviceCode = provider === "xai" ? code.device_code : code.device_auth_id;
    if (typeof deviceCode !== "string" || typeof userCode !== "string")
      return json({ error: "The provider returned an invalid sign-in response." }, 502);
    const intervalMs = Math.max(5000, Math.min(30_000, (Number(code.interval) || 5) * 1000));
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt =
      now +
      (provider === "xai" ? Math.min(1800, Math.max(60, Number(code.expires_in) || 900)) : 900) *
        1000;
    await env.LLM_AUTH_DB.prepare(
      "INSERT INTO llm_auth_login_attempts (id, device_auth_id, user_code, label, interval_ms, next_poll_at, expires_at, provider) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
      .bind(
        id,
        deviceCode,
        userCode,
        typeof body.label === "string" ? body.label.trim() : null,
        intervalMs,
        now + intervalMs,
        expiresAt,
        provider,
      )
      .run();
    return json({
      id,
      userCode,
      verificationUrl:
        provider === "xai"
          ? grokVerificationUrl(code.verification_uri)
          : `${AUTH_ORIGIN}/codex/device`,
      provider,
      intervalMs,
      expiresAt,
    });
  }
  const match = /^\/v1\/login\/([a-f0-9-]{36})(\/poll)?$/u.exec(path);
  if (!match) return json({ error: "not_found" }, 404);
  const id = match[1];
  if (request.method === "DELETE" && !match[2]) {
    await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_login_attempts WHERE id = ?1")
      .bind(id)
      .run();
    return json({ ok: true });
  }
  if (request.method !== "POST" || !match[2]) return json({ error: "method_not_allowed" }, 405);
  const now = Date.now();
  const current = await env.LLM_AUTH_DB.prepare(
    "SELECT * FROM llm_auth_login_attempts WHERE id = ?1",
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!current) return json({ error: "Sign-in attempt not found. Start a new sign-in." }, 404);
  if (Number(current.expires_at) <= now) return json({ status: "expired" });
  if (current.status !== "pending")
    return json({ status: current.status, accountId: current.account_id });
  const locked = await env.LLM_AUTH_DB.prepare(
    "UPDATE llm_auth_login_attempts SET lock_until = ?1 WHERE id = ?2 AND status = 'pending' AND next_poll_at <= ?3 AND lock_until < ?3 RETURNING id",
  )
    .bind(now + 60_000, id, now)
    .first();
  if (!locked) return json({ status: "pending", intervalMs: Number(current.interval_ms) });
  try {
    if (current.provider === "xai") {
      const response = await fetch("https://auth.x.ai/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: GROK_CLIENT_ID,
          device_code: String(current.device_auth_id),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      const tokens = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        if (tokens.error === "authorization_pending")
          return json({ status: "pending", intervalMs: Number(current.interval_ms) });
        if (tokens.error === "slow_down") {
          const interval = Number(current.interval_ms) + 5000;
          await env.LLM_AUTH_DB.prepare(
            "UPDATE llm_auth_login_attempts SET interval_ms = ?1 WHERE id = ?2",
          )
            .bind(interval, id)
            .run();
          return json({ status: "pending", intervalMs: interval });
        }
        throw new Error(`Grok sign-in failed (HTTP ${response.status}). Start a new sign-in.`);
      }
      const infoResponse = await fetch("https://auth.x.ai/oauth2/userinfo", {
        headers: { authorization: `Bearer ${String(tokens.access_token)}` },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (!infoResponse.ok) throw new Error("Could not verify the Grok account.");
      const info = (await infoResponse.json()) as Record<string, unknown>;
      const expiresIn = Number(tokens.expires_in);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0)
        throw new Error("Grok returned an invalid token expiry.");
      const account = await save({
        provider: "xai",
        clientVersion: env.LLM_AUTH_GROK_CLIENT_VERSION,
        label: current.label ?? undefined,
        auth: {
          auth_mode: "oidc",
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: GROK_CLIENT_ID,
          key: tokens.access_token,
          refresh_token: tokens.refresh_token,
          user_id: info.sub,
          email: info.email,
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        },
      });
      await env.LLM_AUTH_DB.prepare(
        "UPDATE llm_auth_login_attempts SET status = 'completed', account_id = ?1, device_auth_id = NULL, user_code = NULL WHERE id = ?2",
      )
        .bind(account.accountId, id)
        .run();
      return json({ status: "completed", account });
    }
    const response = await fetch(`${AUTH_ORIGIN}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: current.device_auth_id,
        user_code: current.user_code,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 403 || response.status === 404)
      return json({ status: "pending", intervalMs: Number(current.interval_ms) });
    if (!response.ok)
      throw new Error(
        `OpenAI sign-in polling failed (HTTP ${response.status}). Start a new sign-in.`,
      );
    const approval = (await response.json()) as Record<string, unknown>;
    if (
      typeof approval.authorization_code !== "string" ||
      typeof approval.code_verifier !== "string"
    )
      throw new Error("OpenAI returned an invalid approval. Start a new sign-in.");
    const tokensResponse = await fetch(`${AUTH_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback`,
        code: approval.authorization_code,
        code_verifier: approval.code_verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!tokensResponse.ok)
      throw new Error(
        `OpenAI sign-in exchange failed (HTTP ${tokensResponse.status}). Start a new sign-in.`,
      );
    const tokens = (await tokensResponse.json()) as Record<string, unknown>;
    const expiresIn = Number(tokens.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new Error("OpenAI returned an invalid token expiry.");
    const account = await save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: now + expiresIn * 1000,
      label: current.label ?? undefined,
    });
    await env.LLM_AUTH_DB.prepare(
      "UPDATE llm_auth_login_attempts SET status = 'completed', account_id = ?1, device_auth_id = NULL, user_code = NULL WHERE id = ?2",
    )
      .bind(account.accountId, id)
      .run();
    return json({ status: "completed", account });
  } catch (error) {
    await env.LLM_AUTH_DB.prepare(
      "UPDATE llm_auth_login_attempts SET status = 'failed', device_auth_id = NULL, user_code = NULL WHERE id = ?1",
    )
      .bind(id)
      .run();
    return json(
      {
        error: error instanceof Error ? error.message : "Sign-in failed. Start a new sign-in.",
        status: "failed",
      },
      502,
    );
  } finally {
    await env.LLM_AUTH_DB.prepare(
      "UPDATE llm_auth_login_attempts SET lock_until = 0, next_poll_at = ?1 WHERE id = ?2",
    )
      .bind(Date.now() + Number(current.interval_ms), id)
      .run();
  }
}

function grokVerificationUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Grok did not return a sign-in URL.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["auth.x.ai", "accounts.x.ai", "grok.com"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Grok returned an unexpected sign-in URL.");
  return url.toString();
}
