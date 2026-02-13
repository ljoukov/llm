import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

import { loadLocalEnv } from "../utils/env.js";

const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_FIREWORKS_TIMEOUT_MS = 15 * 60_000;

let cachedClient: OpenAI | null = null;
let cachedFetch: typeof fetch | null = null;
let cachedBaseUrl: string | null = null;
let cachedApiKey: string | null = null;
let cachedTimeoutMs: number | null = null;

function resolveTimeoutMs(): number {
  if (cachedTimeoutMs !== null) {
    return cachedTimeoutMs;
  }

  const raw = process.env.FIREWORKS_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  cachedTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FIREWORKS_TIMEOUT_MS;
  return cachedTimeoutMs;
}

function resolveBaseUrl(): string {
  if (cachedBaseUrl !== null) {
    return cachedBaseUrl;
  }

  loadLocalEnv();
  const raw = process.env.FIREWORKS_BASE_URL?.trim();
  cachedBaseUrl = raw && raw.length > 0 ? raw : DEFAULT_FIREWORKS_BASE_URL;
  return cachedBaseUrl;
}

function resolveApiKey(): string {
  if (cachedApiKey !== null) {
    return cachedApiKey;
  }

  loadLocalEnv();
  const raw = process.env.FIREWORKS_TOKEN ?? process.env.FIREWORKS_API_KEY;
  const token = raw?.trim();
  if (!token) {
    throw new Error(
      "FIREWORKS_TOKEN (or FIREWORKS_API_KEY) must be provided to access Fireworks APIs.",
    );
  }

  cachedApiKey = token;
  return cachedApiKey;
}

function getFireworksFetch(): typeof fetch {
  if (cachedFetch) {
    return cachedFetch;
  }

  const timeoutMs = resolveTimeoutMs();
  const dispatcher = new Agent({
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  cachedFetch = ((input: any, init?: any) => {
    return undiciFetch(input, {
      ...(init ?? {}),
      dispatcher,
    });
  }) as typeof fetch;

  return cachedFetch;
}

export function getFireworksClient(): OpenAI {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = new OpenAI({
    apiKey: resolveApiKey(),
    baseURL: resolveBaseUrl(),
    timeout: resolveTimeoutMs(),
    fetch: getFireworksFetch(),
  });
  return cachedClient;
}
