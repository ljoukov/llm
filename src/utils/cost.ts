import { getAnthropicPricing } from "../anthropic/pricing.js";
import { getFireworksPricing } from "../fireworks/pricing.js";
import { getGeminiImagePricing, getGeminiProPricing } from "../google/pricing.js";
import {
  getOpenAiImagePricing,
  getOpenAiPricing,
  type OpenAiImagePriceResolution,
  type OpenAiImagePricing,
} from "../openai/pricing.js";

export type LlmUsageTokens = {
  readonly promptTokens?: number;
  readonly promptTextTokens?: number;
  readonly promptImageTokens?: number;
  readonly cachedTokens?: number;
  /** Prompt tokens written to cache, only when reported by the provider. */
  readonly cacheWriteTokens?: number;
  /** Anthropic cache-write tokens with a five-minute TTL, included in cacheWriteTokens. */
  readonly anthropicCacheCreation5mInputTokens?: number;
  /** Anthropic cache-write tokens with a one-hour TTL, included in cacheWriteTokens. */
  readonly anthropicCacheCreation1hInputTokens?: number;
  readonly responseTokens?: number;
  readonly responseTextTokens?: number;
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
  pricingModelId,
  tokens,
  responseImages,
  imageSize,
  imageQuality,
}: {
  modelId: string;
  pricingModelId?: string;
  tokens: LlmUsageTokens | undefined;
  responseImages: number;
  imageSize?: string;
  imageQuality?: string;
}): number {
  const pricingModelIds = resolvePricingModelIds(modelId, pricingModelId);
  const openAiImagePricing = resolvePricing(pricingModelIds, getOpenAiImagePricing);
  if (openAiImagePricing) {
    return estimateOpenAiImageCostUsd({
      pricing: openAiImagePricing,
      tokens,
      responseImages,
      imageSize,
      imageQuality,
    });
  }

  const imagePreviewPricing = resolvePricing(pricingModelIds, getGeminiImagePricing);
  if (imagePreviewPricing) {
    const promptTokenTotal =
      resolveUsageNumber(tokens?.promptTokens) + resolveUsageNumber(tokens?.toolUsePromptTokens);
    const cachedTokens = resolveUsageNumber(tokens?.cachedTokens);
    const nonCachedPrompt = Math.max(0, promptTokenTotal - cachedTokens);
    const responseTokens = resolveUsageNumber(tokens?.responseTokens);
    const responseImageTokens = resolveUsageNumber(tokens?.responseImageTokens);
    const thinkingTokens = resolveUsageNumber(tokens?.thinkingTokens);
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

  if (!tokens) {
    return 0;
  }
  const promptTokens = resolveUsageNumber(tokens.promptTokens);
  const cachedTokens = resolveUsageNumber(tokens.cachedTokens);
  const responseTokens = resolveUsageNumber(tokens.responseTokens);
  const thinkingTokens = resolveUsageNumber(tokens.thinkingTokens);
  const toolUsePromptTokens = resolveUsageNumber(tokens.toolUsePromptTokens);
  const promptTokenTotal = promptTokens + toolUsePromptTokens;
  const nonCachedPrompt = Math.max(0, promptTokenTotal - cachedTokens);

  const anthropicPricing = resolvePricing(pricingModelIds, (id) =>
    getAnthropicPricing(id, promptTokenTotal),
  );
  if (anthropicPricing) {
    const cacheReadTokens = Math.min(promptTokenTotal, cachedTokens);
    const cacheWrite1hTokens = resolveUsageNumber(tokens.anthropicCacheCreation1hInputTokens);
    const cacheWrite5mTokens = resolveUsageNumber(tokens.anthropicCacheCreation5mInputTokens);
    const cacheWriteTokens = Math.min(
      nonCachedPrompt,
      Math.max(
        resolveUsageNumber(tokens.cacheWriteTokens),
        cacheWrite5mTokens + cacheWrite1hTokens,
      ),
    );
    const billedCacheWrite1hTokens = Math.min(cacheWriteTokens, cacheWrite1hTokens);
    // If the provider omits the TTL breakdown, cache writes use the default five-minute TTL.
    const billedCacheWrite5mTokens = cacheWriteTokens - billedCacheWrite1hTokens;
    const inputCost = (nonCachedPrompt - cacheWriteTokens) * anthropicPricing.inputRate;
    const cacheReadCost = cacheReadTokens * anthropicPricing.cachedRate;
    const cacheWriteCost =
      billedCacheWrite5mTokens * anthropicPricing.cacheWrite5mRate +
      billedCacheWrite1hTokens * anthropicPricing.cacheWrite1hRate;
    // Anthropic output_tokens already includes thinking; do not charge it a second time.
    return (
      inputCost + cacheReadCost + cacheWriteCost + responseTokens * anthropicPricing.outputRate
    );
  }

  const geminiPricing = resolvePricing(pricingModelIds, getGeminiProPricing);
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

  const fireworksPricing = resolvePricing(pricingModelIds, getFireworksPricing);
  if (fireworksPricing) {
    const inputCost = nonCachedPrompt * fireworksPricing.inputRate;
    const cachedCost = cachedTokens * fireworksPricing.cachedRate;
    const outputTokens = responseTokens + thinkingTokens;
    const outputCost = outputTokens * fireworksPricing.outputRate;
    return inputCost + cachedCost + outputCost;
  }

  const openAiPricing = resolvePricing(pricingModelIds, getOpenAiPricing);
  if (openAiPricing) {
    const cacheWriteTokens = Math.min(nonCachedPrompt, resolveUsageNumber(tokens.cacheWriteTokens));
    const longInput = openAiPricing.longInput;
    const useLongInput = longInput && promptTokenTotal > longInput.threshold;
    const inputMultiplier = useLongInput ? longInput.inputMultiplier : 1;
    const outputMultiplier = useLongInput ? longInput.outputMultiplier : 1;
    const inputCost = (nonCachedPrompt - cacheWriteTokens) * openAiPricing.inputRate;
    const cachedCost = cachedTokens * openAiPricing.cachedRate;
    const cacheWriteCost =
      cacheWriteTokens * (openAiPricing.cacheWriteRate ?? openAiPricing.inputRate);
    const outputTokens = responseTokens + thinkingTokens;
    const outputCost = outputTokens * openAiPricing.outputRate * outputMultiplier;
    return (inputCost + cachedCost + cacheWriteCost) * inputMultiplier + outputCost;
  }

  return 0;
}

function resolvePricingModelIds(modelId: string, pricingModelId: string | undefined): string[] {
  if (pricingModelId && pricingModelId !== modelId) {
    // Latest Gemini aliases change targets; a known concrete response version
    // gives a better rate than the alias's last documented fallback.
    if (pricingModelId === "gemini-flash-latest" || pricingModelId === "gemini-flash-lite-latest") {
      return [modelId, pricingModelId];
    }
    return [pricingModelId, modelId];
  }
  return [modelId];
}

function resolvePricing<T>(
  modelIds: readonly string[],
  resolve: (modelId: string) => T | undefined,
): T | undefined {
  for (const modelId of modelIds) {
    const pricing = resolve(modelId);
    if (pricing) {
      return pricing;
    }
  }
  return undefined;
}

function estimateOpenAiImageCostUsd({
  pricing,
  tokens,
  responseImages,
  imageSize,
  imageQuality,
}: {
  pricing: OpenAiImagePricing;
  tokens: LlmUsageTokens | undefined;
  responseImages: number;
  imageSize?: string;
  imageQuality?: string;
}): number {
  const inputImages = resolveUsageNumber(tokens?.promptImageTokens);
  const inputText =
    tokens?.promptTextTokens !== undefined
      ? resolveUsageNumber(tokens.promptTextTokens)
      : Math.max(0, resolveUsageNumber(tokens?.promptTokens) - inputImages);
  // Direct Images API requests do not receive the Responses API cache discount.
  const inputCost = inputText * pricing.inputTextRate + inputImages * pricing.inputImageRate;
  const outputImageTokens =
    tokens?.responseImageTokens ??
    (tokens?.responseTokens !== undefined
      ? Math.max(
          0,
          resolveUsageNumber(tokens.responseTokens) - resolveUsageNumber(tokens.responseTextTokens),
        )
      : undefined);
  if (outputImageTokens !== undefined) {
    return inputCost + resolveUsageNumber(outputImageTokens) * pricing.outputImageRate;
  }
  const quality =
    imageQuality === "low" || imageQuality === "medium" || imageQuality === "high"
      ? imageQuality
      : pricing.defaultQuality;
  const resolution = resolveOpenAiImagePriceResolution(imageSize) ?? pricing.defaultResolution;
  return inputCost + Math.max(0, responseImages) * pricing.imagePrices[quality][resolution];
}

function resolveOpenAiImagePriceResolution(
  imageSize: string | undefined,
): OpenAiImagePriceResolution | undefined {
  if (imageSize === "1024x1024" || imageSize === "1024x1536" || imageSize === "1536x1024") {
    return imageSize;
  }
  if (!imageSize || imageSize === "auto") {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/.exec(imageSize);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  if (width === height) {
    return "1024x1024";
  }
  return width > height ? "1536x1024" : "1024x1536";
}
