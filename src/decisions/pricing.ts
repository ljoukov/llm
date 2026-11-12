import { getOpenAiPricing } from "../openai/pricing.js";
import type { LlmUsageTokens } from "../utils/cost.js";
import type { DecisionProvider } from "./models.js";

/** Decision tariffs are independent of text generation; output is not billed. */
export function estimateDecisionCostUsd(
  provider: DecisionProvider,
  usage?: LlmUsageTokens,
): number | null {
  const prompt = usage?.promptTokens;
  if (prompt === undefined || !Number.isFinite(prompt) || prompt < 0) return null;
  const cached = usage?.cachedTokens ?? 0;
  const written = usage?.cacheWriteTokens ?? 0;
  if (cached < 0 || written < 0 || cached + written > prompt) return null;
  const inputRate = (provider === "openai" || provider === "google" ? 0.1 : 0.042) / 1_000_000;
  if (provider === "google" || provider === "typesafe") {
    return cached || written ? null : prompt * inputRate;
  }
  if (provider === "fireworks") {
    return written ? null : (prompt - cached) * inputRate + cached * (0.0084 / 1_000_000);
  }
  const pricing = getOpenAiPricing("gpt-6-luna");
  if (!pricing || (written > 0 && pricing.cacheWriteRate === undefined)) return null;
  const multiplier =
    pricing.longInput && prompt > pricing.longInput.threshold
      ? pricing.longInput.inputMultiplier
      : 1;
  return (
    ((prompt - cached - written) * inputRate +
      cached * pricing.cachedRate +
      written * (pricing.cacheWriteRate ?? inputRate)) *
    multiplier
  );
}
