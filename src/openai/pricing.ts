export type OpenAiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

// Pricing snapshot (best-effort). For current official pricing, see:
// https://platform.openai.com/docs/pricing
// Keep this conservative: unknown models -> cost 0.
const OPENAI_GPT_52_PRICING: OpenAiPricing = {
  inputRate: 1.75 / 1_000_000,
  cachedRate: 0.175 / 1_000_000,
  outputRate: 14 / 1_000_000,
};

// https://platform.openai.com/docs/models/gpt-5-codex
// gpt-5.3-codex is treated as the same family for now.
const OPENAI_GPT_53_CODEX_PRICING: OpenAiPricing = {
  inputRate: 1.25 / 1_000_000,
  cachedRate: 0.125 / 1_000_000,
  outputRate: 10 / 1_000_000,
};

const OPENAI_GPT_51_CODEX_MINI_PRICING: OpenAiPricing = {
  inputRate: 0.25 / 1_000_000,
  cachedRate: 0.025 / 1_000_000,
  outputRate: 2.0 / 1_000_000,
};

export function getOpenAiPricing(modelId: string): OpenAiPricing | undefined {
  if (modelId.includes("gpt-5.3-codex")) {
    return OPENAI_GPT_53_CODEX_PRICING;
  }
  if (modelId.includes("gpt-5-codex")) {
    return OPENAI_GPT_53_CODEX_PRICING;
  }
  if (modelId.includes("gpt-5.2")) {
    return OPENAI_GPT_52_PRICING;
  }
  if (modelId.includes("gpt-5.1-codex-mini")) {
    return OPENAI_GPT_51_CODEX_MINI_PRICING;
  }
  return undefined;
}
