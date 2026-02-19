import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { loadLocalEnv } from "../utils/env.js";

// Optional: fetch access tokens from a centralized token provider over HTTPS (for example a Cloudflare Worker).
const CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV = "CHATGPT_AUTH_TOKEN_PROVIDER_URL";
const CHATGPT_AUTH_TOKEN_PROVIDER_STORE_ENV = "CHATGPT_AUTH_TOKEN_PROVIDER_STORE";

// Used both for local storage and as the shared secret for `CHATGPT_AUTH_TOKEN_PROVIDER_URL`.
const CHATGPT_AUTH_API_KEY_ENV = "CHATGPT_AUTH_API_KEY";
const CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY_ENV = "CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY";

const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

const TOKEN_EXPIRY_BUFFER_MS = 30_000;

export type ChatGptAuthProfile = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
  readonly idToken?: string;
};

const CodexAuthFileSchema = z
  .object({
    OPENAI_API_KEY: z.string().nullable().optional(),
    last_refresh: z.string().optional(),
    tokens: z
      .object({
        access_token: z.string().min(1).optional(),
        refresh_token: z.string().min(1).optional(),
        id_token: z.string().min(1).optional(),
        account_id: z.string().min(1).optional(),
        // Allow a bit of flexibility if the file format changes.
        accessToken: z.string().min(1).optional(),
        refreshToken: z.string().min(1).optional(),
        idToken: z.string().min(1).optional(),
        accountId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .loose();

const RefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.union([z.number(), z.string()]),
});

const ExchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.union([z.number(), z.string()]),
  id_token: z.string().optional(),
});

let cachedProfile: ChatGptAuthProfile | null = null;
let refreshPromise: Promise<ChatGptAuthProfile> | null = null;

async function fetchChatGptAuthProfileFromTokenProvider(options: {
  baseUrl: string;
  apiKey: string;
  store?: string;
}): Promise<ChatGptAuthProfile> {
  const base = options.baseUrl.replace(/\/+$/u, "");
  const store = options.store?.trim() ? options.store.trim() : "kv";
  const url = new URL(`${base}/v1/token`);
  url.searchParams.set("store", store);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "x-chatgpt-auth": options.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ChatGPT token provider request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("ChatGPT token provider returned invalid JSON.");
  }
  const accessToken =
    (payload as { accessToken?: unknown; access_token?: unknown }).accessToken ??
    (payload as { accessToken?: unknown; access_token?: unknown }).access_token;
  const accountId =
    (payload as { accountId?: unknown; account_id?: unknown }).accountId ??
    (payload as { accountId?: unknown; account_id?: unknown }).account_id;
  const expiresAt =
    (payload as { expiresAt?: unknown; expires_at?: unknown }).expiresAt ??
    (payload as { expiresAt?: unknown; expires_at?: unknown }).expires_at;

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("ChatGPT token provider response missing accessToken.");
  }
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new Error("ChatGPT token provider response missing accountId.");
  }
  const expires = normalizeEpochMillis(expiresAt) ?? Date.now() + 5 * 60_000;

  // In token-provider mode we do not refresh locally (the provider owns token rotation).
  return {
    access: accessToken,
    refresh: "token_provider",
    expires,
    accountId,
  };
}

export function encodeChatGptAuthJson(profile: ChatGptAuthProfile): string {
  const payload = {
    access: profile.access,
    refresh: profile.refresh,
    expires: profile.expires,
    accountId: profile.accountId,
    ...(profile.idToken ? { id_token: profile.idToken } : {}),
  };
  return JSON.stringify(payload);
}

export function encodeChatGptAuthJsonB64(profile: ChatGptAuthProfile): string {
  return Buffer.from(encodeChatGptAuthJson(profile)).toString("base64url");
}

export async function exchangeChatGptOauthCode({
  code,
  verifier,
  redirectUri = CHATGPT_OAUTH_REDIRECT_URI,
}: {
  code: string;
  verifier: string;
  redirectUri?: string;
}): Promise<ChatGptAuthProfile> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", CHATGPT_OAUTH_CLIENT_ID);
  params.set("code", code);
  params.set("code_verifier", verifier);
  params.set("redirect_uri", redirectUri);
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ChatGPT OAuth token exchange failed (${response.status}): ${body}`);
  }
  const payload = ExchangeResponseSchema.parse(await response.json());
  return profileFromTokenResponse(payload);
}

export async function refreshChatGptOauthToken(
  refreshToken: string,
  fallback?: { accountId?: string; idToken?: string },
): Promise<ChatGptAuthProfile> {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("client_id", CHATGPT_OAUTH_CLIENT_ID);
  params.set("refresh_token", refreshToken);
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ChatGPT OAuth refresh failed (${response.status}): ${body}`);
  }
  const payload = RefreshResponseSchema.parse(await response.json());
  return profileFromTokenResponse(payload, fallback);
}

export async function getChatGptAuthProfile(): Promise<ChatGptAuthProfile> {
  loadLocalEnv();

  const tokenProviderUrl = process.env[CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV];
  const tokenProviderKey =
    process.env[CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY_ENV] ?? process.env[CHATGPT_AUTH_API_KEY_ENV];
  if (
    tokenProviderUrl &&
    tokenProviderUrl.trim().length > 0 &&
    tokenProviderKey &&
    tokenProviderKey.trim().length > 0
  ) {
    if (cachedProfile && !isExpired(cachedProfile)) {
      return cachedProfile;
    }
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = (async () => {
      try {
        const store = process.env[CHATGPT_AUTH_TOKEN_PROVIDER_STORE_ENV];
        const profile = await fetchChatGptAuthProfileFromTokenProvider({
          baseUrl: tokenProviderUrl,
          apiKey: tokenProviderKey,
          store: store ?? undefined,
        });
        cachedProfile = profile;
        return profile;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  if (cachedProfile && !isExpired(cachedProfile)) {
    return cachedProfile;
  }
  if (refreshPromise) {
    return refreshPromise;
  }
  refreshPromise = (async () => {
    try {
      const baseProfile = cachedProfile ?? loadAuthProfileFromCodexStore();
      const profile = isExpired(baseProfile)
        ? await refreshAndPersistCodexProfile(baseProfile)
        : baseProfile;
      cachedProfile = profile;
      return profile;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function resolveCodexHome(): string {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome && codexHome.trim().length > 0) {
    return codexHome.trim();
  }
  return path.join(os.homedir(), ".codex");
}

function resolveCodexAuthJsonPath(): string {
  return path.join(resolveCodexHome(), "auth.json");
}

function loadAuthProfileFromCodexStore(): ChatGptAuthProfile {
  const authPath = resolveCodexAuthJsonPath();
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch {
    throw new Error(
      `ChatGPT auth not configured. Set ${CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV}+${CHATGPT_AUTH_API_KEY_ENV} or login via Codex to create ${authPath}.`,
    );
  }

  let parsed: z.infer<typeof CodexAuthFileSchema>;
  try {
    parsed = CodexAuthFileSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new Error(
      `Failed to parse Codex auth store at ${authPath}. (${(e as Error)?.message ?? e})`,
    );
  }

  const tokens = parsed.tokens;
  if (!tokens) {
    throw new Error(
      `Codex auth store at ${authPath} is missing tokens. Re-login via Codex, or configure ${CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV}.`,
    );
  }

  const access = tokens.access_token ?? tokens.accessToken ?? undefined;
  const refresh = tokens.refresh_token ?? tokens.refreshToken ?? undefined;
  const idToken = tokens.id_token ?? tokens.idToken ?? undefined;
  if (!access || !refresh) {
    throw new Error(
      `Codex auth store at ${authPath} is missing access_token/refresh_token. Re-login via Codex, or configure ${CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV}.`,
    );
  }

  const expires =
    extractJwtExpiry(access) ?? extractJwtExpiry(idToken ?? "") ?? Date.now() + 5 * 60_000;
  const accountId =
    tokens.account_id ??
    tokens.accountId ??
    extractChatGptAccountId(idToken ?? "") ??
    extractChatGptAccountId(access);
  if (!accountId) {
    throw new Error(`Codex auth store at ${authPath} is missing chatgpt_account_id/account_id.`);
  }

  return {
    access,
    refresh,
    expires,
    accountId,
    idToken: idToken ?? undefined,
  };
}

async function refreshAndPersistCodexProfile(
  baseProfile: ChatGptAuthProfile,
): Promise<ChatGptAuthProfile> {
  const refreshed = await refreshChatGptOauthToken(baseProfile.refresh, {
    accountId: baseProfile.accountId,
    idToken: baseProfile.idToken,
  });

  persistCodexTokens(refreshed);
  return refreshed;
}

function persistCodexTokens(profile: ChatGptAuthProfile): void {
  const authPath = resolveCodexAuthJsonPath();
  const codexHome = path.dirname(authPath);

  let doc: any = {};
  try {
    doc = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    doc = {};
  }
  if (!doc || typeof doc !== "object") {
    doc = {};
  }
  if (!doc.tokens || typeof doc.tokens !== "object") {
    doc.tokens = {};
  }

  doc.tokens.access_token = profile.access;
  doc.tokens.refresh_token = profile.refresh;
  doc.tokens.account_id = profile.accountId;
  if (profile.idToken) {
    doc.tokens.id_token = profile.idToken;
  }
  doc.last_refresh = new Date().toISOString();

  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const tmpPath = `${authPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, authPath);
}

function profileFromTokenResponse(
  payload: {
    access_token: string;
    refresh_token: string;
    expires_in: number | string;
    id_token?: string;
  },
  fallback?: { accountId?: string; idToken?: string },
): ChatGptAuthProfile {
  const expires = Date.now() + normalizeNumber(payload.expires_in) * 1000;
  const fallbackAccountId = fallback?.accountId;
  const fallbackIdToken = fallback?.idToken;
  const accountId =
    extractChatGptAccountId(payload.id_token ?? "") ??
    extractChatGptAccountId(payload.access_token) ??
    fallbackAccountId;
  if (!accountId) {
    throw new Error("Failed to extract chatgpt_account_id from access token.");
  }
  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires,
    accountId,
    idToken: payload.id_token ?? fallbackIdToken,
  };
}

function normalizeEpochMillis(value: unknown): number | undefined {
  const numeric = normalizeNumber(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function isExpired(profile: ChatGptAuthProfile): boolean {
  const expires = profile.expires;
  if (!Number.isFinite(expires)) {
    return true;
  }
  return Date.now() + TOKEN_EXPIRY_BUFFER_MS >= expires;
}

function decodeJwtPayload(token: string): unknown {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }
  const payloadB64 = segments[1] ?? "";
  try {
    const decoded = Buffer.from(payloadB64, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractJwtExpiry(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const exp = (payload as { exp?: unknown }).exp;
  const parsed = normalizeNumber(exp);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function extractChatGptAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const direct = (payload as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  // Codex/ChatGPT tokens often nest it under this namespaced claim.
  const namespaced = (
    payload as { "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } }
  )["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof namespaced === "string" && namespaced.length > 0 ? namespaced : undefined;
}
