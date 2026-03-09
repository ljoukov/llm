import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

import { loadLocalEnv } from "../utils/env.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_FIREWORKS_TIMEOUT_MS = 15 * 60_000;

const fireworksClientState = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.fireworksClientState"),
  () => ({
    cachedClient: null as OpenAI | null,
    cachedFetch: null as typeof fetch | null,
    cachedBaseUrl: null as string | null,
    cachedApiKey: null as string | null,
    cachedTimeoutMs: null as number | null,
  }),
);

function resolveTimeoutMs(): number {
  if (fireworksClientState.cachedTimeoutMs !== null) {
    return fireworksClientState.cachedTimeoutMs;
  }

  const raw = process.env.FIREWORKS_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  fireworksClientState.cachedTimeoutMs =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FIREWORKS_TIMEOUT_MS;
  return fireworksClientState.cachedTimeoutMs;
}

function resolveBaseUrl(): string {
  if (fireworksClientState.cachedBaseUrl !== null) {
    return fireworksClientState.cachedBaseUrl;
  }

  loadLocalEnv();
  const raw = process.env.FIREWORKS_BASE_URL?.trim();
  fireworksClientState.cachedBaseUrl = raw && raw.length > 0 ? raw : DEFAULT_FIREWORKS_BASE_URL;
  return fireworksClientState.cachedBaseUrl;
}

function resolveApiKey(): string {
  if (fireworksClientState.cachedApiKey !== null) {
    return fireworksClientState.cachedApiKey;
  }

  loadLocalEnv();
  const raw = process.env.FIREWORKS_TOKEN ?? process.env.FIREWORKS_API_KEY;
  const token = raw?.trim();
  if (!token) {
    throw new Error(
      "FIREWORKS_TOKEN (or FIREWORKS_API_KEY) must be provided to access Fireworks APIs.",
    );
  }

  fireworksClientState.cachedApiKey = token;
  return fireworksClientState.cachedApiKey;
}

function getFireworksFetch(): typeof fetch {
  if (fireworksClientState.cachedFetch) {
    return fireworksClientState.cachedFetch;
  }

  const timeoutMs = resolveTimeoutMs();
  const dispatcher = new Agent({
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  fireworksClientState.cachedFetch = ((input: any, init?: any) => {
    return undiciFetch(input, {
      ...(init ?? {}),
      dispatcher,
    });
  }) as typeof fetch;

  return fireworksClientState.cachedFetch;
}

export function getFireworksClient(): OpenAI {
  if (fireworksClientState.cachedClient) {
    return fireworksClientState.cachedClient;
  }

  fireworksClientState.cachedClient = new OpenAI({
    apiKey: resolveApiKey(),
    baseURL: resolveBaseUrl(),
    timeout: resolveTimeoutMs(),
    fetch: getFireworksFetch(),
  });
  return fireworksClientState.cachedClient;
}
