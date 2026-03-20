export type OpenAiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

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
  if (modelId.includes("gpt-5.4-fast")) {
    return OPENAI_GPT_54_PRIORITY_PRICING;
  }
  if (modelId.includes("gpt-5.4-mini")) {
    return OPENAI_GPT_54_MINI_PRICING;
  }
  if (modelId.includes("gpt-5.4-nano")) {
    return OPENAI_GPT_54_NANO_PRICING;
  }
  // gpt-5.3-codex-spark is priced as the GPT-5.4 mini tier in this library.
  if (modelId.includes("gpt-5.3-codex-spark")) {
    return OPENAI_GPT_54_MINI_PRICING;
  }
  if (modelId.includes("gpt-5.4")) {
    return OPENAI_GPT_54_PRICING;
  }
  return undefined;
}
