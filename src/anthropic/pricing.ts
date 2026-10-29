import { isAnthropicModelId, type AnthropicModelId } from "./models.js";
import type { LlmSpeed } from "../model-selection.js";

export type AnthropicPricing = {
  readonly inputRate: number;
  readonly cachedRate: number;
  readonly cacheWrite5mRate: number;
  readonly cacheWrite1hRate: number;
  readonly outputRate: number;
};

// Official standard, global Claude API pricing snapshot, 2026-10-22 (USD/token):
// https://platform.claude.com/docs/en/about-claude/pricing
// Haiku's prompt-length threshold includes normal input, cache reads, and cache writes.
const ANTHROPIC_PRICING: Readonly<Record<AnthropicModelId, AnthropicPricing>> = {
  "claude-haiku-5-5": {
    inputRate: 0.1 / 1_000_000,
    cachedRate: 0.01 / 1_000_000,
    cacheWrite5mRate: 0.125 / 1_000_000,
    cacheWrite1hRate: 0.2 / 1_000_000,
    outputRate: 0.5 / 1_000_000,
  },
  "claude-sonnet-5-5": {
    inputRate: 2 / 1_000_000,
    cachedRate: 0.1 / 1_000_000,
    cacheWrite5mRate: 2.5 / 1_000_000,
    cacheWrite1hRate: 4 / 1_000_000,
    outputRate: 10 / 1_000_000,
  },
  "claude-opus-5-5": {
    inputRate: 4 / 1_000_000,
    cachedRate: 0.2 / 1_000_000,
    cacheWrite5mRate: 5 / 1_000_000,
    cacheWrite1hRate: 8 / 1_000_000,
    outputRate: 20 / 1_000_000,
  },
  "claude-fable-5-1": {
    inputRate: 10 / 1_000_000,
    cachedRate: 0.25 / 1_000_000,
    cacheWrite5mRate: 12.5 / 1_000_000,
    cacheWrite1hRate: 20 / 1_000_000,
    outputRate: 50 / 1_000_000,
  },
};

const HAIKU_LONG_CONTEXT_PRICING: AnthropicPricing = {
  inputRate: 0.5 / 1_000_000,
  cachedRate: 0.05 / 1_000_000,
  cacheWrite5mRate: 0.625 / 1_000_000,
  cacheWrite1hRate: 1 / 1_000_000,
  outputRate: 2.5 / 1_000_000,
};

export function getAnthropicPricing(
  modelId: string,
  promptTokens = 0,
  speed: LlmSpeed = "standard",
): AnthropicPricing | undefined {
  // Subscription calls and native response model IDs use the same API-equivalent estimate.
  // This is a token-value estimate, not a charge against the Claude subscription.
  if (!isAnthropicModelId(modelId)) {
    return undefined;
  }
  if (speed !== "standard") {
    if (speed !== "fast" || modelId !== "claude-opus-5-5") return undefined;
    // Official fast-mode snapshot, 2026-10-29: $8/$40 input/output per MTok;
    // prompt-caching multipliers apply on top of these fast rates.
    // https://platform.claude.com/docs/en/build-with-claude/fast-mode#pricing
    const standard = ANTHROPIC_PRICING[modelId];
    return {
      inputRate: standard.inputRate * 2,
      cachedRate: standard.cachedRate * 2,
      cacheWrite5mRate: standard.cacheWrite5mRate * 2,
      cacheWrite1hRate: standard.cacheWrite1hRate * 2,
      outputRate: standard.outputRate * 2,
    };
  }
  if (modelId === "claude-haiku-5-5" && promptTokens > 100_000) {
    return HAIKU_LONG_CONTEXT_PRICING;
  }
  return ANTHROPIC_PRICING[modelId];
}
