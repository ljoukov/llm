import OpenAI from "openai";
import { Agent } from "undici";

import { loadLocalEnv } from "../utils/env.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

import {
  OPENAI_BETA_RESPONSES_WEBSOCKETS_V2,
  createAdaptiveResponsesStream,
  createResponsesWebSocketStream,
  isResponsesWebSocketUnsupportedError,
  mergeOpenAiBetaHeader,
  resolveResponsesWebSocketMode,
  toWebSocketUrl,
  type ResponsesStreamWithFinal,
} from "./responses-websocket.js";

const openAiClientState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.openAiClientState"), () => ({
  cachedApiKey: null as string | null,
  cachedClient: null as OpenAI | null,
  cachedFetch: null as typeof fetch | null,
  cachedTimeoutMs: null as number | null,
  openAiResponsesWebSocketMode: null as "auto" | "off" | "only" | null,
  openAiResponsesWebSocketDisabled: false,
}));

const DEFAULT_OPENAI_TIMEOUT_MS = 15 * 60_000;

function resolveOpenAiTimeoutMs(): number {
  if (openAiClientState.cachedTimeoutMs !== null) {
    return openAiClientState.cachedTimeoutMs;
  }

  const raw = process.env.OPENAI_STREAM_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  openAiClientState.cachedTimeoutMs =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPENAI_TIMEOUT_MS;
  return openAiClientState.cachedTimeoutMs;
}

function getOpenAiFetch(): typeof fetch {
  if (openAiClientState.cachedFetch) {
    return openAiClientState.cachedFetch;
  }

  const timeoutMs = resolveOpenAiTimeoutMs();
  const dispatcher = new Agent({
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  openAiClientState.cachedFetch = ((input: any, init?: any) => {
    return fetch(input, {
      ...(init ?? {}),
      dispatcher,
    });
  }) as typeof fetch;

  return openAiClientState.cachedFetch;
}

function resolveOpenAiBaseUrl(): string {
  loadLocalEnv();
  return process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
}

function resolveOpenAiResponsesWebSocketMode(): "auto" | "off" | "only" {
  if (openAiClientState.openAiResponsesWebSocketMode) {
    return openAiClientState.openAiResponsesWebSocketMode;
  }
  loadLocalEnv();
  openAiClientState.openAiResponsesWebSocketMode = resolveResponsesWebSocketMode(
    process.env.OPENAI_RESPONSES_WEBSOCKET_MODE,
    "auto",
  );
  return openAiClientState.openAiResponsesWebSocketMode;
}

function wrapFallbackStream<TEvent = unknown, TFinal = unknown>(
  stream: AsyncIterable<TEvent> & { finalResponse: () => Promise<TFinal> },
): ResponsesStreamWithFinal<TEvent, TFinal> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
      for await (const event of stream) {
        yield event;
      }
    },
    async finalResponse(): Promise<TFinal> {
      return await stream.finalResponse();
    },
    close(): void {
      const maybeClose = stream as { close?: () => void };
      if (typeof maybeClose.close === "function") {
        maybeClose.close();
      }
    },
  };
}

function buildOpenAiResponsesEndpointUrl(): string {
  const base = resolveOpenAiBaseUrl();
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL("responses", normalized).toString();
}

function buildOpenAiResponsesWebSocketHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Beta": mergeOpenAiBetaHeader(
      process.env.OPENAI_BETA,
      OPENAI_BETA_RESPONSES_WEBSOCKETS_V2,
    ),
  };
  const organization = process.env.OPENAI_ORGANIZATION?.trim();
  if (organization) {
    headers["OpenAI-Organization"] = organization;
  }
  const project = process.env.OPENAI_PROJECT?.trim();
  if (project) {
    headers["OpenAI-Project"] = project;
  }
  return headers;
}

function installResponsesWebSocketTransport(client: OpenAI, apiKey: string): void {
  const responsesApi = client.responses as {
    stream?: (
      request: unknown,
      options?: unknown,
    ) => AsyncIterable<unknown> & {
      finalResponse: () => Promise<unknown>;
    };
  };
  const streamMethod = responsesApi?.stream;
  if (typeof streamMethod !== "function") {
    return;
  }

  const originalStream = streamMethod.bind(client.responses);
  responsesApi.stream = (request: unknown, options?: unknown) => {
    const mode = resolveOpenAiResponsesWebSocketMode();
    const fallbackStreamFactory = (): ResponsesStreamWithFinal =>
      wrapFallbackStream(originalStream(request, options) as any);

    if (mode === "off" || openAiClientState.openAiResponsesWebSocketDisabled) {
      return fallbackStreamFactory() as any;
    }

    const signal =
      options && typeof options === "object"
        ? ((options as { signal?: AbortSignal }).signal ?? undefined)
        : undefined;
    const websocketUrl = toWebSocketUrl(buildOpenAiResponsesEndpointUrl());
    const headers = buildOpenAiResponsesWebSocketHeaders(apiKey);
    const timeoutMs = resolveOpenAiTimeoutMs();

    return createAdaptiveResponsesStream({
      mode,
      createWebSocketStream: async () =>
        await createResponsesWebSocketStream({
          url: websocketUrl,
          headers,
          request,
          signal,
          idleTimeoutMs: timeoutMs,
        }),
      createFallbackStream: fallbackStreamFactory,
      onWebSocketFallback: (error) => {
        if (isResponsesWebSocketUnsupportedError(error)) {
          openAiClientState.openAiResponsesWebSocketDisabled = true;
        }
      },
    }) as any;
  };
}

function getOpenAiApiKey(): string {
  if (openAiClientState.cachedApiKey !== null) {
    return openAiClientState.cachedApiKey;
  }

  loadLocalEnv();

  const raw = process.env.OPENAI_API_KEY;
  const value = raw?.trim();
  if (!value) {
    throw new Error("OPENAI_API_KEY must be provided to access OpenAI APIs.");
  }

  openAiClientState.cachedApiKey = value;
  return openAiClientState.cachedApiKey;
}

export function getOpenAiClient(): OpenAI {
  if (openAiClientState.cachedClient) {
    return openAiClientState.cachedClient;
  }

  loadLocalEnv();
  const apiKey = getOpenAiApiKey();
  const timeoutMs = resolveOpenAiTimeoutMs();
  openAiClientState.cachedClient = new OpenAI({
    apiKey,
    fetch: getOpenAiFetch(),
    timeout: timeoutMs,
  });
  installResponsesWebSocketTransport(openAiClientState.cachedClient, apiKey);
  return openAiClientState.cachedClient;
}
