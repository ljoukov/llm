import {
  isChatGptImageModelId,
  isOpenAiImageModelId,
  supportsOpenAiUltrafast,
  type OpenAiGptImage2Quality,
} from "./models.js";
import type { LlmSpeed } from "../model-selection.js";

export type OpenAiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly cacheWriteRate?: number;
  readonly longInput?: {
    readonly threshold: number;
    readonly inputMultiplier: number;
    readonly outputMultiplier: number;
  };
  readonly outputRate: number;
};

export type OpenAiImagePriceResolution = "1024x1024" | "1024x1536" | "1536x1024";

export type OpenAiImagePricing = {
  readonly inputTextRate: number;
  readonly inputImageRate: number;
  readonly outputImageRate: number;
  readonly defaultQuality: Exclude<OpenAiGptImage2Quality, "auto">;
  readonly defaultResolution: OpenAiImagePriceResolution;
  readonly imagePrices: Readonly<
    Record<
      Exclude<OpenAiGptImage2Quality, "auto">,
      Readonly<Record<OpenAiImagePriceResolution, number>>
    >
  >;
};

// Current model rates: https://developers.openai.com/api/docs/pricing
// ChatGPT costs are API-equivalent estimates, not billed subscription charges.
// Retain historical rates for callers estimating the cost of recorded usage.
const TEXT_PRICING: Readonly<Record<string, OpenAiPricing>> = {
  "gpt-6.2-astra": {
    inputRate: 8 / 1_000_000,
    cachedRate: 0.4 / 1_000_000,
    cacheWriteRate: 10 / 1_000_000,
    outputRate: 40 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-6.2-sol": {
    inputRate: 2 / 1_000_000,
    cachedRate: 0.1 / 1_000_000,
    cacheWriteRate: 2.5 / 1_000_000,
    outputRate: 10 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-6.1-terra": {
    inputRate: 1 / 1_000_000,
    cachedRate: 0.05 / 1_000_000,
    cacheWriteRate: 1.25 / 1_000_000,
    outputRate: 5 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-6-astra": {
    inputRate: 10 / 1_000_000,
    cachedRate: 1 / 1_000_000,
    cacheWriteRate: 12.5 / 1_000_000,
    outputRate: 50 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-6.1-sol": {
    inputRate: 2 / 1_000_000,
    cachedRate: 0.1 / 1_000_000,
    cacheWriteRate: 2.5 / 1_000_000,
    outputRate: 10 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-6-sol": {
    inputRate: 2 / 1_000_000,
    cachedRate: 0.2 / 1_000_000,
    cacheWriteRate: 2.5 / 1_000_000,
    outputRate: 10 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-6-luna": {
    inputRate: 0.1 / 1_000_000,
    cachedRate: 0.01 / 1_000_000,
    cacheWriteRate: 0.125 / 1_000_000,
    outputRate: 0.5 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-5.6-sol": {
    inputRate: 4 / 1_000_000,
    cachedRate: 0.4 / 1_000_000,
    cacheWriteRate: 5 / 1_000_000,
    outputRate: 20 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-5.6-terra": {
    inputRate: 2 / 1_000_000,
    cachedRate: 0.2 / 1_000_000,
    cacheWriteRate: 2.5 / 1_000_000,
    outputRate: 12 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  "gpt-5.6-luna": {
    inputRate: 0.2 / 1_000_000,
    cachedRate: 0.02 / 1_000_000,
    cacheWriteRate: 0.25 / 1_000_000,
    outputRate: 1.2 / 1_000_000,
    longInput: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
};

const GPT_6_2_ULTRAFAST_PROMO_END = Date.parse("2027-03-01T00:00:00-08:00");

const OPENAI_GPT_IMAGE_2_PRICING: OpenAiImagePricing = {
  inputTextRate: 5 / 1_000_000,
  inputImageRate: 8 / 1_000_000,
  outputImageRate: 30 / 1_000_000,
  defaultQuality: "medium",
  defaultResolution: "1024x1024",
  imagePrices: {
    low: {
      "1024x1024": 0.006,
      "1024x1536": 0.005,
      "1536x1024": 0.005,
    },
    medium: {
      "1024x1024": 0.053,
      "1024x1536": 0.041,
      "1536x1024": 0.041,
    },
    high: {
      "1024x1024": 0.211,
      "1024x1536": 0.165,
      "1536x1024": 0.165,
    },
  },
};

export function getOpenAiPricing(
  modelId: string,
  speed: LlmSpeed = "standard",
): OpenAiPricing | undefined {
  let normalized = modelId.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  if (normalized === "gpt-5.6") normalized = "gpt-5.6-sol";
  const standard = Object.hasOwn(TEXT_PRICING, normalized) ? TEXT_PRICING[normalized] : undefined;
  if (!standard) return undefined;
  if (speed === "standard") return standard;
  let multiplier: number;
  if (speed === "fast") {
    multiplier = 2;
  } else if (speed === "ultrafast" && supportsOpenAiUltrafast(normalized)) {
    multiplier = Date.now() < GPT_6_2_ULTRAFAST_PROMO_END ? 3 : 6;
  } else if (
    speed === "ultrafast" &&
    (normalized === "gpt-6-astra" || normalized === "gpt-6.1-sol")
  ) {
    multiplier = 6;
  } else {
    return undefined;
  }
  return {
    ...standard,
    inputRate: standard.inputRate * multiplier,
    cachedRate: standard.cachedRate * multiplier,
    cacheWriteRate:
      standard.cacheWriteRate === undefined ? undefined : standard.cacheWriteRate * multiplier,
    outputRate: standard.outputRate * multiplier,
  };
}

export function getOpenAiImagePricing(modelId: string): OpenAiImagePricing | undefined {
  return isOpenAiImageModelId(modelId) || isChatGptImageModelId(modelId)
    ? OPENAI_GPT_IMAGE_2_PRICING
    : undefined;
}
