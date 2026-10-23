import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

import { loadLocalEnv } from "../utils/env.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

import { getXaiSubscriptionAuth, type XaiSubscriptionAuth } from "./auth.js";
import type { XaiAccess } from "./models.js";

const XAI_API_BASE_URL = "https://api.x.ai/v1";
const XAI_SUBSCRIPTION_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const DEFAULT_XAI_TIMEOUT_MS = 15 * 60_000;

const xaiClientState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.xaiClientState"), () => ({
  fetchByTimeout: new Map<number, typeof fetch>(),
}));

function timeoutMs(): number {
  const raw = process.env.XAI_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_XAI_TIMEOUT_MS;
}

function getXaiFetch(timeout: number): typeof fetch {
  const existing = xaiClientState.fetchByTimeout.get(timeout);
  if (existing) return existing;
  const dispatcher = new Agent({ bodyTimeout: timeout, headersTimeout: timeout });
  const requestFetch = ((input: any, init?: any) =>
    undiciFetch(input, { ...(init ?? {}), dispatcher })) as typeof fetch;
  xaiClientState.fetchByTimeout.set(timeout, requestFetch);
  return requestFetch;
}

function subscriptionAuthFailure(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "xAI subscription authentication failed. Run `grok login` to sign in again.",
        type: "authentication_error",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** Subscription traffic is pinned to the official host; API endpoint overrides never receive it. */
export async function getXaiClient(modelId?: string, access: XaiAccess = "api"): Promise<OpenAI> {
  loadLocalEnv();
  const timeout = timeoutMs();
  const requestFetch = getXaiFetch(timeout);
  if (access === "api") {
    const apiKey = process.env.XAI_API_KEY?.trim();
    if (!apiKey) throw new Error("XAI_API_KEY must be provided to access xAI APIs.");
    return new OpenAI({
      apiKey,
      baseURL: process.env.XAI_BASE_URL?.trim() || XAI_API_BASE_URL,
      timeout,
      fetch: requestFetch,
    });
  }
  const auth = await getXaiSubscriptionAuth();
  const defaultHeaders: Record<string, string> = {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": auth.clientVersion,
  };
  if (modelId) defaultHeaders["x-grok-model-override"] = modelId;
  return new OpenAI({
    apiKey: auth.token,
    baseURL: XAI_SUBSCRIPTION_BASE_URL,
    timeout,
    defaultHeaders,
    fetch: async (input: any, init?: any) => {
      let latest: XaiSubscriptionAuth;
      try {
        latest = await getXaiSubscriptionAuth();
      } catch {
        return subscriptionAuthFailure();
      }
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${latest.token}`);
      headers.set("x-grok-client-version", latest.clientVersion);
      const response = await requestFetch(input, { ...(init ?? {}), headers });
      if (response.status !== 401) return response;

      // The official CLI owns refresh-token rotation and its cross-process lock.
      // Retry an authentication failure only when that operation produced a different bearer.
      await response.body?.cancel();
      let refreshed: XaiSubscriptionAuth;
      try {
        refreshed = await getXaiSubscriptionAuth({ forceRefresh: true });
      } catch {
        return subscriptionAuthFailure();
      }
      if (refreshed.token === latest.token) {
        return subscriptionAuthFailure();
      }
      headers.set("Authorization", `Bearer ${refreshed.token}`);
      headers.set("x-grok-client-version", refreshed.clientVersion);
      return await requestFetch(input, { ...(init ?? {}), headers });
    },
  });
}
