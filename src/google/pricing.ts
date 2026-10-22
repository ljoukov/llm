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

// Gemini Developer API Standard pricing, verified October 22, 2026:
// https://ai.google.dev/gemini-api/docs/pricing
// These models have flat context rates. Scheduled price increases take effect in UTC.
function flatTextPricing(input: number, output: number, cached: number): GeminiProPricing {
  return {
    threshold: Number.POSITIVE_INFINITY,
    inputRateLow: input / 1_000_000,
    inputRateHigh: input / 1_000_000,
    cachedRateLow: cached / 1_000_000,
    cachedRateHigh: cached / 1_000_000,
    outputRateLow: output / 1_000_000,
    outputRateHigh: output / 1_000_000,
  };
}

const GEMINI_4_ARGON_INTRO_PRICING = flatTextPricing(2, 10, 0.1);
const GEMINI_4_ARGON_PRICING = flatTextPricing(4, 20, 0.2);
const GEMINI_4_ARGON_PRICE_INCREASE_AT = Date.parse("2026-12-01T00:00:00Z");

const GEMINI_3_8_FLASH_INTRO_PRICING = flatTextPricing(0.75, 3.75, 0.075);
const GEMINI_3_8_FLASH_PRICING = flatTextPricing(1.5, 7.5, 0.15);
const GEMINI_3_8_FLASH_PRICE_INCREASE_AT = Date.parse("2027-01-01T00:00:00Z");

const GEMINI_3_FLASH_PREVIEW_PRICING = flatTextPricing(0.5, 3, 0.05);

// Concrete versions may be reported by the API when a supported latest alias is requested.
// Standard global rates: https://cloud.google.com/vertex-ai/generative-ai/pricing
const GEMINI_3_5_FLASH_PRICING = flatTextPricing(1.5, 9, 0.15);
const GEMINI_3_5_FLASH_LITE_PRICING = flatTextPricing(0.3, 2.5, 0.03);

// Gemini 3.1 Pro Standard rates: https://ai.google.dev/gemini-api/docs/pricing
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

// Pricing from Gemini 2.5 Flash public rates (standard, text/image/video):
// - Input: $0.30
// - Output (including thinking): $2.50
// - Context caching: $0.03
const GEMINI_2_5_FLASH_PRICING: GeminiProPricing = {
  threshold: 200_000,
  inputRateLow: 0.3 / 1_000_000,
  inputRateHigh: 0.3 / 1_000_000,
  cachedRateLow: 0.03 / 1_000_000,
  cachedRateHigh: 0.03 / 1_000_000,
  outputRateLow: 2.5 / 1_000_000,
  outputRateHigh: 2.5 / 1_000_000,
};

// Pricing from Gemini 2.5 Flash Lite public rates (standard, text/image/video):
// - Input: $0.10
// - Output (including thinking): $0.40
// - Context caching: $0.01
const GEMINI_2_5_FLASH_LITE_PRICING: GeminiProPricing = {
  threshold: 200_000,
  inputRateLow: 0.1 / 1_000_000,
  inputRateHigh: 0.1 / 1_000_000,
  cachedRateLow: 0.01 / 1_000_000,
  cachedRateHigh: 0.01 / 1_000_000,
  outputRateLow: 0.4 / 1_000_000,
  outputRateHigh: 0.4 / 1_000_000,
};

const GEMINI_3_PRO_IMAGE_PREVIEW_PRICING: GeminiImagePricing = {
  inputRate: 2 / 1_000_000,
  cachedRate: 0.2 / 1_000_000,
  outputTextRate: 12 / 1_000_000,
  outputImageRate: 120 / 1_000_000,
  imagePrices: {
    "1K": (1120 * 120) / 1_000_000,
    "2K": (1120 * 120) / 1_000_000,
    "4K": (2000 * 120) / 1_000_000,
  },
};

const GEMINI_3_1_FLASH_IMAGE_PREVIEW_PRICING: GeminiImagePricing = {
  inputRate: 0.5 / 1_000_000,
  cachedRate: 0.05 / 1_000_000,
  outputTextRate: 3 / 1_000_000,
  outputImageRate: 60 / 1_000_000,
  imagePrices: {
    "512": (747 * 60) / 1_000_000,
    "1K": (1120 * 60) / 1_000_000,
    "2K": (1680 * 60) / 1_000_000,
    "4K": (2520 * 60) / 1_000_000,
  },
};

export function getGeminiProPricing(modelId: string): GeminiProPricing | undefined {
  if (modelId.includes("gemini-4-argon")) {
    return Date.now() < GEMINI_4_ARGON_PRICE_INCREASE_AT
      ? GEMINI_4_ARGON_INTRO_PRICING
      : GEMINI_4_ARGON_PRICING;
  }
  if (
    modelId.includes("gemini-3.8-flash") ||
    modelId.includes("gemini-3.7-flash") ||
    modelId.includes("gemini-3.6-flash")
  ) {
    return Date.now() < GEMINI_3_8_FLASH_PRICE_INCREASE_AT
      ? GEMINI_3_8_FLASH_INTRO_PRICING
      : GEMINI_3_8_FLASH_PRICING;
  }
  if (modelId.includes("gemini-2.5-pro")) {
    return GEMINI_2_5_PRO_PRICING;
  }
  if (modelId.includes("gemini-3.5-flash-lite")) {
    return GEMINI_3_5_FLASH_LITE_PRICING;
  }
  // The May 19, 2026 changelog explicitly switched flash-latest to 3.5 Flash.
  // https://ai.google.dev/gemini-api/docs/changelog#may-19-2026
  // Latest aliases can change; prefer a known concrete modelVersion from the response.
  if (modelId.includes("gemini-3.5-flash") || modelId.includes("gemini-flash-latest")) {
    return GEMINI_3_5_FLASH_PRICING;
  }
  if (modelId.includes("gemini-2.5-flash-lite") || modelId.includes("gemini-flash-lite-latest")) {
    // Google's current docs do not identify the latest alias target. Retain the
    // earlier 2.5 fallback; response modelVersion pricing takes precedence.
    return GEMINI_2_5_FLASH_LITE_PRICING;
  }
  if (modelId.includes("gemini-3-flash-preview")) {
    return GEMINI_3_FLASH_PREVIEW_PRICING;
  }
  if (modelId.includes("gemini-2.5-flash")) {
    return GEMINI_2_5_FLASH_PRICING;
  }
  if (modelId.includes("gemini-3-pro") || modelId.includes("gemini-3.1-pro")) {
    return GEMINI_3_PRO_PREVIEW_PRICING;
  }
  return undefined;
}

export function getGeminiImagePricing(modelId: string): GeminiImagePricing | undefined {
  if (modelId.includes("gemini-3.1-flash-image-preview")) {
    return GEMINI_3_1_FLASH_IMAGE_PREVIEW_PRICING;
  }
  if (modelId.includes("gemini-3-pro-image-preview")) {
    return GEMINI_3_PRO_IMAGE_PREVIEW_PRICING;
  }
  if (modelId.includes("image-preview")) {
    return GEMINI_3_PRO_IMAGE_PREVIEW_PRICING;
  }
  return undefined;
}
