import { loadLocalEnv } from "./utils/env.js";

export type SubscriptionProvider = "openai" | "xai";
export type SubscriptionToken = {
  provider: SubscriptionProvider;
  accessToken: string;
  accountId: string;
  expiresAt: number;
  clientVersion?: string;
};

/** A configured remote credential source always takes precedence over local CLI stores. */
export async function getRemoteSubscriptionToken(
  provider: SubscriptionProvider,
  options: { forceRefresh?: boolean; accountId?: string } = {},
): Promise<SubscriptionToken | null> {
  loadLocalEnv();
  const base = process.env.LLM_AUTH_URL?.trim();
  const key = process.env.LLM_AUTH_API_KEY?.trim();
  if (!base && !key) return null;
  if (!base || !key) throw new Error("Set both LLM_AUTH_URL and LLM_AUTH_API_KEY.");
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("LLM_AUTH_URL must use HTTPS (HTTP is allowed only on localhost).");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("LLM_AUTH_URL must be a base URL without credentials, query, or fragment.");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/token`;
  url.searchParams.set("provider", provider);
  if (options.forceRefresh) url.searchParams.set("refresh", "1");
  if (options.accountId) url.searchParams.set("accountId", options.accountId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`LLM auth request for ${provider} failed (${response.status}).`);
  const payload = (await response.json()) as Record<string, unknown> | null;
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.provider !== provider ||
    typeof payload.accessToken !== "string" ||
    !/^[!-~]+$/u.test(payload.accessToken) ||
    typeof payload.accountId !== "string" ||
    !payload.accountId ||
    typeof payload.expiresAt !== "number" ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= Date.now() + 30_000
  ) {
    throw new Error(`LLM auth returned an invalid ${provider} subscription token.`);
  }
  if (
    provider === "xai" &&
    (typeof payload.clientVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(payload.clientVersion))
  )
    throw new Error("LLM auth returned an invalid Grok client version.");
  return payload as SubscriptionToken;
}
