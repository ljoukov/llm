type TokenState = {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number; // epoch ms
  accountId: string;
  updatedAt: number; // epoch ms
};

type Env = {
  CHATGPT_AUTH_API_KEY: string;
  CHATGPT_AUTH_DB: D1Database;
  CHATGPT_AUTH_KV: KVNamespace;
};

const STATE_ID = "default";
const KV_KEY = "chatgpt_auth_state_v1";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 30_000;
const CRON_REFRESH_WITHIN_MS = 60 * 60 * 1000;

const LOCK_TTL_MS = 2 * 60 * 1000;

let memoryCache:
  | {
      state: TokenState;
      cachedAt: number;
    }
  | null = null;

function json(
  value: unknown,
  init?: ResponseInit & { headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, { status: 405 });
}

function getBearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ? m[1].trim() : null;
}

function getAuthToken(request: Request): string | null {
  const bearer = getBearer(request);
  if (bearer) return bearer;
  // Some accounts/setups appear to strip `Authorization` at the edge. Accept a custom header too.
  const alt = request.headers.get("x-chatgpt-auth") ?? request.headers.get("x-api-key") ?? "";
  return alt.trim().length > 0 ? alt.trim() : null;
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = getAuthToken(request);
  return Boolean(token && env.CHATGPT_AUTH_API_KEY && token === env.CHATGPT_AUTH_API_KEY);
}

function nowMs(): number {
  return Date.now();
}

function isExpired(state: Pick<TokenState, "expiresAt">, now: number): boolean {
  return now + ACCESS_TOKEN_EXPIRY_SAFETY_MS >= state.expiresAt;
}

function shouldRefreshWithin(state: Pick<TokenState, "expiresAt">, now: number, withinMs: number): boolean {
  return now + withinMs >= state.expiresAt;
}

function base64UrlDecodeToString(value: string): string {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return atob(b64);
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const jsonStr = base64UrlDecodeToString(parts[1] ?? "");
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function extractChatGptAccountIdFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return undefined;

  // Some tokens include it at the root.
  const direct = (payload as any).chatgpt_account_id;
  if (typeof direct === "string" && direct.length > 0) return direct;

  // Codex/ChatGPT tokens often nest it under this namespaced claim.
  const namespaced = (payload as any)["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof namespaced === "string" && namespaced.length > 0) return namespaced;

  return undefined;
}

function extractEmailFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return undefined;
  const email = (payload as any).email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "<redacted>";
  const prefix = local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

async function readStateFromKv(env: Env): Promise<TokenState | null> {
  const raw = await env.CHATGPT_AUTH_KV.get(KV_KEY, { type: "json" });
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  if (
    typeof o.accessToken !== "string" ||
    typeof o.refreshToken !== "string" ||
    typeof o.expiresAt !== "number" ||
    typeof o.accountId !== "string"
  ) {
    return null;
  }
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    idToken: typeof o.idToken === "string" ? o.idToken : undefined,
    expiresAt: o.expiresAt,
    accountId: o.accountId,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
  };
}

async function writeStateToKv(env: Env, state: TokenState): Promise<void> {
  await env.CHATGPT_AUTH_KV.put(KV_KEY, JSON.stringify(state));
}

async function readStateFromD1(env: Env): Promise<(TokenState & { lockUntil: number | null }) | null> {
  const row = (await env.CHATGPT_AUTH_DB.prepare(
    "SELECT access_token, refresh_token, id_token, expires_at, account_id, updated_at, lock_until FROM chatgpt_auth_state WHERE id = ?1",
  )
    .bind(STATE_ID)
    .first()) as any;

  if (!row) return null;
  return {
    accessToken: String(row.access_token ?? ""),
    refreshToken: String(row.refresh_token ?? ""),
    idToken: row.id_token ? String(row.id_token) : undefined,
    expiresAt: Number(row.expires_at ?? 0),
    accountId: String(row.account_id ?? ""),
    updatedAt: Number(row.updated_at ?? 0),
    lockUntil: row.lock_until === null || row.lock_until === undefined ? null : Number(row.lock_until),
  };
}

async function upsertStateToD1(env: Env, state: TokenState & { lockUntil?: number | null }): Promise<void> {
  await env.CHATGPT_AUTH_DB.prepare(
    `INSERT INTO chatgpt_auth_state (id, access_token, refresh_token, id_token, expires_at, account_id, updated_at, lock_until)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       access_token=excluded.access_token,
       refresh_token=excluded.refresh_token,
       id_token=excluded.id_token,
       expires_at=excluded.expires_at,
       account_id=excluded.account_id,
       updated_at=excluded.updated_at,
       lock_until=excluded.lock_until`,
  )
    .bind(
      STATE_ID,
      state.accessToken,
      state.refreshToken,
      state.idToken ?? null,
      state.expiresAt,
      state.accountId,
      state.updatedAt,
      state.lockUntil ?? null,
    )
    .run();
}

async function tryAcquireRefreshLock(env: Env, now: number): Promise<boolean> {
  const lockUntil = now + LOCK_TTL_MS;
  const result = await env.CHATGPT_AUTH_DB.prepare(
    "UPDATE chatgpt_auth_state SET lock_until = ?1 WHERE id = ?2 AND (lock_until IS NULL OR lock_until < ?3)",
  )
    .bind(lockUntil, STATE_ID, now)
    .run();
  return Number((result as any)?.meta?.changes ?? 0) > 0;
}

async function releaseRefreshLock(env: Env): Promise<void> {
  await env.CHATGPT_AUTH_DB.prepare("UPDATE chatgpt_auth_state SET lock_until = NULL WHERE id = ?1")
    .bind(STATE_ID)
    .run();
}

async function oauthRefresh(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  idToken?: string;
}> {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("client_id", OAUTH_CLIENT_ID);
  params.set("refresh_token", refreshToken);

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ChatGPT OAuth refresh failed (${resp.status}): ${body}`);
  }
  const payload = (await resp.json()) as any;
  const access = typeof payload.access_token === "string" ? payload.access_token : "";
  const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const expiresInRaw = payload.expires_in;
  const expiresIn = typeof expiresInRaw === "number" ? expiresInRaw : Number.parseFloat(String(expiresInRaw ?? "NaN"));
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;

  if (!access || !refresh || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("ChatGPT OAuth refresh returned an unexpected payload.");
  }
  return { accessToken: access, refreshToken: refresh, expiresIn, idToken };
}

async function refreshIfNeeded(env: Env, options: { withinMs: number; reason: string }): Promise<{
  state: TokenState;
  refreshed: boolean;
}> {
  const start = performance.now();
  const now = nowMs();
  const current = await readStateFromD1(env);
  if (!current) {
    throw new Error("No token state in D1. Seed the worker via POST /v1/seed.");
  }

  if (!shouldRefreshWithin(current, now, options.withinMs)) {
    // Keep KV warm.
    memoryCache = { state: current, cachedAt: now };
    void writeStateToKv(env, current);
    return { state: current, refreshed: false };
  }

  const locked = await tryAcquireRefreshLock(env, now);
  if (!locked) {
    // Someone else is refreshing; return what we have (still likely valid for some time).
    memoryCache = { state: current, cachedAt: now };
    return { state: current, refreshed: false };
  }

  try {
    // Re-read after lock to avoid refreshing a stale snapshot.
    const latest = await readStateFromD1(env);
    if (!latest) {
      throw new Error("Token state disappeared from D1.");
    }
    if (!shouldRefreshWithin(latest, now, options.withinMs)) {
      memoryCache = { state: latest, cachedAt: now };
      return { state: latest, refreshed: false };
    }

    const refreshed = await oauthRefresh(latest.refreshToken);
    const expiresAt = now + refreshed.expiresIn * 1000;
    const idToken = refreshed.idToken ?? latest.idToken;
    const accountId =
      extractChatGptAccountIdFromJwt(idToken ?? "") ??
      extractChatGptAccountIdFromJwt(refreshed.accessToken) ??
      latest.accountId;

    const newState: TokenState = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken,
      expiresAt,
      accountId,
      updatedAt: now,
    };

    await upsertStateToD1(env, { ...newState, lockUntil: null });
    await writeStateToKv(env, newState);
    memoryCache = { state: newState, cachedAt: now };

    const elapsed = Math.round(performance.now() - start);
    const email = extractEmailFromJwt(idToken ?? "");
    console.log(
      `[refresh] ok reason=${options.reason} account_id=${newState.accountId}${
        email ? ` email=${redactEmail(email)}` : ""
      } elapsed_ms=${elapsed}`,
    );
    return { state: newState, refreshed: true };
  } finally {
    await releaseRefreshLock(env);
  }
}

function redactTokenPreview(token: string): string {
  if (!token) return "";
  return token.length <= 16 ? "<redacted>" : `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function normalizeSeedInput(input: any): TokenState {
  const accessToken = input.accessToken ?? input.access_token ?? input.access ?? "";
  const refreshToken = input.refreshToken ?? input.refresh_token ?? input.refresh ?? "";
  const idToken = input.idToken ?? input.id_token ?? undefined;
  const accountId = input.accountId ?? input.account_id ?? "";
  const expiresAtRaw = input.expiresAt ?? input.expires_at ?? input.expires ?? undefined;

  const expiresAt = typeof expiresAtRaw === "number" ? expiresAtRaw : Number.parseFloat(String(expiresAtRaw ?? "NaN"));
  const now = nowMs();
  const exp = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : now + 5 * 60_000;

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("seed: missing accessToken");
  }
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new Error("seed: missing refreshToken");
  }
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    // Try to extract from JWTs if caller didn't provide it.
    const extracted =
      extractChatGptAccountIdFromJwt(typeof idToken === "string" ? idToken : "") ??
      extractChatGptAccountIdFromJwt(accessToken);
    if (!extracted) {
      throw new Error("seed: missing accountId");
    }
    return {
      accessToken: accessToken.trim(),
      refreshToken: refreshToken.trim(),
      idToken: typeof idToken === "string" ? idToken : undefined,
      expiresAt: exp,
      accountId: extracted,
      updatedAt: now,
    };
  }

  return {
    accessToken: accessToken.trim(),
    refreshToken: refreshToken.trim(),
    idToken: typeof idToken === "string" ? idToken : undefined,
    expiresAt: exp,
    accountId: accountId.trim(),
    updatedAt: now,
  };
}

async function handleSeed(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as any;
  if (!body || typeof body !== "object") return badRequest("Expected JSON body.");

  let state: TokenState;
  if (typeof body.authJsonB64 === "string" && body.authJsonB64.trim().length > 0) {
    try {
      const decoded = base64UrlDecodeToString(body.authJsonB64.trim());
      state = normalizeSeedInput(JSON.parse(decoded));
    } catch (e) {
      return badRequest("Invalid authJsonB64.");
    }
  } else {
    try {
      state = normalizeSeedInput(body);
    } catch (e) {
      return badRequest(String((e as Error)?.message ?? e));
    }
  }

  await upsertStateToD1(env, { ...state, lockUntil: null });
  await writeStateToKv(env, state);
  memoryCache = { state, cachedAt: nowMs() };

  const email = extractEmailFromJwt(state.idToken ?? "");
  console.log(
    `[seed] ok account_id=${state.accountId}${email ? ` email=${redactEmail(email)}` : ""} expires_at=${state.expiresAt}`,
  );

  return json({
    ok: true,
    accountId: state.accountId,
    expiresAt: state.expiresAt,
    accessTokenPreview: redactTokenPreview(state.accessToken),
    refreshTokenPreview: redactTokenPreview(state.refreshToken),
  });
}

async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const now = nowMs();
  const state = await readStateFromD1(env);
  return json({
    ok: true,
    hasState: Boolean(state),
    expiresAt: state?.expiresAt ?? null,
    expiresInMs: state ? Math.max(0, state.expiresAt - now) : null,
    accountId: state?.accountId ?? null,
  });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  const url = new URL(request.url);
  const store = (url.searchParams.get("store") ?? "kv").toLowerCase();
  const cache = url.searchParams.get("cache");
  const useCache = cache === null ? true : cache !== "0";

  const start = performance.now();
  const now = nowMs();

  if (useCache && memoryCache && !isExpired(memoryCache.state, now)) {
    return json({
      accessToken: memoryCache.state.accessToken,
      accountId: memoryCache.state.accountId,
      expiresAt: memoryCache.state.expiresAt,
      store: "memory",
      cached: true,
      refreshed: false,
      timingMs: { total: Math.round(performance.now() - start) },
    });
  }

  let state: TokenState | null = null;
  let storeUsed = store === "d1" ? "d1" : "kv";
  const readStart = performance.now();
  if (storeUsed === "kv") {
    state = await readStateFromKv(env);
    if (!state) {
      state = await readStateFromD1(env);
      storeUsed = "d1";
      if (state) {
        void writeStateToKv(env, state);
      }
    }
  } else {
    state = await readStateFromD1(env);
  }
  const readMs = Math.round(performance.now() - readStart);

  if (!state) {
    return json(
      { error: "not_seeded", message: "No token state found. Seed via POST /v1/seed." },
      { status: 503 },
    );
  }

  // If expiring soon, refresh using D1 (source of truth) with a lock.
  let refreshed = false;
  const refreshStart = performance.now();
  if (shouldRefreshWithin(state, now, CRON_REFRESH_WITHIN_MS)) {
    try {
      const refreshedResult = await refreshIfNeeded(env, {
        withinMs: CRON_REFRESH_WITHIN_MS,
        reason: "on_request",
      });
      state = refreshedResult.state;
      refreshed = refreshedResult.refreshed;
    } catch (e) {
      console.log(`[refresh] failed: ${(e as Error).message}`);
      // If we still have a (possibly valid) token, serve it; otherwise fail.
      if (isExpired(state, now)) {
        return json(
          { error: "refresh_failed", message: (e as Error).message },
          { status: 503 },
        );
      }
    }
  }
  const refreshMs = Math.round(performance.now() - refreshStart);

  memoryCache = { state, cachedAt: nowMs() };

  return json({
    accessToken: state.accessToken,
    accountId: state.accountId,
    expiresAt: state.expiresAt,
    store: storeUsed,
    cached: false,
    refreshed,
    timingMs: {
      read: readMs,
      refresh: refreshMs,
      total: Math.round(performance.now() - start),
    },
  });
}

async function handleForceRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  try {
    const result = await refreshIfNeeded(env, { withinMs: Number.POSITIVE_INFINITY, reason: "force" });
    return json({
      ok: true,
      refreshed: result.refreshed,
      expiresAt: result.state.expiresAt,
      accountId: result.state.accountId,
    });
  } catch (e) {
    return json({ error: "refresh_failed", message: (e as Error).message }, { status: 503 });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (!isAuthorized(request, env)) return unauthorized();

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/v1/health") return handleHealth(request, env);
    if (path === "/v1/token") return handleToken(request, env);
    if (path === "/v1/seed") return handleSeed(request, env);
    if (path === "/v1/refresh") return handleForceRefresh(request, env);

    return json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await refreshIfNeeded(env, { withinMs: CRON_REFRESH_WITHIN_MS, reason: "cron" });
        } catch (e) {
          console.log(`[cron] refresh check failed: ${(e as Error).message}`);
        }
      })(),
    );
  },
};
