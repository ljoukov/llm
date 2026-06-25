declare const process: {
  readonly env: Record<string, string | undefined>;
};

const CODEX_PROXY_API_KEY_ENV = "CODEX_PROXY_API_KEY";
const CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV = "CHATGPT_AUTH_TOKEN_PROVIDER_URL";
const CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY_ENV = "CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY";
const CHATGPT_AUTH_API_KEY_ENV = "CHATGPT_AUTH_API_KEY";
const CHATGPT_AUTH_TOKEN_PROVIDER_STORE_ENV = "CHATGPT_AUTH_TOKEN_PROVIDER_STORE";
const CHATGPT_CODEX_UPSTREAM_URL_ENV = "CHATGPT_CODEX_UPSTREAM_URL";

const DEFAULT_CHATGPT_CODEX_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_OPENAI_BETA_HEADER = "responses=experimental";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type StreamingRequestInit = RequestInit & {
  duplex?: "half";
};

type TokenProviderResponse = {
  readonly accessToken?: unknown;
  readonly access_token?: unknown;
  readonly accountId?: unknown;
  readonly account_id?: unknown;
  readonly expiresAt?: unknown;
  readonly expires_at?: unknown;
};

type ChatGptCodexToken = {
  readonly accessToken: string;
  readonly accountId: string;
  readonly expiresAt: number | null;
};

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function getBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function getProxyAuthToken(request: Request): string | null {
  return getBearer(request) ?? request.headers.get("x-codex-proxy-auth")?.trim() ?? null;
}

function isAuthorized(request: Request): boolean {
  const expected = getEnv(CODEX_PROXY_API_KEY_ENV);
  const actual = getProxyAuthToken(request);
  return Boolean(expected && actual && actual === expected);
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, { status: 405 });
}

function missingConfigResponse(missing: readonly string[]): Response {
  return json(
    {
      error: "missing_config",
      message: `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      missing,
    },
    { status: 500 },
  );
}

function resolveTokenProviderConfig():
  | {
      readonly url: string;
      readonly apiKey: string;
      readonly store: string;
    }
  | Response {
  const tokenProviderUrl = getEnv(CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV);
  const tokenProviderApiKey =
    getEnv(CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY_ENV) ?? getEnv(CHATGPT_AUTH_API_KEY_ENV);

  const missing = [
    ...(tokenProviderUrl ? [] : [CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV]),
    ...(tokenProviderApiKey
      ? []
      : [`${CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY_ENV} or ${CHATGPT_AUTH_API_KEY_ENV}`]),
  ];
  if (missing.length > 0) {
    return missingConfigResponse(missing);
  }
  if (!tokenProviderUrl || !tokenProviderApiKey) {
    return missingConfigResponse(missing);
  }

  return {
    url: tokenProviderUrl,
    apiKey: tokenProviderApiKey,
    store: getEnv(CHATGPT_AUTH_TOKEN_PROVIDER_STORE_ENV) ?? "kv",
  };
}

function resolveUpstreamUrl(): string {
  return getEnv(CHATGPT_CODEX_UPSTREAM_URL_ENV) ?? DEFAULT_CHATGPT_CODEX_UPSTREAM_URL;
}

async function fetchChatGptCodexToken(): Promise<ChatGptCodexToken | Response> {
  const config = resolveTokenProviderConfig();
  if (config instanceof Response) {
    return config;
  }

  const base = config.url.replace(/\/+$/u, "");
  const url = new URL(`${base}/v1/token`);
  url.searchParams.set("store", config.store);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "x-chatgpt-auth": config.apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    return json(
      {
        error: "token_provider_failed",
        status: response.status,
        message: body,
      },
      { status: 502 },
    );
  }

  const payload = (await response.json().catch(() => null)) as TokenProviderResponse | null;
  const accessToken = payload?.accessToken ?? payload?.access_token;
  const accountId = payload?.accountId ?? payload?.account_id;
  const expiresAt = payload?.expiresAt ?? payload?.expires_at;

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return json(
      { error: "token_provider_invalid_response", message: "Response missing accessToken." },
      { status: 502 },
    );
  }
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    return json(
      { error: "token_provider_invalid_response", message: "Response missing accountId." },
      { status: 502 },
    );
  }

  return {
    accessToken: accessToken.trim(),
    accountId: accountId.trim(),
    expiresAt: normalizeEpochMillis(expiresAt),
  };
}

function normalizeEpochMillis(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function buildUpstreamHeaders(request: Request, token: ChatGptCodexToken): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === "authorization" ||
      lower === "x-codex-proxy-auth" ||
      lower === "x-chatgpt-auth" ||
      lower === "x-api-key"
    ) {
      continue;
    }
    headers.set(name, value);
  }

  headers.set("authorization", `Bearer ${token.accessToken}`);
  headers.set("chatgpt-account-id", token.accountId);
  if (!headers.has("openai-beta")) {
    headers.set("openai-beta", DEFAULT_OPENAI_BETA_HEADER);
  }
  if (!headers.has("originator")) {
    headers.set("originator", "llm-vercel-codex-proxy");
  }
  if (!headers.has("accept")) {
    headers.set("accept", "text/event-stream");
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function buildClientHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstreamHeaders) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  return headers;
}

export async function handleHealthRequest(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return unauthorized();
  }
  if (request.method !== "GET") {
    return methodNotAllowed();
  }

  return json({
    ok: true,
    upstreamUrl: resolveUpstreamUrl(),
    hasProxyApiKey: Boolean(getEnv(CODEX_PROXY_API_KEY_ENV)),
    hasTokenProviderUrl: Boolean(getEnv(CHATGPT_AUTH_TOKEN_PROVIDER_URL_ENV)),
    hasTokenProviderApiKey: Boolean(
      getEnv(CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY_ENV) ?? getEnv(CHATGPT_AUTH_API_KEY_ENV),
    ),
    tokenProviderStore: getEnv(CHATGPT_AUTH_TOKEN_PROVIDER_STORE_ENV) ?? "kv",
  });
}

export async function handleCodexResponsesRequest(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return unauthorized();
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const token = await fetchChatGptCodexToken();
  if (token instanceof Response) {
    return token;
  }

  const upstreamRequestInit: StreamingRequestInit = {
    method: "POST",
    headers: buildUpstreamHeaders(request, token),
    body: request.body,
    signal: request.signal,
  };
  if (request.body) {
    upstreamRequestInit.duplex = "half";
  }

  const upstreamResponse = await fetch(resolveUpstreamUrl(), upstreamRequestInit);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: buildClientHeaders(upstreamResponse.headers),
  });
}
