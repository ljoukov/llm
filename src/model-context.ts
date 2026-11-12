import { getAnthropicClient } from "./anthropic/client.js";
import { getFireworksClient } from "./fireworks/client.js";
import { resolveFireworksModelId } from "./fireworks/models.js";
import { getGeminiBackend, getGeminiClient } from "./google/client.js";
import {
  resolveModelRef,
  type LlmAccess,
  type LlmProvider,
  type LlmTextModelSelection,
  type ResolvedModelRef,
} from "./model-selection.js";
import { fetchChatGptCodexModels } from "./openai/chatgpt-codex.js";
import { isChatGptModelId, resolveChatGptProviderModel } from "./openai/models.js";
import { getRuntimeSingleton } from "./utils/runtimeSingleton.js";
import { loadLocalEnv } from "./utils/env.js";
import { getVercelModelCatalog } from "./vercel/catalog.js";
import { getXaiClient } from "./xai/client.js";

export type ModelContextWindow = {
  readonly provider: LlmProvider;
  readonly access: LlmAccess;
  readonly model: string;
  /** The provider's input limit or total context window, as identified by limitType. */
  readonly contextWindowTokens: number;
  readonly limitType: "input" | "context";
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly source: "provider" | "catalog" | "override";
};

export type ResolveModelContextWindowOptions = {
  readonly signal?: AbortSignal;
  /** Explicit total context window for private deployments or missing provider metadata. */
  readonly contextWindowTokens?: number;
};

const CACHE_TTL_MS = 60 * 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

type PendingDiscovery = {
  readonly controller: AbortController;
  readonly promise: Promise<ModelContextWindow>;
  waiters: number;
};
type CacheEntry = {
  value?: ModelContextWindow;
  expiresAt?: number;
  pending?: PendingDiscovery;
};

function cache(): Map<string, CacheEntry> {
  return getRuntimeSingleton(Symbol.for("@ljoukov/llm.modelContextWindowCache"), () => new Map());
}

/** Discard cached metadata, for example after changing a private deployment's limits. */
export function clearModelContextWindowCache(): void {
  for (const entry of cache().values()) entry.pending?.controller.abort();
  cache().clear();
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contextError(route: ResolvedModelRef): Error {
  return new Error(
    `No context-window metadata is available for ${route.provider}:${route.access}:${route.model}. ` +
      "Set compaction.contextWindowTokens for this deployment or supply an explicit compaction.thresholdTokens.",
  );
}

function routeScope(route: ResolvedModelRef): string {
  switch (route.provider) {
    case "google":
      return JSON.stringify([
        getGeminiBackend(),
        process.env.GOOGLE_CLOUD_PROJECT,
        process.env.GOOGLE_CLOUD_LOCATION,
        process.env.GOOGLE_GENAI_USE_VERTEXAI,
      ]);
    case "vercel":
      return process.env.VERCEL_AI_GATEWAY_BASE_URL ?? process.env.AI_GATEWAY_BASE_URL ?? "";
    case "fireworks":
      return process.env.FIREWORKS_BASE_URL ?? "";
    case "xai":
      return route.access === "api" ? (process.env.XAI_BASE_URL ?? "") : "subscription";
    case "openai":
      return route.access === "api"
        ? (process.env.OPENAI_BASE_URL ?? "")
        : (process.env.CHATGPT_CODEX_ENDPOINT ?? process.env.LLM_PROXY_URL ?? "");
    default:
      return "";
  }
}

// OpenAI's Models REST resource does not report token limits. These literal API-only
// values were verified against each official model page on 2026-11-12:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// Never infer a subscription limit or a private deployment limit from these values.
const OPENAI_API_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "gpt-6.1-sol": 1_050_000,
  "gpt-6-astra": 1_050_000,
  "gpt-6-sol": 1_050_000,
  "gpt-6-luna": 1_050_000,
  "gpt-5.6": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
});

// Vertex's publisher-model metadata currently omits token limits. Use exact model
// documentation only when a successful metadata request has no limits. Moving
// aliases deliberately have no static value. Verified on 2026-11-12:
// https://aistudio.google.com/docs/models/gemini-3.8-flash
// https://aistudio.google.com/docs/models/gemini-3.1-pro-preview
// https://aistudio.google.com/docs/models/gemini-3-flash-preview
// https://aistudio.google.com/docs/models/gemini-2.5-pro
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
const GEMINI_CATALOG_LIMITS: Readonly<
  Record<string, { limitType: "input" | "context"; maxOutputTokens: number }>
> = Object.freeze({
  "gemini-4-argon": { limitType: "context", maxOutputTokens: 65_536 },
  "gemini-3.8-flash": { limitType: "input", maxOutputTokens: 65_536 },
  "gemini-3.1-pro-preview": { limitType: "input", maxOutputTokens: 65_536 },
  "gemini-3-flash-preview": { limitType: "input", maxOutputTokens: 65_536 },
  "gemini-2.5-pro": { limitType: "input", maxOutputTokens: 65_536 },
});

async function discoverContextWindow(
  route: ResolvedModelRef,
  signal: AbortSignal,
): Promise<ModelContextWindow> {
  const identity = { provider: route.provider, access: route.access, model: route.model };
  if (route.provider === "openai" && route.access === "api") {
    const customBase = process.env.OPENAI_BASE_URL?.trim();
    const contextWindowTokens = OPENAI_API_CONTEXT_WINDOWS[route.model];
    if (
      !contextWindowTokens ||
      (customBase && customBase.replace(/\/+$/u, "") !== "https://api.openai.com/v1")
    )
      throw contextError(route);
    return {
      ...identity,
      contextWindowTokens,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      limitType: "context",
      source: "catalog",
    };
  }
  if (route.provider === "openai" && route.access === "subscription") {
    const models = await fetchChatGptCodexModels({ signal });
    const nativeModel = isChatGptModelId(route.model)
      ? resolveChatGptProviderModel(route.model)
      : route.model;
    const model = models
      .map(record)
      .find((entry) => entry?.slug === nativeModel || entry?.id === nativeModel);
    // context_window is the configured default; max_context_window may require
    // an opt-in and must not silently enlarge a subscription's active budget.
    const reportedWindow = positiveInteger(model?.context_window);
    // The official GPT-6.1 Sol page explicitly distinguishes its 500K default in
    // Codex/ChatGPT Work from the API's 1.05M window. No other subscription values
    // are inferred from API model documentation.
    // https://developers.openai.com/api/docs/models/gpt-6.1-sol
    const contextWindowTokens =
      reportedWindow ?? (route.model === "gpt-6.1-sol" ? 500_000 : undefined);
    if (!contextWindowTokens) throw contextError(route);
    return {
      ...identity,
      contextWindowTokens,
      maxOutputTokens: positiveInteger(model?.max_output_tokens),
      limitType: "context",
      source: reportedWindow ? "provider" : "catalog",
    };
  }
  if (route.provider === "google") {
    const model = await (await getGeminiClient()).models.get({
      model: route.model,
      config: { abortSignal: signal },
    });
    const catalog = GEMINI_CATALOG_LIMITS[route.model];
    const inputLimit = positiveInteger(model.inputTokenLimit);
    if (!inputLimit && !catalog) throw contextError(route);
    const contextWindowTokens = inputLimit ?? 1_048_576;
    // Gemini 4 uses a unified input/output window, unlike Gemini 2/3.
    const limitType = catalog?.limitType ?? "input";
    return {
      ...identity,
      contextWindowTokens,
      maxInputTokens: limitType === "input" ? contextWindowTokens : undefined,
      maxOutputTokens: positiveInteger(model.outputTokenLimit) ?? catalog?.maxOutputTokens,
      limitType,
      source: inputLimit ? "provider" : "catalog",
    };
  }
  if (route.provider === "anthropic" && route.access === "api") {
    const model = record(await getAnthropicClient().getModel(route.model, { signal }));
    const inputLimit = positiveInteger(model?.max_input_tokens);
    if (!inputLimit) throw contextError(route);
    return {
      ...identity,
      contextWindowTokens: inputLimit,
      maxInputTokens: inputLimit,
      maxOutputTokens: positiveInteger(model?.max_tokens),
      limitType: "input",
      source: "provider",
    };
  }
  if (route.provider === "vercel") {
    const model = (await getVercelModelCatalog()).find((entry) => entry.id === route.model);
    signal.throwIfAborted();
    const contextWindowTokens = positiveInteger(model?.contextWindow);
    if (!contextWindowTokens) throw contextError(route);
    return {
      ...identity,
      contextWindowTokens,
      maxOutputTokens: positiveInteger(model?.maxOutputTokens),
      limitType: "context",
      source: "provider",
    };
  }
  if (route.provider === "xai") {
    const client = await getXaiClient(route.model, route.access);
    const page = await client.models.list({ signal, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS });
    const model = page.data.map(record).find((entry) => entry?.id === route.model);
    const contextWindowTokens =
      positiveInteger(model?.context_length) ?? positiveInteger(model?.context_window);
    if (!contextWindowTokens) throw contextError(route);
    return {
      ...identity,
      contextWindowTokens,
      maxOutputTokens: positiveInteger(model?.max_output_tokens),
      limitType: "context",
      source: "provider",
    };
  }
  if (route.provider === "fireworks") {
    const client = getFireworksClient();
    const nativeModel = resolveFireworksModelId(route.model);
    if (!nativeModel) throw contextError(route);
    // Fireworks publishes contextLength on its management Model resource, not the
    // OpenAI-compatible Model resource. Preserve any configured proxy's origin.
    const url = new URL(`/v1/${nativeModel}`, client.baseURL).toString();
    const model = record(
      await client.get<unknown>(url, { signal, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS }),
    );
    const contextWindowTokens = positiveInteger(model?.contextLength);
    if (!contextWindowTokens) throw contextError(route);
    return { ...identity, contextWindowTokens, limitType: "context", source: "provider" };
  }
  throw contextError(route);
}

async function waitForDiscovery(
  pending: PendingDiscovery,
  signal?: AbortSignal,
): Promise<ModelContextWindow> {
  signal?.throwIfAborted();
  pending.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await pending.promise;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Model metadata discovery aborted."));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([pending.promise, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    pending.waiters -= 1;
    if (pending.waiters === 0) pending.controller.abort();
  }
}

/**
 * Discover the selected route's limits, caching successful results for one hour.
 * Concurrent callers share discovery; a caller aborting does not cancel another
 * caller's lookup. Failed/abandoned discoveries are never cached.
 */
export async function resolveModelContextWindow(
  selection: LlmTextModelSelection,
  options: ResolveModelContextWindowOptions = {},
): Promise<ModelContextWindow> {
  options.signal?.throwIfAborted();
  loadLocalEnv();
  const route = resolveModelRef(selection);
  if (options.contextWindowTokens !== undefined) {
    const contextWindowTokens = positiveInteger(options.contextWindowTokens);
    if (!contextWindowTokens)
      throw new Error("contextWindowTokens must be a positive safe integer.");
    return {
      provider: route.provider,
      access: route.access,
      model: route.model,
      contextWindowTokens,
      limitType: "context",
      source: "override",
    };
  }
  const key = JSON.stringify([route.provider, route.access, route.model, routeScope(route)]);
  const state = cache();
  let entry = state.get(key);
  if (entry?.value && (entry.expiresAt ?? 0) > Date.now()) return entry.value;
  if (!entry?.pending || entry.pending.controller.signal.aborted) {
    entry = {};
    state.set(key, entry);
    const current = entry;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
    const promise = discoverContextWindow(route, signal)
      .then((value) => {
        signal.throwIfAborted();
        const result = Object.freeze(value);
        current.value = result;
        current.expiresAt = Date.now() + CACHE_TTL_MS;
        return result;
      })
      .catch((error: unknown) => {
        if (state.get(key) === current) state.delete(key);
        throw error;
      })
      .finally(() => {
        current.pending = undefined;
      });
    entry.pending = { controller, promise, waiters: 0 };
  }
  return await waitForDiscovery(entry.pending, options.signal);
}
