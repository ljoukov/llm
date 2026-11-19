import { FIREWORKS_MODEL_IDS, type FireworksModelId, resolveFireworksModelId } from "./models.js";

export type FireworksPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

// Standard direct serverless rates in USD per token, verified 2026-11-19.
// https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash-1017
// https://fireworks.ai/models/fireworks/glm-5p3
// https://fireworks.ai/models/fireworks/kimi-k3
const FIREWORKS_PRICING: Record<FireworksModelId, FireworksPricing> = {
  "deepseek-v4.1-flash-1017": {
    inputRate: 0.3 / 1_000_000,
    cachedRate: 0.006 / 1_000_000,
    outputRate: 1.2 / 1_000_000,
  },
  "glm-5.3": {
    inputRate: 1.4 / 1_000_000,
    cachedRate: 0.26 / 1_000_000,
    outputRate: 4.4 / 1_000_000,
  },
  "kimi-k3": {
    inputRate: 3 / 1_000_000,
    cachedRate: 0.3 / 1_000_000,
    outputRate: 15 / 1_000_000,
  },
};

export function getFireworksPricing(modelId: string): FireworksPricing | undefined {
  const id = modelId.trim();
  const supportedId = FIREWORKS_MODEL_IDS.find(
    (candidate) => candidate === id || resolveFireworksModelId(candidate) === id,
  );
  return supportedId ? FIREWORKS_PRICING[supportedId] : undefined;
}
