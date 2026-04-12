export type OpenAiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

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

export function getOpenAiPricing(modelId: string): OpenAiPricing | undefined {
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
