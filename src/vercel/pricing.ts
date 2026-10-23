import type { FireworksPricing } from "../fireworks/pricing.js";
import { VERCEL_MODEL_IDS, type VercelModelId, resolveVercelModelId } from "./models.js";

// Default-route USD/token from https://ai-gateway.vercel.sh/v1/models, 2026-10-23.
// Cost-sorted upstream routing may have different rates: prefer reported usage.cost.
const VERCEL_PRICING: Record<VercelModelId, FireworksPricing> = {
  "deepseek-v4.1-flash-1017": {
    inputRate: 0.075 / 1_000_000,
    cachedRate: 0.0015 / 1_000_000,
    outputRate: 0.3 / 1_000_000,
  },
  "glm-5.3": {
    inputRate: 1.2 / 1_000_000,
    cachedRate: 0.2 / 1_000_000,
    outputRate: 4 / 1_000_000,
  },
  "kimi-k3": {
    inputRate: 3 / 1_000_000,
    cachedRate: 0.3 / 1_000_000,
    outputRate: 15 / 1_000_000,
  },
};

export function getVercelPricing(modelId: string): FireworksPricing | undefined {
  const id = modelId.trim();
  const supportedId = VERCEL_MODEL_IDS.find(
    (candidate) => candidate === id || resolveVercelModelId(candidate) === id,
  );
  return supportedId ? VERCEL_PRICING[supportedId] : undefined;
}
