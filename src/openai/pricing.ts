export type OpenAiPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly outputRate: number;
};

// Pricing from the Spark repo (best-effort snapshot).
// Keep this conservative: unknown models -> cost 0.
const OPENAI_GPT_52_PRICING: OpenAiPricing = {
  inputRate: 1.75 / 1_000_000,
  cachedRate: 0.175 / 1_000_000,
  outputRate: 14 / 1_000_000,
};

const OPENAI_GPT_51_CODEX_MINI_PRICING: OpenAiPricing = {
  inputRate: 0.25 / 1_000_000,
  cachedRate: 0.025 / 1_000_000,
  outputRate: 2.0 / 1_000_000,
};

export function getOpenAiPricing(modelId: string): OpenAiPricing | undefined {
  if (modelId.includes("gpt-5.2")) {
    return OPENAI_GPT_52_PRICING;
  }
  if (modelId.includes("gpt-5.1-codex-mini")) {
    return OPENAI_GPT_51_CODEX_MINI_PRICING;
  }
  return undefined;
}
