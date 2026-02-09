export type GeminiProPricing = {
  readonly threshold: number;
  readonly inputRateLow: number;
  readonly inputRateHigh: number;
  readonly cachedRateLow: number;
  readonly cachedRateHigh: number;
  readonly outputRateLow: number;
  readonly outputRateHigh: number;
};

export type GeminiImagePricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputTextRate: number;
  readonly outputImageRate: number;
  readonly imagePrices: Record<string, number>;
};

// Gemini pricing snapshot (best-effort). For current official pricing, see:
// https://cloud.google.com/vertex-ai/generative-ai/pricing
const GEMINI_3_PRO_PREVIEW_PRICING: GeminiProPricing = {
  threshold: 200_000,
  inputRateLow: 2 / 1_000_000,
  inputRateHigh: 4 / 1_000_000,
  cachedRateLow: 0.2 / 1_000_000,
  cachedRateHigh: 0.4 / 1_000_000,
  outputRateLow: 12 / 1_000_000,
  outputRateHigh: 18 / 1_000_000,
};

// Pricing from Gemini 2.5 Pro public rates (per 1M tokens, USD):
// - Input: $1.25 (<=200k prompt tokens), $2.50 (>200k)
// - Output (including thinking): $10.00 (<=200k), $15.00 (>200k)
// - Context caching: $0.125 (<=200k), $0.25 (>200k)
const GEMINI_2_5_PRO_PRICING: GeminiProPricing = {
  threshold: 200_000,
  inputRateLow: 1.25 / 1_000_000,
  inputRateHigh: 2.5 / 1_000_000,
  cachedRateLow: 0.125 / 1_000_000,
  cachedRateHigh: 0.25 / 1_000_000,
  outputRateLow: 10 / 1_000_000,
  outputRateHigh: 15 / 1_000_000,
};

const GEMINI_IMAGE_PREVIEW_PRICING: GeminiImagePricing = {
  inputRate: 2 / 1_000_000,
  cachedRate: 0.2 / 1_000_000,
  outputTextRate: 12 / 1_000_000,
  outputImageRate: 120 / 1_000_000,
  imagePrices: {
    "1K": 0.134,
    "2K": 0.134,
    "4K": 0.24,
  },
};

export function getGeminiProPricing(modelId: string): GeminiProPricing | undefined {
  if (modelId.includes("gemini-2.5-pro")) {
    return GEMINI_2_5_PRO_PRICING;
  }
  if (modelId.includes("gemini-3-pro")) {
    return GEMINI_3_PRO_PREVIEW_PRICING;
  }
  return undefined;
}

export function getGeminiImagePricing(modelId: string): GeminiImagePricing | undefined {
  if (modelId.includes("image-preview")) {
    return GEMINI_IMAGE_PREVIEW_PRICING;
  }
  return undefined;
}
