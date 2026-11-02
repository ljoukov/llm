declare const process: {
  readonly env: Record<string, string | undefined>;
};

const LLM_PROXY_API_KEY_ENV = "LLM_PROXY_API_KEY";
const LLM_AUTH_URL_ENV = "LLM_AUTH_URL";
const LLM_AUTH_API_KEY_ENV = "LLM_AUTH_API_KEY";
const LLM_PROXY_OPENAI_UPSTREAM_URL_ENV = "LLM_PROXY_OPENAI_UPSTREAM_URL";
const LLM_PROXY_OPENAI_IMAGES_UPSTREAM_URL_ENV = "LLM_PROXY_OPENAI_IMAGES_UPSTREAM_URL";

const DEFAULT_LLM_PROXY_OPENAI_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_LLM_PROXY_OPENAI_IMAGES_UPSTREAM_URL =
  "https://chatgpt.com/backend-api/codex/images/generations";
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

const CHATGPT_UPSTREAM_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "openai-beta",
  "originator",
  "session_id",
  "user-agent",
]);

type StreamingRequestInit = RequestInit & {
  duplex?: "half";
};

type TokenProviderResponse = {
  readonly provider?: unknown;
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
  return getBearer(request) ?? request.headers.get("x-llm-proxy-auth")?.trim() ?? null;
}

function isAuthorized(request: Request): boolean {
  const expected = getEnv(LLM_PROXY_API_KEY_ENV);
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
    }
  | Response {
  const tokenProviderUrl = getEnv(LLM_AUTH_URL_ENV);
  const tokenProviderApiKey = getEnv(LLM_AUTH_API_KEY_ENV);

  const missing = [
    ...(tokenProviderUrl ? [] : [LLM_AUTH_URL_ENV]),
    ...(tokenProviderApiKey ? [] : [LLM_AUTH_API_KEY_ENV]),
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
  };
}

function resolveUpstreamUrl(): string {
  return getEnv(LLM_PROXY_OPENAI_UPSTREAM_URL_ENV) ?? DEFAULT_LLM_PROXY_OPENAI_UPSTREAM_URL;
}

function replaceCodexEndpointResource(
  rawUrl: string,
  resource: "images/generations" | "images/edits",
): string {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  if (/(?:\/responses|\/images\/(?:generations|edits))$/u.test(path)) {
    url.pathname = path.replace(
      /(?:\/responses|\/images\/(?:generations|edits))$/u,
      `/${resource}`,
    );
  } else {
    url.pathname = `${path}/${resource}`.replace(/\/{2,}/gu, "/");
  }
  return url.toString();
}

function resolveImagesUpstreamUrl(operation: "generations" | "edits"): string {
  const configured =
    getEnv(LLM_PROXY_OPENAI_IMAGES_UPSTREAM_URL_ENV) ??
    (getEnv(LLM_PROXY_OPENAI_UPSTREAM_URL_ENV)
      ? resolveUpstreamUrl()
      : DEFAULT_LLM_PROXY_OPENAI_IMAGES_UPSTREAM_URL);
  return replaceCodexEndpointResource(configured, `images/${operation}`);
}

async function fetchChatGptCodexToken(): Promise<ChatGptCodexToken | Response> {
  const config = resolveTokenProviderConfig();
  if (config instanceof Response) {
    return config;
  }

  const base = config.url.replace(/\/+$/u, "");
  const url = new URL(`${base}/v1/token`);
  url.searchParams.set("provider", "openai");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "x-llm-auth": config.apiKey,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    return json(
      {
        error: "token_provider_failed",
        status: response.status,
        message: "Subscription token service request failed.",
      },
      { status: 502 },
    );
  }

  const payload = (await response.json().catch(() => null)) as TokenProviderResponse | null;
  const accessToken = payload?.accessToken ?? payload?.access_token;
  const accountId = payload?.accountId ?? payload?.account_id;
  const expiresAt = payload?.expiresAt ?? payload?.expires_at;

  if (payload?.provider !== "openai") {
    return json(
      {
        error: "token_provider_invalid_response",
        message: "Expected an OpenAI subscription token.",
      },
      { status: 502 },
    );
  }

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

function buildUpstreamHeaders(
  request: Request,
  token: ChatGptCodexToken,
  mode: "responses" | "images" = "responses",
): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === "authorization" ||
      lower === "x-llm-proxy-auth" ||
      lower === "x-llm-auth" ||
      lower === "x-api-key" ||
      !CHATGPT_UPSTREAM_HEADER_ALLOWLIST.has(lower)
    ) {
      continue;
    }
    headers.set(name, value);
  }

  headers.set("authorization", `Bearer ${token.accessToken}`);
  headers.set("chatgpt-account-id", token.accountId);
  if (mode === "responses" && !headers.has("openai-beta")) {
    headers.set("openai-beta", DEFAULT_OPENAI_BETA_HEADER);
  } else if (mode === "images") {
    headers.delete("openai-beta");
  }
  if (!headers.has("originator")) {
    headers.set("originator", "llm-vercel-codex-proxy");
  }
  if (!headers.has("accept")) {
    headers.set("accept", mode === "responses" ? "text/event-stream" : "application/json");
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
    // fetch decodes the upstream body; forwarding its original encoding would
    // make the downstream client try to decompress the decoded bytes again.
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-encoding") {
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
    supportsSubscriptionUsage: true,
    upstreamUrl: resolveUpstreamUrl(),
    hasProxyApiKey: Boolean(getEnv(LLM_PROXY_API_KEY_ENV)),
    hasTokenProviderUrl: Boolean(getEnv(LLM_AUTH_URL_ENV)),
    hasTokenProviderApiKey: Boolean(getEnv(LLM_AUTH_API_KEY_ENV)),
  });
}

export async function handleCodexUsageRequest(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed();
  const text = await request.text();
  if (text.length > 65_536) return json({ error: "request_too_large" }, { status: 413 });
  let body: Record<string, unknown> | null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    !body ||
    Array.isArray(body) ||
    typeof body.accessToken !== "string" ||
    !body.accessToken.trim() ||
    typeof body.accountId !== "string" ||
    !body.accountId.trim() ||
    body.accountId.length > 200
  ) {
    return json(
      {
        error: "invalid_usage_request",
        message: "A subscription access token and account ID are required.",
      },
      { status: 400 },
    );
  }
  const accountId = body.accountId.trim();
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${body.accessToken.trim()}`,
        "chatgpt-account-id": accountId,
        "User-Agent": "codex-cli",
        Accept: "application/json",
      },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok)
      return json(
        {
          error: "usage_upstream_failed",
          upstreamStatus: response.status,
          message: `ChatGPT usage lookup failed (HTTP ${response.status}).`,
        },
        { status: 502 },
      );
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload.account_id === "string" && payload.account_id !== accountId) {
      return json({ error: "usage_account_mismatch" }, { status: 502 });
    }
    const rateLimit =
      payload.rate_limit && typeof payload.rate_limit === "object"
        ? (payload.rate_limit as Record<string, unknown>)
        : {};
    function window(value: unknown): Record<string, number | null> | null {
      if (!value || typeof value !== "object") return null;
      const item = value as Record<string, unknown>;
      const finite = (key: string) =>
        typeof item[key] === "number" && Number.isFinite(item[key]) ? Number(item[key]) : null;
      return {
        used_percent: finite("used_percent"),
        reset_at: finite("reset_at"),
        limit_window_seconds: finite("limit_window_seconds"),
      };
    }
    return json({
      account_id: accountId,
      email: typeof payload.email === "string" ? payload.email : null,
      plan_type: typeof payload.plan_type === "string" ? payload.plan_type : null,
      rate_limit: {
        allowed: rateLimit.allowed === true,
        limit_reached: rateLimit.limit_reached === true,
        primary_window: window(rateLimit.primary_window),
        secondary_window: window(rateLimit.secondary_window),
      },
    });
  } catch {
    return json(
      {
        error: "usage_upstream_unavailable",
        message: "ChatGPT usage lookup could not be completed.",
      },
      { status: 502 },
    );
  }
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

export async function handleCodexImagesRequest(
  request: Request,
  operation: "generations" | "edits",
): Promise<Response> {
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
    headers: buildUpstreamHeaders(request, token, "images"),
    body: request.body,
    signal: request.signal,
  };
  if (request.body) {
    upstreamRequestInit.duplex = "half";
  }

  const upstreamResponse = await fetch(resolveImagesUpstreamUrl(operation), upstreamRequestInit);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: buildClientHeaders(upstreamResponse.headers),
  });
}
