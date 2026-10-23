import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import { resolveVercelBaseUrl } from "./client.js";
import { isVercelModelId } from "./models.js";

/** All rates are USD per token; absent rates are unknown, never implicitly free. */
export type VercelTokenPricing = {
  readonly inputRate: number;
  readonly outputRate: number;
  readonly cachedRate?: number;
  readonly cacheWriteRate?: number;
};

export type VercelCatalogModel = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly type?: string;
  readonly capabilities?: readonly string[];
  readonly pricing?: VercelTokenPricing;
};

const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_RETRY_MS = 30_000;
const CATALOG_TIMEOUT_MS = 1_500;

type CatalogCacheEntry = {
  models?: readonly VercelCatalogModel[];
  refreshAfter: number;
  inFlight?: Promise<readonly VercelCatalogModel[]>;
  lastError?: unknown;
};

function getCatalogState(): Map<string, CatalogCacheEntry> {
  return getRuntimeSingleton(Symbol.for("@ljoukov/llm.vercelCatalogState"), () => new Map());
}

function finiteRate(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseCatalogModel(raw: unknown): VercelCatalogModel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !isVercelModelId(item.id)) return undefined;
  const rates = item.pricing as Record<string, unknown> | undefined;
  const inputRate = finiteRate(rates?.input);
  const outputRate = finiteRate(rates?.output);
  const cachedRate = finiteRate(rates?.input_cache_read);
  const cacheWriteRate = finiteRate(rates?.input_cache_write);
  const pricing =
    inputRate !== undefined && outputRate !== undefined
      ? Object.freeze({ inputRate, outputRate, cachedRate, cacheWriteRate })
      : undefined;
  const capabilities = Array.isArray(item.tags)
    ? Object.freeze(item.tags.filter((tag): tag is string => typeof tag === "string"))
    : undefined;
  return Object.freeze({
    id: item.id,
    name: typeof item.name === "string" ? item.name : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    contextWindow: positiveNumber(item.context_window),
    maxOutputTokens: positiveNumber(item.max_tokens),
    type: typeof item.type === "string" ? item.type : undefined,
    capabilities,
    pricing,
  });
}

async function fetchCatalog(url: string): Promise<readonly VercelCatalogModel[]> {
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abort.abort();
      reject(new Error("Vercel model catalogue request timed out."));
    }, CATALOG_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    return await Promise.race([
      (async () => {
        // The model catalogue is public and needs no user credential.
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) {
          throw new Error(`Vercel model catalogue request failed (${response.status}).`);
        }
        const payload: unknown = await response.json();
        const data =
          payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
        if (!Array.isArray(data)) throw new Error("Invalid Vercel model catalogue response.");
        const models = data.flatMap((raw) => {
          const model = parseCatalogModel(raw);
          return model ? [model] : [];
        });
        if (data.length > 0 && models.length === 0) {
          throw new Error("Vercel model catalogue contained no valid model IDs.");
        }
        return Object.freeze(models);
      })(),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function catalogUrl(): string {
  return `${resolveVercelBaseUrl().replace(/\/+$/, "")}/models`;
}

/** Returns a previously fetched catalogue without starting network work. */
export function getCachedVercelModelCatalog(): readonly VercelCatalogModel[] | undefined {
  return getCatalogState().get(catalogUrl())?.models;
}

/**
 * Public API catalogue, cached in RAM for five minutes and shared across concurrent calls.
 * Failed refreshes retain stale metadata and wait thirty seconds before retrying.
 * An initial failure rejects; cost estimation catches it and uses its static fallback.
 */
export async function getVercelModelCatalog(
  options: { readonly refresh?: boolean } = {},
): Promise<readonly VercelCatalogModel[]> {
  const url = catalogUrl();
  const state = getCatalogState();
  let entry = state.get(url);
  if (!entry) {
    entry = { refreshAfter: 0 };
    state.set(url, entry);
  }
  if (entry.inFlight) return entry.inFlight;
  if (!options.refresh && Date.now() < entry.refreshAfter) {
    if (entry.models) return entry.models;
    throw entry.lastError ?? new Error("Vercel model catalogue is temporarily unavailable.");
  }
  const current = entry;
  current.inFlight = fetchCatalog(url)
    .then((models) => {
      current.models = models;
      current.refreshAfter = Date.now() + CATALOG_TTL_MS;
      current.lastError = undefined;
      return models;
    })
    .catch((error: unknown) => {
      current.refreshAfter = Date.now() + CATALOG_RETRY_MS;
      current.lastError = error;
      if (current.models) return current.models;
      throw error;
    })
    .finally(() => {
      current.inFlight = undefined;
    });
  return current.inFlight;
}
