import {
  authenticateSession,
  handleAdminSession,
  handleAdminConfig,
  handleGoogleLogin,
  handleAdminTicket,
  handleDeviceLogin,
  protectResponse,
  serveDashboard,
} from "./admin.js";

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
  provider?: "openai" | "xai";
  oauthClientId?: string;
  clientVersion?: string;
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

export type Principal = {
  id: string;
  name: string;
  kind: "admin" | "client";
  accountIds?: readonly string[] | null;
  email?: string;
};

export type Env = {
  LLM_AUTH_ADMIN_API_KEY: string;
  LLM_AUTH_DB: D1Database;
  LLM_AUTH_LOG_EMAIL?: string;
  LLM_AUTH_AUDIT_RETENTION_DAYS?: string;
  LLM_AUTH_GROK_CLIENT_VERSION?: string;
  LLM_PROXY_URL?: string;
  LLM_PROXY_API_KEY?: string;
  ADMIN_GOOGLE_CLIENT_ID?: string;
  ADMIN_GOOGLE_CLIENT_SECRET?: string;
  ADMIN_BASE_URL?: string;
  ADMIN_ALLOWED_EMAILS?: string;
  ADMIN_ALLOW_KEY_LOGIN?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
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
  const alternate = request.headers.get("x-llm-auth") ?? request.headers.get("x-api-key") ?? "";
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
  const profile = (payload as { "https://api.openai.com/profile"?: { email?: unknown } })[
    "https://api.openai.com/profile"
  ];
  const email = (payload as { email?: unknown }).email ?? profile?.email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

function extractAccountDetails(
  idToken: string,
  accessToken: string,
): { name: string | null; plan: string | null } {
  const id = decodeJwtPayload(idToken) as Record<string, unknown> | null;
  const access = decodeJwtPayload(accessToken) as Record<string, unknown> | null;
  const claims = [id, access].filter((item) => item && typeof item === "object") as Record<
    string,
    unknown
  >[];
  let name: string | null = null;
  let plan: string | null = null;
  for (const claim of claims) {
    const auth = claim["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const profile = claim["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const candidateName = claim.name ?? profile?.name;
    if (!name && typeof candidateName === "string" && candidateName.trim())
      name = candidateName.trim();
    if (!plan && typeof auth?.chatgpt_plan_type === "string") plan = auth.chatgpt_plan_type;
  }
  return { name, plan };
}

function shouldLogFullEmail(env: Env): boolean {
  const value = String(env.LLM_AUTH_LOG_EMAIL ?? "")
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
    provider: row.provider === "xai" ? "xai" : "openai",
    oauthClientId: row.oauth_client_id ? String(row.oauth_client_id) : undefined,
    clientVersion: row.client_version ? String(row.client_version) : undefined,
    id: String(row.id ?? row.account_id ?? ""),
    accessToken: String(row.access_token ?? ""),
    refreshToken: String(row.refresh_token ?? ""),
    idToken: row.id_token ? String(row.id_token) : undefined,
    expiresAt: Number(row.expires_at ?? 0),
    accountId: String(row.account_id ?? ""),
    email: row.email
      ? String(row.email)
      : (extractEmailFromJwt(String(row.id_token ?? "")) ??
        extractEmailFromJwt(String(row.access_token ?? ""))),
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
  email, label, enabled, updated_at, last_selected_at, selection_count, lock_until, provider, oauth_client_id, client_version`;

async function readStateFromD1(env: Env, id: string): Promise<StoredTokenState | null> {
  const row = await env.LLM_AUTH_DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM llm_auth_state WHERE id = ?1`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowToState(row) : null;
}

async function listStatesFromD1(env: Env, enabledOnly = false): Promise<StoredTokenState[]> {
  const result = await env.LLM_AUTH_DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM llm_auth_state
     ${enabledOnly ? "WHERE enabled = 1" : ""}
     ORDER BY COALESCE(label, email, account_id), account_id`,
  ).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => rowToState(row));
}

async function upsertSeedState(env: Env, state: TokenState): Promise<void> {
  await env.LLM_AUTH_DB.prepare(
    `INSERT INTO llm_auth_state
       (id, access_token, refresh_token, id_token, expires_at, account_id, email, label,
        enabled, updated_at, lock_until, last_selected_at, selection_count, provider, oauth_client_id, client_version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, NULL, 0, 0, ?10, ?11, ?12)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, oauth_client_id=excluded.oauth_client_id, client_version=excluded.client_version,
       access_token=excluded.access_token,
       refresh_token=excluded.refresh_token,
       id_token=excluded.id_token,
       expires_at=excluded.expires_at,
       account_id=excluded.account_id,
       email=COALESCE(excluded.email, llm_auth_state.email),
       label=COALESCE(excluded.label, llm_auth_state.label),
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
      state.provider ?? "openai",
      state.oauthClientId ?? null,
      state.clientVersion ?? null,
    )
    .run();
}

async function updateRefreshedState(env: Env, id: string, state: TokenState): Promise<void> {
  await env.LLM_AUTH_DB.prepare(
    `UPDATE llm_auth_state SET
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
  accountIds: readonly string[] | null = null,
  provider: "openai" | "xai" = "openai",
): Promise<StoredTokenState | null> {
  const exclusionClause =
    excludedIds.length > 0 ? `AND id NOT IN (${excludedIds.map(() => "?").join(", ")})` : "";
  const row = await env.LLM_AUTH_DB.prepare(
    `UPDATE llm_auth_state
     SET last_selected_at = ?, selection_count = selection_count + 1
     WHERE id = (
       SELECT id FROM llm_auth_state
       WHERE enabled = 1 AND provider = ? ${exclusionClause}
         ${accountIds === null ? "" : "AND id IN (SELECT value FROM json_each(?))"}
       ORDER BY last_selected_at ASC, selection_count ASC, id ASC
       LIMIT 1
     )
     RETURNING ${ACCOUNT_COLUMNS}`,
  )
    .bind(
      nowMs(),
      provider,
      ...excludedIds,
      ...(accountIds === null ? [] : [JSON.stringify(accountIds)]),
    )
    .first<Record<string, unknown>>();
  return row ? rowToState(row) : null;
}

async function tryAcquireRefreshLock(env: Env, id: string, now: number): Promise<boolean> {
  const result = await env.LLM_AUTH_DB.prepare(
    `UPDATE llm_auth_state SET lock_until = ?1
     WHERE id = ?2 AND (lock_until IS NULL OR lock_until < ?3)`,
  )
    .bind(now + LOCK_TTL_MS, id, now)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function releaseRefreshLock(env: Env, id: string): Promise<void> {
  await env.LLM_AUTH_DB.prepare("UPDATE llm_auth_state SET lock_until = NULL WHERE id = ?1")
    .bind(id)
    .run();
}

async function oauthRefresh(
  refreshToken: string,
  provider = "openai",
  clientId = OAUTH_CLIENT_ID,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  idToken?: string;
}> {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("client_id", clientId);
  params.set("refresh_token", refreshToken);
  const response = await fetch(
    provider === "xai" ? "https://auth.x.ai/oauth2/token" : OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!response.ok) {
    throw new Error(`${provider} OAuth refresh failed (${response.status}).`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const refreshTokenValue = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const expiresIn = Number.parseFloat(String(payload.expires_in ?? "NaN"));
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  if (!accessToken || !refreshTokenValue || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`${provider} OAuth refresh returned an unexpected payload.`);
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
    const refreshed = await oauthRefresh(
      latest.refreshToken,
      latest.provider,
      latest.oauthClientId,
    );
    const idToken = refreshed.idToken ?? latest.idToken;
    const accountId =
      latest.provider === "xai"
        ? latest.accountId
        : (extractChatGptAccountIdFromJwt(idToken ?? "") ??
          extractChatGptAccountIdFromJwt(refreshed.accessToken) ??
          latest.accountId);
    const newState: TokenState = {
      provider: latest.provider,
      oauthClientId: latest.oauthClientId,
      clientVersion: latest.clientVersion,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken,
      expiresAt: now + refreshed.expiresIn * 1000,
      accountId,
      email:
        extractEmailFromJwt(idToken ?? "") ??
        extractEmailFromJwt(refreshed.accessToken) ??
        latest.email,
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

const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
function normalizeGrokSeed(input: Record<string, unknown>): TokenState {
  const document =
    input.auth && typeof input.auth === "object" ? (input.auth as Record<string, unknown>) : input;
  const scope = `https://auth.x.ai::${GROK_CLIENT_ID}`;
  const credential = (document[scope] ?? document) as Record<string, unknown>;
  if (
    !credential ||
    typeof credential !== "object" ||
    credential.auth_mode !== "oidc" ||
    credential.oidc_issuer !== "https://auth.x.ai" ||
    credential.oidc_client_id !== GROK_CLIENT_ID
  )
    throw new Error("Import an official Grok account login from auth.x.ai.");
  const accessToken = credential.key;
  const refreshToken = credential.refresh_token;
  if (
    typeof accessToken !== "string" ||
    !/^[!-~]+$/u.test(accessToken) ||
    typeof refreshToken !== "string" ||
    !/^[!-~]+$/u.test(refreshToken)
  )
    throw new Error("Grok import requires account access and refresh tokens.");
  const claims = decodeJwtPayload(accessToken) as Record<string, unknown> | null;
  const userId = credential.user_id ?? claims?.sub;
  if (typeof userId !== "string" || !userId || userId.length > 200)
    throw new Error("Grok import requires a user ID.");
  const expiresAt = Date.parse(String(credential.expires_at ?? ""));
  if (!Number.isFinite(expiresAt)) throw new Error("Grok import requires a valid expires_at.");
  if (
    typeof input.clientVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(input.clientVersion)
  )
    throw new Error("Grok import requires the installed CLI clientVersion.");
  if (input.label !== undefined && (typeof input.label !== "string" || input.label.length > 100))
    throw new Error("Invalid subscription label.");
  return {
    provider: "xai",
    oauthClientId: GROK_CLIENT_ID,
    clientVersion: input.clientVersion,
    accountId: `xai:${userId}`,
    accessToken,
    refreshToken,
    expiresAt: Math.min(expiresAt, typeof claims?.exp === "number" ? claims.exp * 1000 : expiresAt),
    email: typeof credential.email === "string" ? credential.email : undefined,
    label: typeof input.label === "string" ? input.label.trim() : undefined,
    updatedAt: nowMs(),
  };
}

function normalizeSeedInput(input: Record<string, unknown>): TokenState {
  if (input.provider === "xai") return normalizeGrokSeed(input);
  if (input.provider !== undefined && input.provider !== "openai")
    throw new Error("Unsupported subscription provider.");
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
  const accessClaims = typeof accessToken === "string" ? decodeJwtPayload(accessToken) : null;
  const jwtExpiry =
    accessClaims && typeof accessClaims === "object"
      ? (accessClaims as { exp?: unknown }).exp
      : undefined;
  const expiresAtRaw = input.expiresAt ?? input.expires_at ?? input.expires ?? jwtExpiry;
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
      extractEmailFromJwt(normalizedIdToken ?? "") ||
      extractEmailFromJwt(accessToken),
    label: typeof label === "string" && label.trim() ? label.trim() : undefined,
    updatedAt: now,
  };
}

function accountMetadata(state: StoredTokenState): Record<string, unknown> {
  const now = nowMs();
  return {
    provider: state.provider ?? "openai",
    accountId: state.accountId,
    email: state.email ?? null,
    label: state.label ?? null,
    ...extractAccountDetails(state.idToken ?? "", state.accessToken),
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
  if (env.LLM_AUTH_ADMIN_API_KEY && (await tokensEqual(token, env.LLM_AUTH_ADMIN_API_KEY))) {
    return { id: "admin", name: "Admin", kind: "admin" };
  }
  const tokenHash = await sha256Hex(token);
  const row = await env.LLM_AUTH_DB.prepare(
    "SELECT id, name, account_ids FROM llm_auth_clients WHERE token_hash = ?1 AND enabled = 1 AND deleted_at IS NULL",
  )
    .bind(tokenHash)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    kind: "client",
    accountIds: parseAccountIds(row.account_ids),
  };
}

async function markPrincipalUsed(env: Env, principal: Principal): Promise<void> {
  if (principal.kind !== "client") return;
  await env.LLM_AUTH_DB.prepare(
    `UPDATE llm_auth_clients
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
  await env.LLM_AUTH_DB.prepare(
    `INSERT INTO llm_auth_token_events
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
    await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_state WHERE id = ?1").bind(accountId).run();
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
  await env.LLM_AUTH_DB.prepare(
    "UPDATE llm_auth_state SET label = ?1, enabled = ?2, updated_at = ?3 WHERE id = ?4",
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
  const params = new URL(request.url).searchParams;
  const provider = params.get("provider") ?? "openai";
  if (provider !== "openai" && provider !== "xai")
    return badRequest("provider must be openai or xai.");
  const requestedId = params.get("accountId");
  const allowed = principal.accountIds ?? null;
  const accountIds = requestedId
    ? allowed === null || allowed.includes(requestedId)
      ? [requestedId]
      : []
    : allowed;
  const forceRefresh = params.get("refresh") === "1";
  await markPrincipalUsed(env, principal);
  const start = performance.now();
  const attemptedIds: string[] = [];

  while (true) {
    let state = await selectNextStateFromD1(env, attemptedIds, accountIds, provider);
    if (!state) break;
    attemptedIds.push(state.id);
    let refreshed = false;
    if (forceRefresh || shouldRefreshWithin(state, nowMs(), REFRESH_WITHIN_MS)) {
      try {
        const result = await refreshIfNeeded(env, state.id, {
          withinMs: forceRefresh ? Number.POSITIVE_INFINITY : REFRESH_WITHIN_MS,
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
      provider,
      accessToken: state.accessToken,
      accountId: state.accountId,
      ...(state.clientVersion ? { clientVersion: state.clientVersion } : {}),
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
      message: "No permitted, enabled subscription has a usable access token.",
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
  return `llmc_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function listClients(env: Env): Promise<readonly Record<string, unknown>[]> {
  const result = await env.LLM_AUTH_DB.prepare(
    `SELECT id, name, token_prefix, enabled, created_at, updated_at, last_used_at, request_count, account_ids
     FROM llm_auth_clients WHERE deleted_at IS NULL ORDER BY name, id`,
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
    accountIds: parseAccountIds(row.account_ids),
  };
}

function parseAccountIds(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string") ? parsed : [];
  } catch {
    return [];
  }
}

async function validateAccountIds(env: Env, value: unknown): Promise<string[] | null> {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error(
      "accountIds must be null (all subscriptions) or an array of subscription account IDs.",
    );
  }
  const ids = [...new Set(value as string[])];
  const available = new Set((await listStatesFromD1(env)).map((state) => state.accountId));
  if (ids.some((id) => !available.has(id)))
    throw new Error("One or more selected subscriptions no longer exist.");
  return ids;
}

async function handleClients(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return json({ clients: (await listClients(env)).map(clientMetadata) });
  }
  if (request.method !== "POST") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const name = validateClientName(body?.name);
  if (!name) return badRequest("name must be a non-empty string of at most 100 characters.");
  let accountIds: string[] | null;
  try {
    accountIds = await validateAccountIds(env, body?.accountIds);
  } catch (error) {
    return badRequest((error as Error).message);
  }
  const token = generateClientToken();
  const tokenHash = await sha256Hex(token);
  const id = `client_${crypto.randomUUID()}`;
  const now = nowMs();
  await env.LLM_AUTH_DB.prepare(
    `INSERT INTO llm_auth_clients
       (id, name, token_hash, token_prefix, enabled, created_at, updated_at, request_count, account_ids)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, 0, ?6)`,
  )
    .bind(
      id,
      name,
      tokenHash,
      token.slice(0, 13),
      now,
      accountIds === null ? null : JSON.stringify(accountIds),
    )
    .run();
  return json(
    {
      ok: true,
      client: {
        id,
        name,
        tokenPrefix: token.slice(0, 13),
        enabled: true,
        createdAt: now,
        accountIds,
      },
      token,
      warning: "This token is shown only once. Store it as a secret.",
    },
    { status: 201 },
  );
}

async function readClient(env: Env, id: string): Promise<Record<string, unknown> | null> {
  return env.LLM_AUTH_DB.prepare(
    `SELECT id, name, token_prefix, enabled, created_at, updated_at, last_used_at, request_count, account_ids
     FROM llm_auth_clients WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
}

async function handleClient(request: Request, env: Env, id: string): Promise<Response> {
  const current = await readClient(env, id);
  if (!current) return notFound(`Client ${id} was not found.`);
  if (request.method === "DELETE") {
    await env.LLM_AUTH_DB.prepare(
      "UPDATE llm_auth_clients SET enabled = 0, updated_at = ?1, deleted_at = ?1 WHERE id = ?2",
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
  let accountIds: readonly string[] | null;
  try {
    accountIds =
      body.accountIds === undefined
        ? parseAccountIds(current.account_ids)
        : await validateAccountIds(env, body.accountIds);
  } catch (error) {
    return badRequest((error as Error).message);
  }
  await env.LLM_AUTH_DB.prepare(
    "UPDATE llm_auth_clients SET name = ?1, enabled = ?2, updated_at = ?3, account_ids = ?4 WHERE id = ?5",
  )
    .bind(
      name,
      enabled ? 1 : 0,
      nowMs(),
      accountIds === null ? null : JSON.stringify(accountIds),
      id,
    )
    .run();
  const updated = await readClient(env, id);
  return json({ ok: true, client: updated ? clientMetadata(updated) : null });
}

async function handleRotateClient(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const current = await readClient(env, id);
  if (!current) return notFound(`Client ${id} was not found.`);
  const token = generateClientToken();
  await env.LLM_AUTH_DB.prepare(
    `UPDATE llm_auth_clients
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

async function handleTestClient(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/u.test(token))
    return badRequest("Paste the API key you want to test.");
  if (body?.clientId !== undefined && typeof body.clientId !== "string")
    return badRequest("clientId must be a string.");
  const started = performance.now();
  const result = (value: Record<string, unknown>) =>
    json({ ...value, checkedAt: nowMs(), durationMs: Math.round(performance.now() - started) });
  // Authenticate only the supplied key. The administrator's cookie must never satisfy this check.
  const probeUrl = new URL("/v1/token", request.url);
  if (body?.provider !== undefined) {
    if (body.provider !== "openai" && body.provider !== "xai")
      return badRequest("Unsupported subscription provider.");
    probeUrl.searchParams.set("provider", body.provider);
  }
  const probe = new Request(probeUrl, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(request.headers.has("cf-ray") ? { "cf-ray": request.headers.get("cf-ray")! } : {}),
    },
  });
  const principal = await authenticate(probe, env);
  if (!principal) {
    const disabled = await env.LLM_AUTH_DB.prepare(
      "SELECT id FROM llm_auth_clients WHERE token_hash = ?1 AND enabled = 0 AND deleted_at IS NULL",
    )
      .bind(await sha256Hex(token))
      .first();
    return result({
      ok: false,
      code: disabled ? "key_disabled" : "invalid_key",
      message: disabled
        ? "This API key is disabled."
        : "This API key is invalid or has been revoked.",
    });
  }
  if (principal.kind !== "client")
    return result({ ok: false, code: "admin_key", message: "Use a named API key for this check." });
  if (body?.clientId && body.clientId !== principal.id)
    return result({
      ok: false,
      code: "wrong_key",
      message: "The pasted key belongs to a different API key. Paste the key for this application.",
    });
  const client = { id: principal.id, name: principal.name };
  const grant = await handleToken(probe, env, principal);
  const payload = (await grant.json()) as Record<string, unknown>;
  if (!grant.ok)
    return result({
      ok: false,
      code: "no_usable_subscription",
      message:
        "The key is valid, but none of its permitted subscriptions can issue a token. Check its subscription selection, enabled accounts, and saved logins.",
      client,
    });
  const account = await readStateFromD1(env, String(payload.accountId));
  return result({
    ok: true,
    code: "ready",
    message: "The key authenticated and successfully obtained a subscription token.",
    client,
    subscription: {
      provider: payload.provider,
      accountId: payload.accountId,
      email: account?.email ?? null,
      label: account?.label ?? null,
      plan: account ? extractAccountDetails(account.idToken ?? "", account.accessToken).plan : null,
    },
    expiresAt: payload.expiresAt,
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
  const result = await env.LLM_AUTH_DB.prepare(
    `SELECT e.id, e.occurred_at, e.client_id, e.account_id, e.outcome, e.request_id,
            COALESCE(c.name, CASE WHEN e.client_id = 'admin' THEN 'Admin' ELSE e.client_id END)
              AS client_name
     FROM llm_auth_token_events e
     LEFT JOIN llm_auth_clients c ON c.id = e.client_id
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

async function handleStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const raw = Number(new URL(request.url).searchParams.get("days") ?? 7);
  const days = Number.isFinite(raw) ? Math.max(1, Math.min(30, Math.floor(raw))) : 7;
  const since = nowMs() - days * 86_400_000;
  const results = await Promise.all([
    env.LLM_AUTH_DB.prepare(`SELECT COUNT(*) AS events,
      SUM(CASE WHEN outcome = 'issued' THEN 1 ELSE 0 END) AS issued,
      SUM(CASE WHEN outcome != 'issued' THEN 1 ELSE 0 END) AS failures
      FROM llm_auth_token_events WHERE occurred_at >= ?1`)
      .bind(since)
      .first(),
    env.LLM_AUTH_DB.prepare(`SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') AS day,
      SUM(CASE WHEN outcome = 'issued' THEN 1 ELSE 0 END) AS issued,
      SUM(CASE WHEN outcome != 'issued' THEN 1 ELSE 0 END) AS failures
      FROM llm_auth_token_events WHERE occurred_at >= ?1 GROUP BY day ORDER BY day`)
      .bind(since)
      .all(),
    env.LLM_AUTH_DB.prepare(`SELECT e.client_id AS id, COALESCE(c.name, e.client_id) AS name,
      SUM(CASE WHEN e.outcome = 'issued' THEN 1 ELSE 0 END) AS issued,
      SUM(CASE WHEN e.outcome != 'issued' THEN 1 ELSE 0 END) AS failures,
      MAX(e.occurred_at) AS lastUsedAt FROM llm_auth_token_events e
      LEFT JOIN llm_auth_clients c ON c.id = e.client_id
      WHERE e.occurred_at >= ?1 GROUP BY e.client_id ORDER BY issued DESC`)
      .bind(since)
      .all(),
    env.LLM_AUTH_DB.prepare(`SELECT e.account_id AS id,
      COALESCE(s.label, s.email, e.account_id, 'No subscription') AS name,
      SUM(CASE WHEN e.outcome = 'issued' THEN 1 ELSE 0 END) AS issued,
      SUM(CASE WHEN e.outcome != 'issued' THEN 1 ELSE 0 END) AS failures
      FROM llm_auth_token_events e LEFT JOIN llm_auth_state s ON s.id = e.account_id
      WHERE e.occurred_at >= ?1 GROUP BY e.account_id ORDER BY issued DESC`)
      .bind(since)
      .all(),
  ]);
  return json({
    days,
    since,
    totals: results[0],
    daily: results[1].results ?? [],
    byKey: results[2].results ?? [],
    bySubscription: results[3].results ?? [],
    measurement:
      "Token grants and failed selections, not model-token consumption or billing. History starts after the multi-account upgrade.",
  });
}

async function handleSubscriptionUsage(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const current = await readStateFromD1(env, id);
  if (!current) return notFound("Subscription not found.");
  if (current.provider === "xai")
    return json(
      {
        error: "usage_unavailable",
        message: "Grok does not expose a supported subscription limits endpoint.",
      },
      { status: 501 },
    );
  const { state } = await refreshIfNeeded(env, id, {
    withinMs: ACCESS_TOKEN_EXPIRY_SAFETY_MS,
    reason: "usage_check",
  });
  const proxyUrl = env.LLM_PROXY_URL?.trim();
  const proxyKey = env.LLM_PROXY_API_KEY?.trim();
  if (proxyUrl && !proxyKey)
    return json(
      { error: "usage_proxy_not_configured", message: "The usage proxy secret is missing." },
      { status: 503 },
    );
  if (proxyUrl && new URL(proxyUrl).protocol !== "https:")
    return badRequest("The usage proxy must use HTTPS.");
  const response = proxyUrl
    ? await fetch(new URL("/api/codex/usage", proxyUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${proxyKey}`,
          "x-llm-proxy-auth": proxyKey!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accessToken: state.accessToken, accountId: state.accountId }),
        signal: AbortSignal.timeout(25_000),
      })
    : await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          "chatgpt-account-id": state.accountId,
          "User-Agent": "codex-cli",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      });
  if (!response.ok)
    return json(
      {
        error: "usage_unavailable",
        message: `Subscription limits are unavailable (HTTP ${response.status}).`,
      },
      { status: 502 },
    );
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.account_id === "string" && data.account_id !== state.accountId)
    return json(
      {
        error: "usage_account_mismatch",
        message: "Usage response does not match the selected subscription.",
      },
      { status: 502 },
    );
  if (typeof data.email === "string" && data.email.includes("@")) {
    await env.LLM_AUTH_DB.prepare("UPDATE llm_auth_state SET email = ?1 WHERE id = ?2")
      .bind(data.email, current.id)
      .run();
  }
  const limits =
    data.rate_limit && typeof data.rate_limit === "object"
      ? (data.rate_limit as Record<string, unknown>)
      : {};
  function window(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    const percent = typeof item.used_percent === "number" ? item.used_percent : Number.NaN;
    return {
      usedPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      resetAt: Number(item.reset_at) > 0 ? Number(item.reset_at) * 1000 : null,
      windowSeconds: Number(item.limit_window_seconds) || null,
    };
  }
  return json({
    accountId: id,
    checkedAt: nowMs(),
    plan: typeof data.plan_type === "string" ? data.plan_type : null,
    limitReached: limits.limit_reached === true,
    primary: window(limits.primary_window),
    secondary: window(limits.secondary_window),
  });
}

async function handleConnectionCheck(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const current = await readStateFromD1(env, id);
  if (!current) return notFound("Subscription not found.");
  if (current.provider !== "xai")
    return badRequest("Use the ChatGPT limits check for this provider.");
  const { state } = await refreshIfNeeded(env, id, {
    withinMs: ACCESS_TOKEN_EXPIRY_SAFETY_MS,
    reason: "connection_check",
  });
  const response = await fetch("https://cli-chat-proxy.grok.com/v1/models", {
    headers: {
      authorization: `Bearer ${state.accessToken}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": state.clientVersion ?? "",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    return json(
      {
        error: "connection_failed",
        message: `Grok rejected the connection check (HTTP ${response.status}).`,
      },
      { status: 502 },
    );
  const payload = (await response.json()) as { data?: unknown };
  if (!Array.isArray(payload.data))
    return json(
      { error: "connection_failed", message: "Grok returned an invalid model catalog." },
      { status: 502 },
    );
  return json({
    ok: true,
    provider: "xai",
    accountId: id,
    modelCount: payload.data.length,
    checkedAt: nowMs(),
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
  const configured = Number.parseInt(env.LLM_AUTH_AUDIT_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(3650, configured))
    : DEFAULT_AUDIT_RETENTION_DAYS;
}

async function runScheduledMaintenance(env: Env): Promise<void> {
  await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_admin_sessions WHERE expires_at < ?1")
    .bind(nowMs())
    .run();
  await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_login_attempts WHERE expires_at < ?1")
    .bind(nowMs())
    .run();
  await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_login_limits WHERE expires_at < ?1")
    .bind(nowMs())
    .run();
  await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_google_logins WHERE expires_at < ?1")
    .bind(nowMs())
    .run();
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
  await env.LLM_AUTH_DB.prepare("DELETE FROM llm_auth_token_events WHERE occurred_at < ?1")
    .bind(cutoff)
    .run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return protectResponse(await handleRequest(request, env));
    } catch (error) {
      console.log(`[request] failed: ${(error as Error).message}`);
      return protectResponse(
        json(
          {
            error: "internal_error",
            message: "The request could not be completed. Check the Worker logs.",
          },
          { status: 500 },
        ),
      );
    }
  },

  async scheduled(_event: unknown, env: Env, context: WorkerExecutionContext): Promise<void> {
    context.waitUntil(runScheduledMaintenance(env));
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const page = await serveDashboard(request, env);
    if (page) return page;
    if (path === "/admin/config") return handleAdminConfig(request, env);
    if (path === "/auth" || path === "/auth/callback") return handleGoogleLogin(request, env);
    if (path === "/admin/session") return handleAdminSession(request, env);
    const bearer = getAuthToken(request);
    const principal = bearer
      ? await authenticate(request, env)
      : await authenticateSession(request, env);
    if (!principal) return unauthorized();
    if (
      !bearer &&
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("origin") !== url.origin
    ) {
      return forbidden();
    }

    if (path === "/v1/token") return handleToken(request, env, principal);
    if (principal.kind !== "admin") return forbidden();

    if (path === "/v1/session")
      return request.method === "GET"
        ? json({ ok: true, role: "admin", email: principal.email ?? null })
        : methodNotAllowed();
    if (path === "/v1/admin-links") return handleAdminTicket(request, env);
    if (path.startsWith("/v1/login/"))
      return handleDeviceLogin(request, env, async (body) => {
        const state = normalizeSeedInput(body);
        await upsertSeedState(env, state);
        const saved = await readStateFromD1(env, state.accountId);
        if (!saved) throw new Error("Could not save the subscription.");
        return accountMetadata(saved);
      });
    if (path === "/v1/stats") return handleStats(request, env);
    const connectionMatch = /^\/v1\/accounts\/([^/]+)\/check$/u.exec(path);
    if (connectionMatch?.[1])
      return handleConnectionCheck(request, env, decodeURIComponent(connectionMatch[1]));
    const usageMatch = /^\/v1\/accounts\/([^/]+)\/usage$/u.exec(path);
    if (usageMatch?.[1])
      return handleSubscriptionUsage(request, env, decodeURIComponent(usageMatch[1]));
    if (path === "/v1/health") return handleHealth(request, env);
    if (path === "/v1/seed") return handleSeed(request, env);
    if (path === "/v1/accounts") return handleAccounts(request, env);
    if (path === "/v1/refresh") return handleForceRefresh(request, env);
    if (path === "/v1/clients") return handleClients(request, env);
    if (path === "/v1/clients/test") return handleTestClient(request, env);
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
    return json(
      {
        error: "internal_error",
        message: "The request could not be completed. Check the Worker logs.",
      },
      { status: 500 },
    );
  }
}
