import { Buffer } from "node:buffer";

import { z } from "zod";

import { loadLocalEnv } from "../utils/env.js";

const CHATGPT_AUTH_JSON_ENV = "CHATGPT_AUTH_JSON";
const CHATGPT_AUTH_JSON_B64_ENV = "CHATGPT_AUTH_JSON_B64";

// Optional: fetch access tokens from a centralized auth service (Cloudflare Worker).
const CHATGPT_AUTH_SERVER_URL_ENV = "CHATGPT_AUTH_SERVER_URL";
const CHATGPT_AUTH_SERVER_STORE_ENV = "CHATGPT_AUTH_SERVER_STORE";

const CHATGPT_ACCESS_ENV = "CHATGPT_ACCESS";
const CHATGPT_REFRESH_ENV = "CHATGPT_REFRESH";
const CHATGPT_EXPIRES_ENV = "CHATGPT_EXPIRES";

const CHATGPT_ACCOUNT_ID_ENV = "CHATGPT_ACCOUNT_ID";
const CHATGPT_ID_TOKEN_ENV = "CHATGPT_ID_TOKEN";
const CHATGPT_ACCESS_TOKEN_ENV = "CHATGPT_ACCESS_TOKEN";
const CHATGPT_REFRESH_TOKEN_ENV = "CHATGPT_REFRESH_TOKEN";
const CHATGPT_EXPIRES_AT_ENV = "CHATGPT_EXPIRES_AT";

// Used both for local storage and as the bearer token for `CHATGPT_AUTH_SERVER_URL`.
const CHATGPT_AUTH_API_KEY_ENV = "CHATGPT_AUTH_API_KEY";

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

const AuthInputSchema = z
  .object({
    access: z.string().min(1).optional(),
    access_token: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    refresh: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    expires: z.union([z.number(), z.string()]).optional(),
    expires_at: z.union([z.number(), z.string()]).optional(),
    expiresAt: z.union([z.number(), z.string()]).optional(),
    accountId: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    id_token: z.string().optional(),
    idToken: z.string().optional(),
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

async function fetchChatGptAuthProfileFromServer(options: {
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
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ChatGPT auth server request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("ChatGPT auth server returned invalid JSON.");
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
    throw new Error("ChatGPT auth server response missing accessToken.");
  }
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new Error("ChatGPT auth server response missing accountId.");
  }
  const expires = normalizeEpochMillis(expiresAt) ?? Date.now() + 5 * 60_000;

  // In auth-server mode we do not refresh locally (the server owns token rotation).
  return {
    access: accessToken,
    refresh: "auth_server",
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

  const authServerUrl = process.env[CHATGPT_AUTH_SERVER_URL_ENV];
  const authServerKey = process.env[CHATGPT_AUTH_API_KEY_ENV];
  if (authServerUrl && authServerUrl.trim().length > 0 && authServerKey && authServerKey.trim().length > 0) {
    if (cachedProfile && !isExpired(cachedProfile)) {
      return cachedProfile;
    }
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = (async () => {
      try {
        const store = process.env[CHATGPT_AUTH_SERVER_STORE_ENV];
        const profile = await fetchChatGptAuthProfileFromServer({
          baseUrl: authServerUrl,
          apiKey: authServerKey,
          store,
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
      const baseProfile = cachedProfile ?? loadAuthProfileFromEnv();
      const profile = isExpired(baseProfile)
        ? await refreshChatGptOauthToken(baseProfile.refresh, {
            accountId: baseProfile.accountId,
            idToken: baseProfile.idToken,
          })
        : baseProfile;
      cachedProfile = profile;
      return profile;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
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

function normalizeAuthProfile(data: z.infer<typeof AuthInputSchema>): ChatGptAuthProfile {
  const access = data.access ?? data.access_token ?? data.accessToken ?? undefined;
  const refresh = data.refresh ?? data.refresh_token ?? data.refreshToken ?? undefined;
  if (!access || !refresh) {
    throw new Error("ChatGPT credentials must include access and refresh.");
  }
  const expiresRaw = data.expires ?? data.expires_at ?? data.expiresAt;
  const idToken = data.idToken ?? data.id_token ?? undefined;
  const expires =
    normalizeEpochMillis(expiresRaw) ??
    extractJwtExpiry(idToken ?? access) ??
    Date.now() + 5 * 60_000;
  const accountId =
    data.accountId ??
    data.account_id ??
    extractChatGptAccountId(idToken ?? "") ??
    extractChatGptAccountId(access);
  if (!accountId) {
    throw new Error("ChatGPT credentials missing chatgpt_account_id.");
  }
  return {
    access,
    refresh,
    expires,
    accountId,
    idToken: idToken ?? undefined,
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

function loadAuthProfileFromEnv(): ChatGptAuthProfile {
  loadLocalEnv();

  const rawJson = process.env[CHATGPT_AUTH_JSON_ENV];
  if (rawJson && rawJson.trim().length > 0) {
    return normalizeAuthProfile(AuthInputSchema.parse(JSON.parse(rawJson)));
  }

  const rawB64 = process.env[CHATGPT_AUTH_JSON_B64_ENV];
  if (rawB64 && rawB64.trim().length > 0) {
    const decoded = Buffer.from(rawB64.trim(), "base64url").toString("utf8");
    return normalizeAuthProfile(AuthInputSchema.parse(JSON.parse(decoded)));
  }

  const access =
    process.env[CHATGPT_ACCESS_ENV] ?? process.env[CHATGPT_ACCESS_TOKEN_ENV] ?? undefined;
  const refresh =
    process.env[CHATGPT_REFRESH_ENV] ?? process.env[CHATGPT_REFRESH_TOKEN_ENV] ?? undefined;
  const expires =
    process.env[CHATGPT_EXPIRES_ENV] ?? process.env[CHATGPT_EXPIRES_AT_ENV] ?? undefined;
  const accountId = process.env[CHATGPT_ACCOUNT_ID_ENV] ?? undefined;
  const idToken = process.env[CHATGPT_ID_TOKEN_ENV] ?? undefined;

  const parsed = AuthInputSchema.parse({
    access,
    refresh,
    expires,
    accountId,
    idToken,
  });

  return normalizeAuthProfile(parsed);
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
  const namespaced = (payload as { "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } })[
    "https://api.openai.com/auth"
  ]?.chatgpt_account_id;
  return typeof namespaced === "string" && namespaced.length > 0 ? namespaced : undefined;
}
