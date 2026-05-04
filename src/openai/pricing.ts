import {
  isChatGptImageModelId,
  isExperimentalChatGptModelId,
  isOpenAiImageModelId,
  type OpenAiGptImage2Quality,
} from "./models.js";

export type OpenAiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

export type OpenAiImagePriceResolution = "1024x1024" | "1024x1536" | "1536x1024";

export type OpenAiImagePricing = {
  readonly defaultQuality: Exclude<OpenAiGptImage2Quality, "auto">;
  readonly defaultResolution: OpenAiImagePriceResolution;
  readonly imagePrices: Readonly<
    Record<
      Exclude<OpenAiGptImage2Quality, "auto">,
      Readonly<Record<OpenAiImagePriceResolution, number>>
    >
  >;
};

const OPENAI_GPT_55_FAST_MODEL_IDS = ["gpt-5.5-fast", "chatgpt-gpt-5.5-fast"] as const;
const OPENAI_GPT_55_STANDARD_MODEL_IDS = ["gpt-5.5", "chatgpt-gpt-5.5"] as const;
const OPENAI_GPT_54_FAST_MODEL_IDS = ["gpt-5.4-fast", "chatgpt-gpt-5.4-fast"] as const;
const OPENAI_GPT_54_MINI_MODEL_IDS = ["gpt-5.4-mini", "chatgpt-gpt-5.4-mini"] as const;
const OPENAI_GPT_54_NANO_MODEL_IDS = ["gpt-5.4-nano"] as const;
const OPENAI_GPT_53_CODEX_SPARK_MODEL_IDS = [
  "gpt-5.3-codex-spark",
  "chatgpt-gpt-5.3-codex-spark",
] as const;
const OPENAI_GPT_54_STANDARD_MODEL_IDS = ["gpt-5.4", "chatgpt-gpt-5.4"] as const;

// Pricing snapshot (best-effort). For current official pricing, see:
// https://platform.openai.com/docs/pricing
// Keep this conservative: unknown models -> cost 0.
const OPENAI_GPT_55_PRICING: OpenAiPricing = {
  inputRate: 5 / 1_000_000,
  cachedRate: 0.5 / 1_000_000,
  outputRate: 30 / 1_000_000,
};

const OPENAI_GPT_55_PRIORITY_PRICING: OpenAiPricing = {
  inputRate: 12.5 / 1_000_000,
  cachedRate: 1.25 / 1_000_000,
  outputRate: 75 / 1_000_000,
};

const OPENAI_GPT_54_PRICING: OpenAiPricing = {
  inputRate: 2.5 / 1_000_000,
  cachedRate: 0.25 / 1_000_000,
  outputRate: 15 / 1_000_000,
};

const OPENAI_GPT_54_PRIORITY_PRICING: OpenAiPricing = {
  inputRate: 5 / 1_000_000,
  cachedRate: 0.5 / 1_000_000,
  outputRate: 30 / 1_000_000,
};

const OPENAI_GPT_54_MINI_PRICING: OpenAiPricing = {
  inputRate: 0.25 / 1_000_000,
  cachedRate: 0.025 / 1_000_000,
  outputRate: 2 / 1_000_000,
};

const OPENAI_GPT_54_NANO_PRICING: OpenAiPricing = {
  inputRate: 0.05 / 1_000_000,
  cachedRate: 0.005 / 1_000_000,
  outputRate: 0.4 / 1_000_000,
};

const OPENAI_GPT_IMAGE_2_PRICING: OpenAiImagePricing = {
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

export function getOpenAiPricing(modelId: string): OpenAiPricing | undefined {
  if (isExperimentalChatGptModelId(modelId)) {
    return OPENAI_GPT_54_PRICING;
  }
  if ((OPENAI_GPT_55_FAST_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_55_PRIORITY_PRICING;
  }
  if ((OPENAI_GPT_55_STANDARD_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_55_PRICING;
  }
  if ((OPENAI_GPT_54_FAST_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_54_PRIORITY_PRICING;
  }
  if ((OPENAI_GPT_54_MINI_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_54_MINI_PRICING;
  }
  if ((OPENAI_GPT_54_NANO_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_54_NANO_PRICING;
  }
  // gpt-5.3-codex-spark is priced as the GPT-5.4 mini tier in this library.
  if ((OPENAI_GPT_53_CODEX_SPARK_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_54_MINI_PRICING;
  }
  if ((OPENAI_GPT_54_STANDARD_MODEL_IDS as readonly string[]).includes(modelId)) {
    return OPENAI_GPT_54_PRICING;
  }
  return undefined;
}

export function getOpenAiImagePricing(modelId: string): OpenAiImagePricing | undefined {
  return isOpenAiImageModelId(modelId) || isChatGptImageModelId(modelId)
    ? OPENAI_GPT_IMAGE_2_PRICING
    : undefined;
}
