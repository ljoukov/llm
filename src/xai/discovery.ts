import { parseModelReasoningOptions, type ModelReasoningOption } from "../model-reasoning.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

import { getXaiClient } from "./client.js";
import { isXaiModelId, type XaiAccess } from "./models.js";
import { getXaiPricing, type XaiPricing } from "./pricing.js";

export type DiscoveredXaiModel = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly contextWindow?: number;
  readonly reasoningOptions?: readonly ModelReasoningOption[];
  readonly defaultReasoningEffort?: string;
  readonly pricing?: XaiPricing;
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reasoningMetadata(row: Record<string, unknown>) {
  const capabilities = record(row.capabilities);
  return {
    reasoningOptions:
      capabilities?.reasoning_effort === undefined
        ? undefined
        : parseModelReasoningOptions([{ type: "effort", values: capabilities.reasoning_effort }]),
    defaultReasoningEffort: optionalString(capabilities?.default_reasoning_effort),
  };
}

function reasoningCache() {
  return getRuntimeSingleton(
    Symbol.for("@ljoukov/llm.xaiReasoningCache"),
    () => new Map<string, readonly ModelReasoningOption[]>(),
  );
}

function reasoningKey(access: XaiAccess, model: string): string {
  return JSON.stringify([
    access,
    access === "api"
      ? process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1"
      : "https://cli-chat-proxy.grok.com/v1",
    model,
  ]);
}

/** Read only already-discovered metadata; never starts authentication or network work. */
export function getCachedXaiReasoning(
  access: XaiAccess,
  model: string,
): readonly ModelReasoningOption[] | undefined {
  return reasoningCache().get(reasoningKey(access, model));
}

/** Resolve the authenticated route's catalogue; API and subscription availability are independent. */
export async function discoverXaiModels(
  access: XaiAccess = "api",
): Promise<readonly DiscoveredXaiModel[]> {
  const client = await getXaiClient(undefined, access);
  const page = await client.models.list();
  const models = new Map<string, DiscoveredXaiModel>();
  for (const item of page.data) {
    const row = record(item);
    if (!row) continue;
    const id = optionalString(row.id) ?? optionalString(row.model);
    if (!id || !isXaiModelId(id) || models.has(id)) continue;
    models.set(id, {
      id,
      name: optionalString(row.name),
      description: optionalString(row.description),
      contextWindow:
        positiveNumber(row.context_window) ??
        positiveNumber(row.contextWindow) ??
        positiveNumber(row.context_length),
      ...reasoningMetadata(row),
      // An API-equivalent token estimate is not a subscription charge.
      pricing: access === "api" ? getXaiPricing(id) : undefined,
    });
  }
  if ([...models.values()].some((model) => model.reasoningOptions === undefined)) {
    // Some /models responses contain only IDs. Enrich from the same authenticated route;
    // never use the public API catalogue to infer subscription capabilities or availability.
    try {
      const payload = await client.get<unknown>("/language-models", {
        timeout: 1_500,
        maxRetries: 0,
        signal: AbortSignal.timeout(1_500),
      });
      const rows = record(payload)?.models;
      if (Array.isArray(rows)) {
        for (const value of rows) {
          const row = record(value);
          if (!row) continue;
          const ids = [row.id, ...(Array.isArray(row.aliases) ? row.aliases : [])];
          const metadata = reasoningMetadata(row);
          for (const id of ids) {
            if (typeof id !== "string") continue;
            const model = models.get(id);
            if (!model) continue;
            models.set(id, {
              ...model,
              reasoningOptions: model.reasoningOptions ?? metadata.reasoningOptions,
              defaultReasoningEffort:
                model.defaultReasoningEffort ?? metadata.defaultReasoningEffort,
            });
          }
        }
      }
    } catch {
      // Optional metadata must not hide an otherwise usable model list. Proxies may not
      // implement this endpoint. No static model-name guesses or generation probes.
    }
  }
  for (const model of models.values()) {
    const key = reasoningKey(access, model.id);
    if (model.reasoningOptions !== undefined) {
      reasoningCache().set(key, model.reasoningOptions);
    } else {
      reasoningCache().delete(key);
    }
  }
  return [...models.values()];
}
