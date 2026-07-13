type D1Result = {
  readonly meta?: { readonly changes?: number };
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
  run(): Promise<D1Result>;
};

type D1Database = {
  prepare(query: string): D1PreparedStatement;
};

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type TokenState = {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  accountId: string;
  email?: string;
  label?: string;
  updatedAt: number;
};

type StoredTokenState = TokenState & {
  id: string;
  enabled: boolean;
  lastSelectedAt: number;
  selectionCount: number;
  lockUntil: number | null;
};

type Principal = {
  id: string;
  name: string;
  kind: "admin" | "client";
};

type Env = {
  CHATGPT_AUTH_API_KEY: string;
  CHATGPT_AUTH_DB: D1Database;
  CHATGPT_AUTH_LOG_EMAIL?: string;
  CHATGPT_AUTH_AUDIT_RETENTION_DAYS?: string;
};

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 30_000;
const REFRESH_WITHIN_MS = 60 * 60 * 1000;
const LOCK_TTL_MS = 2 * 60 * 1000;
const DEFAULT_AUDIT_RETENTION_DAYS = 30;
const MAX_EVENT_PAGE_SIZE = 500;

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

function forbidden(): Response {
  return json({ error: "forbidden", message: "An admin credential is required." }, { status: 403 });
}

function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

function notFound(message: string): Response {
  return json({ error: "not_found", message }, { status: 404 });
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, { status: 405 });
}

function getBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ? match[1].trim() : null;
}

function getAuthToken(request: Request): string | null {
  const bearer = getBearer(request);
  if (bearer) return bearer;
  const alternate = request.headers.get("x-chatgpt-auth") ?? request.headers.get("x-api-key") ?? "";
  return alternate.trim().length > 0 ? alternate.trim() : null;
}

function nowMs(): number {
  return Date.now();
}

function isExpired(state: Pick<TokenState, "expiresAt">, now: number): boolean {
  return now + ACCESS_TOKEN_EXPIRY_SAFETY_MS >= state.expiresAt;
}

function shouldRefreshWithin(
  state: Pick<TokenState, "expiresAt">,
  now: number,
  withinMs: number,
): boolean {
  return now + withinMs >= state.expiresAt;
}

function base64UrlDecodeToString(value: string): string {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return atob(base64);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecodeToString(parts[1] ?? ""));
  } catch {
    return null;
  }
}

function extractChatGptAccountIdFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return undefined;
  const direct = (payload as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const namespaced = (
    payload as { "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } }
  )["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof namespaced === "string" && namespaced.length > 0 ? namespaced : undefined;
}

function extractEmailFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return undefined;
  const email = (payload as { email?: unknown }).email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

function shouldLogFullEmail(env: Env): boolean {
  const value = String(env.CHATGPT_AUTH_LOG_EMAIL ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "<redacted>";
  return `${local.slice(0, 2)}***@${domain}`;
}

function formatEmailForLogs(email: string, env: Env): string {
  return shouldLogFullEmail(env) ? email : redactEmail(email);
}

function rowToState(row: Record<string, unknown>): StoredTokenState {
  return {
    id: String(row.id ?? row.account_id ?? ""),
    accessToken: String(row.access_token ?? ""),
    refreshToken: String(row.refresh_token ?? ""),
    idToken: row.id_token ? String(row.id_token) : undefined,
    expiresAt: Number(row.expires_at ?? 0),
    accountId: String(row.account_id ?? ""),
    email: row.email ? String(row.email) : undefined,
    label: row.label ? String(row.label) : undefined,
    enabled: Number(row.enabled ?? 1) !== 0,
    updatedAt: Number(row.updated_at ?? 0),
    lastSelectedAt: Number(row.last_selected_at ?? 0),
    selectionCount: Number(row.selection_count ?? 0),
    lockUntil:
      row.lock_until === null || row.lock_until === undefined ? null : Number(row.lock_until),
  };
}

const ACCOUNT_COLUMNS = `id, access_token, refresh_token, id_token, expires_at, account_id,
  email, label, enabled, updated_at, last_selected_at, selection_count, lock_until`;

async function readStateFromD1(env: Env, id: string): Promise<StoredTokenState | null> {
  const row = await env.CHATGPT_AUTH_DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM chatgpt_auth_state WHERE id = ?1`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowToState(row) : null;
}

async function listStatesFromD1(env: Env, enabledOnly = false): Promise<StoredTokenState[]> {
  const result = await env.CHATGPT_AUTH_DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM chatgpt_auth_state
     ${enabledOnly ? "WHERE enabled = 1" : ""}
     ORDER BY COALESCE(label, email, account_id), account_id`,
  ).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => rowToState(row));
}

async function upsertSeedState(env: Env, state: TokenState): Promise<void> {
  await env.CHATGPT_AUTH_DB.prepare(
    `INSERT INTO chatgpt_auth_state
       (id, access_token, refresh_token, id_token, expires_at, account_id, email, label,
        enabled, updated_at, lock_until, last_selected_at, selection_count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, NULL, 0, 0)
     ON CONFLICT(id) DO UPDATE SET
       access_token=excluded.access_token,
       refresh_token=excluded.refresh_token,
       id_token=excluded.id_token,
       expires_at=excluded.expires_at,
       account_id=excluded.account_id,
       email=COALESCE(excluded.email, chatgpt_auth_state.email),
       label=COALESCE(excluded.label, chatgpt_auth_state.label),
       enabled=1,
       updated_at=excluded.updated_at,
       lock_until=NULL`,
  )
    .bind(
      state.accountId,
      state.accessToken,
      state.refreshToken,
      state.idToken ?? null,
      state.expiresAt,
      state.accountId,
      state.email ?? null,
      state.label ?? null,
      state.updatedAt,
    )
    .run();
}

async function updateRefreshedState(env: Env, id: string, state: TokenState): Promise<void> {
  await env.CHATGPT_AUTH_DB.prepare(
    `UPDATE chatgpt_auth_state SET
       access_token=?1, refresh_token=?2, id_token=?3, expires_at=?4, account_id=?5,
       email=?6, updated_at=?7, lock_until=NULL
     WHERE id=?8`,
  )
    .bind(
      state.accessToken,
      state.refreshToken,
      state.idToken ?? null,
      state.expiresAt,
      state.accountId,
      state.email ?? null,
      state.updatedAt,
      id,
    )
    .run();
}

async function selectNextStateFromD1(
  env: Env,
  excludedIds: readonly string[],
): Promise<StoredTokenState | null> {
  const exclusionClause =
    excludedIds.length > 0 ? `AND id NOT IN (${excludedIds.map(() => "?").join(", ")})` : "";
  const row = await env.CHATGPT_AUTH_DB.prepare(
    `UPDATE chatgpt_auth_state
     SET last_selected_at = ?, selection_count = selection_count + 1
     WHERE id = (
       SELECT id FROM chatgpt_auth_state
       WHERE enabled = 1 ${exclusionClause}
       ORDER BY last_selected_at ASC, selection_count ASC, id ASC
       LIMIT 1
     )
     RETURNING ${ACCOUNT_COLUMNS}`,
  )
    .bind(nowMs(), ...excludedIds)
    .first<Record<string, unknown>>();
  return row ? rowToState(row) : null;
}

async function tryAcquireRefreshLock(env: Env, id: string, now: number): Promise<boolean> {
  const result = await env.CHATGPT_AUTH_DB.prepare(
    `UPDATE chatgpt_auth_state SET lock_until = ?1
     WHERE id = ?2 AND (lock_until IS NULL OR lock_until < ?3)`,
  )
    .bind(now + LOCK_TTL_MS, id, now)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function releaseRefreshLock(env: Env, id: string): Promise<void> {
  await env.CHATGPT_AUTH_DB.prepare("UPDATE chatgpt_auth_state SET lock_until = NULL WHERE id = ?1")
    .bind(id)
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
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ChatGPT OAuth refresh failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const refreshTokenValue = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const expiresIn = Number.parseFloat(String(payload.expires_in ?? "NaN"));
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  if (!accessToken || !refreshTokenValue || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("ChatGPT OAuth refresh returned an unexpected payload.");
  }
  return { accessToken, refreshToken: refreshTokenValue, expiresIn, idToken };
}

async function refreshIfNeeded(
  env: Env,
  id: string,
  options: { withinMs: number; reason: string },
): Promise<{ state: StoredTokenState; refreshed: boolean }> {
  const start = performance.now();
  const now = nowMs();
  const current = await readStateFromD1(env, id);
  if (!current) throw new Error(`Token account ${id} was not found.`);
  if (!shouldRefreshWithin(current, now, options.withinMs)) {
    return { state: current, refreshed: false };
  }
  if (!(await tryAcquireRefreshLock(env, id, now))) {
    return { state: current, refreshed: false };
  }

  try {
    const latest = await readStateFromD1(env, id);
    if (!latest) throw new Error(`Token account ${id} disappeared during refresh.`);
    if (!shouldRefreshWithin(latest, now, options.withinMs)) {
      return { state: latest, refreshed: false };
    }
    const refreshed = await oauthRefresh(latest.refreshToken);
    const idToken = refreshed.idToken ?? latest.idToken;
    const accountId =
      extractChatGptAccountIdFromJwt(idToken ?? "") ??
      extractChatGptAccountIdFromJwt(refreshed.accessToken) ??
      latest.accountId;
    const newState: TokenState = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken,
      expiresAt: now + refreshed.expiresIn * 1000,
      accountId,
      email: extractEmailFromJwt(idToken ?? "") ?? latest.email,
      label: latest.label,
      updatedAt: now,
    };
    await updateRefreshedState(env, id, newState);
    const stored = await readStateFromD1(env, id);
    if (!stored) throw new Error(`Token account ${id} disappeared after refresh.`);

    console.log(
      `[refresh] ok reason=${options.reason} account_id=${stored.accountId}${
        stored.email ? ` email=${formatEmailForLogs(stored.email, env)}` : ""
      } elapsed_ms=${Math.round(performance.now() - start)}`,
    );
    return { state: stored, refreshed: true };
  } finally {
    await releaseRefreshLock(env, id);
  }
}

function normalizeSeedInput(input: Record<string, unknown>): TokenState {
  const nestedTokens =
    input.tokens && typeof input.tokens === "object"
      ? (input.tokens as Record<string, unknown>)
      : undefined;
  const source = nestedTokens ?? input;
  const accessToken =
    source.accessToken ?? source.access_token ?? source.access ?? input.accessToken ?? input.access;
  const refreshToken =
    source.refreshToken ??
    source.refresh_token ??
    source.refresh ??
    input.refreshToken ??
    input.refresh;
  const idToken = source.idToken ?? source.id_token ?? input.idToken ?? input.id_token;
  const accountIdInput =
    source.accountId ?? source.account_id ?? input.accountId ?? input.account_id;
  const expiresAtRaw = input.expiresAt ?? input.expires_at ?? input.expires;
  const parsedExpiresAt = Number.parseFloat(String(expiresAtRaw ?? "NaN"));
  const now = nowMs();
  const expiresAt =
    Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0
      ? parsedExpiresAt < 1_000_000_000_000
        ? parsedExpiresAt * 1000
        : parsedExpiresAt
      : now + 5 * 60_000;

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("seed: missing accessToken");
  }
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new Error("seed: missing refreshToken");
  }
  const normalizedIdToken = typeof idToken === "string" ? idToken.trim() : undefined;
  const accountId =
    (typeof accountIdInput === "string" && accountIdInput.trim()) ||
    extractChatGptAccountIdFromJwt(normalizedIdToken ?? "") ||
    extractChatGptAccountIdFromJwt(accessToken);
  if (!accountId) throw new Error("seed: missing accountId");

  const label = input.label;
  if (label !== undefined && (typeof label !== "string" || label.trim().length > 100)) {
    throw new Error("seed: label must be a string of at most 100 characters");
  }
  const emailInput = input.email;
  return {
    accessToken: accessToken.trim(),
    refreshToken: refreshToken.trim(),
    idToken: normalizedIdToken,
    expiresAt,
    accountId: accountId.trim(),
    email:
      (typeof emailInput === "string" && emailInput.trim()) ||
      extractEmailFromJwt(normalizedIdToken ?? ""),
    label: typeof label === "string" && label.trim() ? label.trim() : undefined,
    updatedAt: now,
  };
}

function redactTokenPreview(token: string): string {
  return token.length <= 16 ? "<redacted>" : `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function accountMetadata(state: StoredTokenState): Record<string, unknown> {
  const now = nowMs();
  return {
    accountId: state.accountId,
    email: state.email ?? null,
    label: state.label ?? null,
    enabled: state.enabled,
    expiresAt: state.expiresAt,
    expiresInMs: Math.max(0, state.expiresAt - now),
    updatedAt: state.updatedAt,
    lastSelectedAt: state.lastSelectedAt || null,
    selectionCount: state.selectionCount,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokensEqual(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const [leftHash, rightHash] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index++) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const token = getAuthToken(request);
  if (!token) return null;
  if (env.CHATGPT_AUTH_API_KEY && (await tokensEqual(token, env.CHATGPT_AUTH_API_KEY))) {
    return { id: "admin", name: "Admin", kind: "admin" };
  }
  const tokenHash = await sha256Hex(token);
  const row = await env.CHATGPT_AUTH_DB.prepare(
    "SELECT id, name FROM chatgpt_auth_clients WHERE token_hash = ?1 AND enabled = 1",
  )
    .bind(tokenHash)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return { id: String(row.id), name: String(row.name), kind: "client" };
}

async function markPrincipalUsed(env: Env, principal: Principal): Promise<void> {
  if (principal.kind !== "client") return;
  await env.CHATGPT_AUTH_DB.prepare(
    `UPDATE chatgpt_auth_clients
     SET last_used_at = ?1, request_count = request_count + 1, updated_at = ?1
     WHERE id = ?2`,
  )
    .bind(nowMs(), principal.id)
    .run();
}

async function recordTokenEvent(
  env: Env,
  request: Request,
  principal: Principal,
  accountId: string | null,
  outcome: string,
): Promise<void> {
  await env.CHATGPT_AUTH_DB.prepare(
    `INSERT INTO chatgpt_auth_token_events
       (occurred_at, client_id, account_id, outcome, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(
      nowMs(),
      principal.id,
      accountId,
      outcome,
      request.headers.get("cf-ray") ?? request.headers.get("x-request-id"),
    )
    .run();
}

async function handleSeed(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("Expected JSON body.");

  let input = body;
  if (typeof body.authJsonB64 === "string" && body.authJsonB64.trim()) {
    try {
      const decoded = JSON.parse(base64UrlDecodeToString(body.authJsonB64.trim())) as Record<
        string,
        unknown
      >;
      input = {
        ...decoded,
        label: body.label ?? decoded.label,
        email: body.email ?? decoded.email,
      };
    } catch {
      return badRequest("Invalid authJsonB64.");
    }
  }

  let state: TokenState;
  try {
    state = normalizeSeedInput(input);
  } catch (error) {
    return badRequest(String((error as Error)?.message ?? error));
  }
  await upsertSeedState(env, state);
  const stored = await readStateFromD1(env, state.accountId);
  if (!stored) return json({ error: "seed_failed" }, { status: 500 });

  console.log(
    `[seed] ok account_id=${stored.accountId}${
      stored.email ? ` email=${formatEmailForLogs(stored.email, env)}` : ""
    } expires_at=${stored.expiresAt}`,
  );
  return json({
    ok: true,
    ...accountMetadata(stored),
    accessTokenPreview: redactTokenPreview(stored.accessToken),
    refreshTokenPreview: redactTokenPreview(stored.refreshToken),
  });
}

async function handleAccounts(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const states = await listStatesFromD1(env);
  return json({ accounts: states.map(accountMetadata) });
}

async function handleAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const current = await readStateFromD1(env, accountId);
  if (!current) return notFound(`Account ${accountId} was not found.`);
  if (request.method === "DELETE") {
    await env.CHATGPT_AUTH_DB.prepare("DELETE FROM chatgpt_auth_state WHERE id = ?1")
      .bind(accountId)
      .run();
    return json({ ok: true, accountId });
  }
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("Expected JSON body.");
  if (
    body.label !== undefined &&
    body.label !== null &&
    (typeof body.label !== "string" || body.label.trim().length > 100)
  ) {
    return badRequest("label must be null or a string of at most 100 characters.");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return badRequest("enabled must be a boolean.");
  }
  const label =
    body.label === null
      ? null
      : typeof body.label === "string"
        ? body.label.trim() || null
        : (current.label ?? null);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
  await env.CHATGPT_AUTH_DB.prepare(
    "UPDATE chatgpt_auth_state SET label = ?1, enabled = ?2, updated_at = ?3 WHERE id = ?4",
  )
    .bind(label, enabled ? 1 : 0, nowMs(), accountId)
    .run();
  const updated = await readStateFromD1(env, accountId);
  return json({ ok: true, account: updated ? accountMetadata(updated) : null });
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const states = await listStatesFromD1(env);
  return json({
    ok: true,
    accountCount: states.length,
    enabledAccountCount: states.filter((state) => state.enabled).length,
    accounts: states.map(accountMetadata),
  });
}

async function handleToken(request: Request, env: Env, principal: Principal): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  await markPrincipalUsed(env, principal);
  const start = performance.now();
  const attemptedIds: string[] = [];

  while (true) {
    let state = await selectNextStateFromD1(env, attemptedIds);
    if (!state) break;
    attemptedIds.push(state.id);
    let refreshed = false;
    if (shouldRefreshWithin(state, nowMs(), REFRESH_WITHIN_MS)) {
      try {
        const result = await refreshIfNeeded(env, state.id, {
          withinMs: REFRESH_WITHIN_MS,
          reason: "on_request",
        });
        state = result.state;
        refreshed = result.refreshed;
      } catch (error) {
        console.log(`[refresh] failed account_id=${state.accountId}: ${(error as Error).message}`);
        if (isExpired(state, nowMs())) {
          await recordTokenEvent(env, request, principal, state.accountId, "refresh_failed");
          continue;
        }
      }
    }
    if (isExpired(state, nowMs())) {
      await recordTokenEvent(env, request, principal, state.accountId, "expired");
      continue;
    }

    await recordTokenEvent(env, request, principal, state.accountId, "issued");
    return json({
      accessToken: state.accessToken,
      accountId: state.accountId,
      expiresAt: state.expiresAt,
      refreshed,
      caller: { id: principal.id, name: principal.name },
      rotation: { attemptedAccounts: attemptedIds.length },
      timingMs: { total: Math.round(performance.now() - start) },
    });
  }

  await recordTokenEvent(env, request, principal, null, "no_usable_account");
  return json(
    {
      error: "no_usable_account",
      message: "No enabled account has a usable access token.",
      attemptedAccounts: attemptedIds.length,
    },
    { status: 503 },
  );
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Expected JSON body.");
  return parsed as Record<string, unknown>;
}

async function handleForceRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  let body: Record<string, unknown>;
  try {
    body = await readOptionalJson(request);
  } catch (error) {
    return badRequest((error as Error).message);
  }
  const requestedId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const states = requestedId
    ? ([await readStateFromD1(env, requestedId)].filter(Boolean) as StoredTokenState[])
    : await listStatesFromD1(env, true);
  if (requestedId && states.length === 0) return notFound(`Account ${requestedId} was not found.`);

  const accounts: Record<string, unknown>[] = [];
  for (const state of states) {
    try {
      const result = await refreshIfNeeded(env, state.id, {
        withinMs: Number.POSITIVE_INFINITY,
        reason: "force",
      });
      accounts.push({
        ok: true,
        accountId: result.state.accountId,
        refreshed: result.refreshed,
        expiresAt: result.state.expiresAt,
      });
    } catch (error) {
      accounts.push({ ok: false, accountId: state.accountId, error: (error as Error).message });
    }
  }
  return json({ ok: accounts.every((account) => account.ok), accounts });
}

function validateClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 100 ? name : null;
}

function generateClientToken(): string {
  return `cgptc_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function listClients(env: Env): Promise<readonly Record<string, unknown>[]> {
  const result = await env.CHATGPT_AUTH_DB.prepare(
    `SELECT id, name, token_prefix, enabled, created_at, updated_at, last_used_at, request_count
     FROM chatgpt_auth_clients ORDER BY name, id`,
  ).all<Record<string, unknown>>();
  return result.results ?? [];
}

function clientMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenPrefix: String(row.token_prefix),
    enabled: Number(row.enabled) !== 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    requestCount: Number(row.request_count ?? 0),
  };
}

async function handleClients(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return json({ clients: (await listClients(env)).map(clientMetadata) });
  }
  if (request.method !== "POST") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const name = validateClientName(body?.name);
  if (!name) return badRequest("name must be a non-empty string of at most 100 characters.");
  const token = generateClientToken();
  const tokenHash = await sha256Hex(token);
  const id = `client_${crypto.randomUUID()}`;
  const now = nowMs();
  await env.CHATGPT_AUTH_DB.prepare(
    `INSERT INTO chatgpt_auth_clients
       (id, name, token_hash, token_prefix, enabled, created_at, updated_at, request_count)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, 0)`,
  )
    .bind(id, name, tokenHash, token.slice(0, 13), now)
    .run();
  return json(
    {
      ok: true,
      client: { id, name, tokenPrefix: token.slice(0, 13), enabled: true, createdAt: now },
      token,
      warning: "This token is shown only once. Store it as a secret.",
    },
    { status: 201 },
  );
}

async function readClient(env: Env, id: string): Promise<Record<string, unknown> | null> {
  return env.CHATGPT_AUTH_DB.prepare(
    `SELECT id, name, token_prefix, enabled, created_at, updated_at, last_used_at, request_count
     FROM chatgpt_auth_clients WHERE id = ?1`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
}

async function handleClient(request: Request, env: Env, id: string): Promise<Response> {
  const current = await readClient(env, id);
  if (!current) return notFound(`Client ${id} was not found.`);
  if (request.method === "DELETE") {
    await env.CHATGPT_AUTH_DB.prepare(
      "UPDATE chatgpt_auth_clients SET enabled = 0, updated_at = ?1 WHERE id = ?2",
    )
      .bind(nowMs(), id)
      .run();
    return json({ ok: true, id, enabled: false });
  }
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("Expected JSON body.");
  const name = body.name === undefined ? String(current.name) : validateClientName(body.name);
  if (!name) return badRequest("name must be a non-empty string of at most 100 characters.");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return badRequest("enabled must be a boolean.");
  }
  const enabled = typeof body.enabled === "boolean" ? body.enabled : Number(current.enabled) !== 0;
  await env.CHATGPT_AUTH_DB.prepare(
    "UPDATE chatgpt_auth_clients SET name = ?1, enabled = ?2, updated_at = ?3 WHERE id = ?4",
  )
    .bind(name, enabled ? 1 : 0, nowMs(), id)
    .run();
  const updated = await readClient(env, id);
  return json({ ok: true, client: updated ? clientMetadata(updated) : null });
}

async function handleRotateClient(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const current = await readClient(env, id);
  if (!current) return notFound(`Client ${id} was not found.`);
  const token = generateClientToken();
  await env.CHATGPT_AUTH_DB.prepare(
    `UPDATE chatgpt_auth_clients
     SET token_hash = ?1, token_prefix = ?2, enabled = 1, updated_at = ?3
     WHERE id = ?4`,
  )
    .bind(await sha256Hex(token), token.slice(0, 13), nowMs(), id)
    .run();
  const updated = await readClient(env, id);
  return json({
    ok: true,
    id,
    client: updated ? clientMetadata(updated) : null,
    token,
    tokenPrefix: token.slice(0, 13),
    warning: "This token is shown only once. Store it as a secret.",
  });
}

async function handleEvents(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const url = new URL(request.url);
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_EVENT_PAGE_SIZE, requestedLimit))
    : 100;
  const clientId = url.searchParams.get("clientId")?.trim();
  const result = await env.CHATGPT_AUTH_DB.prepare(
    `SELECT e.id, e.occurred_at, e.client_id, e.account_id, e.outcome, e.request_id,
            COALESCE(c.name, CASE WHEN e.client_id = 'admin' THEN 'Admin' ELSE e.client_id END)
              AS client_name
     FROM chatgpt_auth_token_events e
     LEFT JOIN chatgpt_auth_clients c ON c.id = e.client_id
     ${clientId ? "WHERE e.client_id = ?" : ""}
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT ?`,
  )
    .bind(...(clientId ? [clientId, limit] : [limit]))
    .all<Record<string, unknown>>();
  return json({
    events: (result.results ?? []).map((row) => ({
      id: Number(row.id),
      occurredAt: Number(row.occurred_at),
      clientId: String(row.client_id),
      clientName: String(row.client_name),
      accountId: row.account_id == null ? null : String(row.account_id),
      outcome: String(row.outcome),
      requestId: row.request_id == null ? null : String(row.request_id),
    })),
  });
}

function pathIdentifier(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const encoded = path.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function auditRetentionDays(env: Env): number {
  const configured = Number.parseInt(env.CHATGPT_AUTH_AUDIT_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(3650, configured))
    : DEFAULT_AUDIT_RETENTION_DAYS;
}

async function runScheduledMaintenance(env: Env): Promise<void> {
  const states = await listStatesFromD1(env, true);
  for (const state of states) {
    try {
      await refreshIfNeeded(env, state.id, { withinMs: REFRESH_WITHIN_MS, reason: "cron" });
    } catch (error) {
      console.log(
        `[cron] refresh failed account_id=${state.accountId}: ${(error as Error).message}`,
      );
    }
  }
  const cutoff = nowMs() - auditRetentionDays(env) * 24 * 60 * 60 * 1000;
  await env.CHATGPT_AUTH_DB.prepare("DELETE FROM chatgpt_auth_token_events WHERE occurred_at < ?1")
    .bind(cutoff)
    .run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const principal = await authenticate(request, env);
      if (!principal) return unauthorized();
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/v1/token") return handleToken(request, env, principal);
      if (principal.kind !== "admin") return forbidden();

      if (path === "/v1/health") return handleHealth(request, env);
      if (path === "/v1/seed") return handleSeed(request, env);
      if (path === "/v1/accounts") return handleAccounts(request, env);
      if (path === "/v1/refresh") return handleForceRefresh(request, env);
      if (path === "/v1/clients") return handleClients(request, env);
      if (path === "/v1/events") return handleEvents(request, env);

      const rotateMatch = /^\/v1\/clients\/([^/]+)\/rotate$/u.exec(path);
      if (rotateMatch?.[1]) {
        return handleRotateClient(request, env, decodeURIComponent(rotateMatch[1]));
      }
      const accountId = pathIdentifier(path, "/v1/accounts/");
      if (accountId) return handleAccount(request, env, accountId);
      const clientId = pathIdentifier(path, "/v1/clients/");
      if (clientId) return handleClient(request, env, clientId);

      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      console.log(`[request] failed: ${(error as Error).message}`);
      return json({ error: "internal_error", message: (error as Error).message }, { status: 500 });
    }
  },

  async scheduled(_event: unknown, env: Env, context: WorkerExecutionContext): Promise<void> {
    context.waitUntil(runScheduledMaintenance(env));
  },
};
