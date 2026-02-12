import { getFireworksPricing } from "../fireworks/pricing.js";
import { getGeminiImagePricing, getGeminiProPricing } from "../google/pricing.js";
import { getOpenAiPricing } from "../openai/pricing.js";

export type LlmUsageTokens = {
  readonly promptTokens?: number;
  readonly cachedTokens?: number;
  readonly responseTokens?: number;
  readonly responseImageTokens?: number;
  readonly thinkingTokens?: number;
  readonly totalTokens?: number;
  readonly toolUsePromptTokens?: number;
};

function resolveUsageNumber(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  return 0;
}

export function estimateCallCostUsd({
  modelId,
  tokens,
  responseImages,
  imageSize,
}: {
  modelId: string;
  tokens: LlmUsageTokens | undefined;
  responseImages: number;
  imageSize?: string;
}): number {
  if (!tokens) {
    return 0;
  }
  const promptTokens = resolveUsageNumber(tokens.promptTokens);
  const cachedTokens = resolveUsageNumber(tokens.cachedTokens);
  const responseTokens = resolveUsageNumber(tokens.responseTokens);
  const responseImageTokens = resolveUsageNumber(tokens.responseImageTokens);
  const thinkingTokens = resolveUsageNumber(tokens.thinkingTokens);
  const toolUsePromptTokens = resolveUsageNumber(tokens.toolUsePromptTokens);
  const promptTokenTotal = promptTokens + toolUsePromptTokens;
  const nonCachedPrompt = Math.max(0, promptTokenTotal - cachedTokens);

  const imagePreviewPricing = getGeminiImagePricing(modelId);
  if (imagePreviewPricing) {
    const resolvedImageSize =
      imageSize && imagePreviewPricing.imagePrices[imageSize] ? imageSize : "2K";
    const imageRate = imagePreviewPricing.imagePrices[resolvedImageSize] ?? 0;
    const tokensPerImage =
      imagePreviewPricing.outputImageRate > 0 ? imageRate / imagePreviewPricing.outputImageRate : 0;
    let responseTextForPricing = Math.max(0, responseTokens - responseImageTokens);
    let imageTokensForPricing = responseImageTokens;
    if (imageTokensForPricing <= 0 && responseImages > 0 && tokensPerImage > 0) {
      const estimatedImageTokens = responseImages * tokensPerImage;
      imageTokensForPricing = estimatedImageTokens;
      if (responseTextForPricing >= estimatedImageTokens) {
        responseTextForPricing -= estimatedImageTokens;
      }
    }
    const textOutputCost =
      (responseTextForPricing + thinkingTokens) * imagePreviewPricing.outputTextRate;
    const inputCost = nonCachedPrompt * imagePreviewPricing.inputRate;
    const cachedCost = cachedTokens * imagePreviewPricing.cachedRate;
    const imageOutputCost = imageTokensForPricing * imagePreviewPricing.outputImageRate;
    return inputCost + cachedCost + textOutputCost + imageOutputCost;
  }

  const geminiPricing = getGeminiProPricing(modelId);
  if (geminiPricing) {
    const useHighTier = promptTokenTotal > geminiPricing.threshold;
    const inputRate = useHighTier ? geminiPricing.inputRateHigh : geminiPricing.inputRateLow;
    const cachedRate = useHighTier ? geminiPricing.cachedRateHigh : geminiPricing.cachedRateLow;
    const outputRate = useHighTier ? geminiPricing.outputRateHigh : geminiPricing.outputRateLow;
    const inputCost = nonCachedPrompt * inputRate;
    const cachedCost = cachedTokens * cachedRate;
    const outputTokens = responseTokens + thinkingTokens;
    const outputCost = outputTokens * outputRate;
    return inputCost + cachedCost + outputCost;
  }

  const fireworksPricing = getFireworksPricing(modelId);
  if (fireworksPricing) {
    const inputCost = nonCachedPrompt * fireworksPricing.inputRate;
    const cachedCost = cachedTokens * fireworksPricing.cachedRate;
    const outputTokens = responseTokens + thinkingTokens;
    const outputCost = outputTokens * fireworksPricing.outputRate;
    return inputCost + cachedCost + outputCost;
  }

  const openAiPricing = getOpenAiPricing(modelId);
  if (openAiPricing) {
    const inputCost = nonCachedPrompt * openAiPricing.inputRate;
    const cachedCost = cachedTokens * openAiPricing.cachedRate;
    const outputTokens = responseTokens + thinkingTokens;
    const outputCost = outputTokens * openAiPricing.outputRate;
    return inputCost + cachedCost + outputCost;
  }

  return 0;
}
