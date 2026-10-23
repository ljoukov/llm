import { getXaiClient } from "./client.js";
import { isXaiModelId, type XaiAccess } from "./models.js";
import { getXaiPricing, type XaiPricing } from "./pricing.js";

export type DiscoveredXaiModel = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly contextWindow?: number;
  readonly pricing?: XaiPricing;
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Resolve the authenticated route's catalogue; API and subscription availability are independent. */
export async function discoverXaiModels(
  access: XaiAccess = "api",
): Promise<readonly DiscoveredXaiModel[]> {
  const client = await getXaiClient(undefined, access);
  const page = await client.models.list();
  const models = new Map<string, DiscoveredXaiModel>();
  for (const item of page.data) {
    const row = item as unknown as Record<string, unknown>;
    const id = optionalString(row.id) ?? optionalString(row.model);
    if (!id || !isXaiModelId(id) || models.has(id)) continue;
    models.set(id, {
      id,
      name: optionalString(row.name),
      description: optionalString(row.description),
      contextWindow: positiveNumber(row.context_window) ?? positiveNumber(row.contextWindow),
      // An API-equivalent token estimate is not a subscription charge.
      pricing: access === "api" ? getXaiPricing(id) : undefined,
    });
  }
  return [...models.values()];
}
