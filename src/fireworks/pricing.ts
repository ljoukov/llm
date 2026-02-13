export type FireworksPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

const FIREWORKS_KIMI_K25_PRICING: FireworksPricing = {
  inputRate: 0.6 / 1_000_000,
  cachedRate: 0.1 / 1_000_000,
  outputRate: 3.0 / 1_000_000,
};

const FIREWORKS_GLM_5_PRICING: FireworksPricing = {
  inputRate: 1.0 / 1_000_000,
  cachedRate: 0.2 / 1_000_000,
  outputRate: 3.2 / 1_000_000,
};

const FIREWORKS_MINIMAX_M21_PRICING: FireworksPricing = {
  inputRate: 0.3 / 1_000_000,
  cachedRate: 0.15 / 1_000_000,
  outputRate: 1.2 / 1_000_000,
};

export function getFireworksPricing(modelId: string): FireworksPricing | undefined {
  if (modelId.includes("kimi-k2.5") || modelId.includes("kimi-k2p5")) {
    return FIREWORKS_KIMI_K25_PRICING;
  }
  if (modelId.includes("glm-5")) {
    return FIREWORKS_GLM_5_PRICING;
  }
  if (modelId.includes("minimax-m2.1") || modelId.includes("minimax-m2p1")) {
    return FIREWORKS_MINIMAX_M21_PRICING;
  }
  return undefined;
}
