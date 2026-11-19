import {
  getCachedVercelModelCatalog,
  getVercelModelCatalog,
  type VercelTokenPricing,
} from "./catalog.js";
import { resolveVercelModelId } from "./models.js";

// Default rates from https://ai-gateway.vercel.sh/v1/models, verified 2026-11-19.
// Upstream routes and context tiers can have different rates. Prefer reported usage.cost.
const VERCEL_PRICING: Readonly<Record<string, VercelTokenPricing>> = {
  "deepseek/deepseek-v4.1-flash-1017": {
    inputRate: 0.3 / 1_000_000,
    cachedRate: 0.007 / 1_000_000,
    outputRate: 1.2 / 1_000_000,
  },
  "zai/glm-5.3": {
    inputRate: 1.4 / 1_000_000,
    cachedRate: 0.14 / 1_000_000,
    outputRate: 4.4 / 1_000_000,
  },
  "moonshotai/kimi-k3": {
    inputRate: 3 / 1_000_000,
    cachedRate: 0.3 / 1_000_000,
    outputRate: 15 / 1_000_000,
  },
  "moonshotai/kimi-k3.1-pro": {
    inputRate: 2 / 1_000_000,
    cachedRate: 0.2 / 1_000_000,
    outputRate: 10 / 1_000_000,
  },
  "minimax/minimax-m3": {
    inputRate: 0.3 / 1_000_000,
    cachedRate: 0.06 / 1_000_000,
    outputRate: 1.2 / 1_000_000,
  },
};

export function getVercelPricing(modelId: string): VercelTokenPricing | undefined {
  const id = resolveVercelModelId(modelId);
  if (!id) return undefined;
  return (
    getCachedVercelModelCatalog()?.find((model) => model.id === id)?.pricing ?? VERCEL_PRICING[id]
  );
}

export async function resolveVercelPricing(
  modelId: string,
): Promise<
  { readonly pricing: VercelTokenPricing; readonly source: "catalog" | "estimate" } | undefined
> {
  const id = resolveVercelModelId(modelId);
  if (!id) return undefined;
  try {
    const model = (await getVercelModelCatalog()).find((candidate) => candidate.id === id);
    if (model?.pricing) return { pricing: model.pricing, source: "catalog" };
  } catch {
    // Model calls must remain usable when the optional pricing endpoint is down.
  }
  const pricing = VERCEL_PRICING[id];
  return pricing ? { pricing, source: "estimate" } : undefined;
}

export async function getVercelPricingAsync(
  modelId: string,
): Promise<VercelTokenPricing | undefined> {
  return (await resolveVercelPricing(modelId))?.pricing;
}
