import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

import { loadLocalEnv } from "../utils/env.js";

let cachedApiKey: string | null = null;
let cachedClient: OpenAI | null = null;
let cachedFetch: typeof fetch | null = null;
let cachedTimeoutMs: number | null = null;

const DEFAULT_OPENAI_TIMEOUT_MS = 15 * 60_000;

function resolveOpenAiTimeoutMs(): number {
  if (cachedTimeoutMs !== null) {
    return cachedTimeoutMs;
  }

  const raw = process.env.OPENAI_STREAM_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  cachedTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPENAI_TIMEOUT_MS;
  return cachedTimeoutMs;
}

function getOpenAiFetch(): typeof fetch {
  if (cachedFetch) {
    return cachedFetch;
  }

  const timeoutMs = resolveOpenAiTimeoutMs();
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

function getOpenAiApiKey(): string {
  if (cachedApiKey !== null) {
    return cachedApiKey;
  }

  loadLocalEnv();

  const raw = process.env.OPENAI_API_KEY;
  const value = raw?.trim();
  if (!value) {
    throw new Error("OPENAI_API_KEY must be provided to access OpenAI APIs.");
  }

  cachedApiKey = value;
  return cachedApiKey;
}

export function getOpenAiClient(): OpenAI {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = getOpenAiApiKey();
  const timeoutMs = resolveOpenAiTimeoutMs();
  cachedClient = new OpenAI({
    apiKey,
    fetch: getOpenAiFetch(),
    timeout: timeoutMs,
  });
  return cachedClient;
}
