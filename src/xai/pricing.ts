export type XaiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

// Standard API USD/token snapshot, 2026-10-23; long context starts at 200k input tokens.
// https://docs.x.ai/developers/pricing
const XAI_PRICING: Readonly<Record<string, XaiPricing>> = {
  "grok-4.7": { inputRate: 2 / 1_000_000, cachedRate: 0.5 / 1_000_000, outputRate: 6 / 1_000_000 },
  "grok-4.6": { inputRate: 2 / 1_000_000, cachedRate: 0.5 / 1_000_000, outputRate: 6 / 1_000_000 },
  "grok-4.5": { inputRate: 2 / 1_000_000, cachedRate: 0.3 / 1_000_000, outputRate: 6 / 1_000_000 },
  "grok-build-0.1": {
    inputRate: 1 / 1_000_000,
    cachedRate: 0.2 / 1_000_000,
    outputRate: 2 / 1_000_000,
  },
};

export function getXaiPricing(modelId: string, promptTokens = 0): XaiPricing | undefined {
  const id = modelId.trim();
  if (!Object.hasOwn(XAI_PRICING, id)) return undefined;
  const pricing = XAI_PRICING[id];
  if (!pricing || promptTokens < 200_000) return pricing;
  return {
    inputRate: pricing.inputRate * 2,
    cachedRate: pricing.cachedRate * 2,
    outputRate: pricing.outputRate * 2,
  };
}
