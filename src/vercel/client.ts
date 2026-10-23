import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

import { loadLocalEnv } from "../utils/env.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

const DEFAULT_VERCEL_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_VERCEL_TIMEOUT_MS = 15 * 60_000;

const vercelClientState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.vercelClientState"), () => ({
  cachedClient: null as OpenAI | null,
  cachedFetch: null as typeof fetch | null,
}));

function resolveTimeoutMs(): number {
  const raw = process.env.AI_GATEWAY_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VERCEL_TIMEOUT_MS;
}

function resolveApiKey(): string {
  loadLocalEnv();
  const token = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!token) {
    throw new Error("AI_GATEWAY_API_KEY must be provided to access Vercel AI Gateway.");
  }
  return token;
}

function getVercelFetch(timeoutMs: number): typeof fetch {
  if (vercelClientState.cachedFetch) {
    return vercelClientState.cachedFetch;
  }
  const dispatcher = new Agent({
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  vercelClientState.cachedFetch = ((input: any, init?: any) => {
    return undiciFetch(input, { ...(init ?? {}), dispatcher });
  }) as typeof fetch;
  return vercelClientState.cachedFetch;
}

export function getVercelClient(): OpenAI {
  if (vercelClientState.cachedClient) {
    return vercelClientState.cachedClient;
  }
  const apiKey = resolveApiKey();
  const timeoutMs = resolveTimeoutMs();
  vercelClientState.cachedClient = new OpenAI({
    apiKey,
    baseURL: process.env.AI_GATEWAY_BASE_URL?.trim() || DEFAULT_VERCEL_BASE_URL,
    timeout: timeoutMs,
    fetch: getVercelFetch(timeoutMs),
  });
  return vercelClientState.cachedClient;
}
