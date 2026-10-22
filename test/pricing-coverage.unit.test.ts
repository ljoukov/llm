import { describe, expect, it } from "vitest";

import { ANTHROPIC_MODEL_IDS } from "../src/anthropic/models.js";
import { getAnthropicPricing } from "../src/anthropic/pricing.js";
import { CLAUDE_MODEL_IDS } from "../src/claude/models.js";
import { FIREWORKS_MODEL_IDS, resolveFireworksModelId } from "../src/fireworks/models.js";
import { getFireworksPricing } from "../src/fireworks/pricing.js";
import { GEMINI_IMAGE_MODEL_IDS, GEMINI_TEXT_MODEL_IDS } from "../src/google/client.js";
import { getGeminiImagePricing, getGeminiProPricing } from "../src/google/pricing.js";
import { LLM_IMAGE_MODEL_IDS, LLM_MODEL_IDS, LLM_TEXT_MODEL_IDS } from "../src/llm.js";
import {
  CHATGPT_IMAGE_MODEL_IDS,
  CHATGPT_MODEL_IDS,
  OPENAI_IMAGE_MODEL_IDS,
  OPENAI_MODEL_IDS,
} from "../src/openai/models.js";
import { getOpenAiImagePricing, getOpenAiPricing } from "../src/openai/pricing.js";
import { estimateCallCostUsd } from "../src/utils/cost.js";

function expectPositiveRates(rates: readonly (number | undefined)[]): void {
  for (const rate of rates) {
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThan(0);
  }
}

describe("supported model pricing coverage", () => {
  it("accounts for the complete enumerated catalogue without duplicate IDs", () => {
    expect(LLM_TEXT_MODEL_IDS).toHaveLength(48);
    expect(LLM_IMAGE_MODEL_IDS).toHaveLength(4);
    expect(new Set(LLM_MODEL_IDS).size).toBe(52);
  });

  it.each(
    LLM_TEXT_MODEL_IDS,
  )("prices %s input, output, and cached input independently", (modelId) => {
    const input = estimateCallCostUsd({
      modelId,
      tokens: { promptTokens: 1_000 },
      responseImages: 0,
    });
    const output = estimateCallCostUsd({
      modelId,
      tokens: { responseTokens: 1_000 },
      responseImages: 0,
    });
    const cached = estimateCallCostUsd({
      modelId,
      tokens: { promptTokens: 1_000, cachedTokens: 1_000 },
      responseImages: 0,
    });
    expectPositiveRates([input, output, cached]);
    expect(cached).toBeLessThan(input);
    expect(
      estimateCallCostUsd({
        modelId: "unrecognized-provider-response-version",
        pricingModelId: modelId,
        tokens: { promptTokens: 1_000 },
        responseImages: 0,
      }),
    ).toBe(input);
  });

  it.each([
    ...OPENAI_MODEL_IDS,
    ...CHATGPT_MODEL_IDS,
  ])("has complete OpenAI rates for %s", (modelId) => {
    const pricing = getOpenAiPricing(modelId);
    expectPositiveRates([
      pricing?.inputRate,
      pricing?.cachedRate,
      pricing?.cacheWriteRate,
      pricing?.outputRate,
    ]);
  });

  it.each([
    ...ANTHROPIC_MODEL_IDS,
    ...CLAUDE_MODEL_IDS,
  ])("has complete Claude rates for %s", (modelId) => {
    const pricing = getAnthropicPricing(modelId);
    expectPositiveRates([
      pricing?.inputRate,
      pricing?.cachedRate,
      pricing?.cacheWrite5mRate,
      pricing?.cacheWrite1hRate,
      pricing?.outputRate,
    ]);
  });

  it.each(
    FIREWORKS_MODEL_IDS,
  )("has complete Fireworks rates and native lookup for %s", (modelId) => {
    const pricing = getFireworksPricing(modelId);
    expectPositiveRates([pricing?.inputRate, pricing?.cachedRate, pricing?.outputRate]);
    expect(getFireworksPricing(resolveFireworksModelId(modelId) ?? "")).toEqual(pricing);
  });

  it.each(GEMINI_TEXT_MODEL_IDS)("has complete Gemini context-tier rates for %s", (modelId) => {
    const pricing = getGeminiProPricing(modelId);
    expectPositiveRates([
      pricing?.inputRateLow,
      pricing?.inputRateHigh,
      pricing?.cachedRateLow,
      pricing?.cachedRateHigh,
      pricing?.outputRateLow,
      pricing?.outputRateHigh,
    ]);
  });

  it.each([
    ...OPENAI_IMAGE_MODEL_IDS,
    ...CHATGPT_IMAGE_MODEL_IDS,
  ])("has image prices for every quality and size of %s", (modelId) => {
    const pricing = getOpenAiImagePricing(modelId);
    expect(pricing).toBeDefined();
    for (const prices of Object.values(pricing?.imagePrices ?? {})) {
      expectPositiveRates(Object.values(prices));
    }
  });

  it.each(GEMINI_IMAGE_MODEL_IDS)("has Gemini input, text, and image rates for %s", (modelId) => {
    const pricing = getGeminiImagePricing(modelId);
    expectPositiveRates([
      pricing?.inputRate,
      pricing?.cachedRate,
      pricing?.outputTextRate,
      pricing?.outputImageRate,
      ...Object.values(pricing?.imagePrices ?? {}),
    ]);
  });

  it.each(
    LLM_IMAGE_MODEL_IDS,
  )("estimates %s image output even when usage is omitted", (modelId) => {
    const oneImage = estimateCallCostUsd({ modelId, tokens: undefined, responseImages: 1 });
    expectPositiveRates([oneImage]);
    expect(estimateCallCostUsd({ modelId, tokens: undefined, responseImages: 3 })).toBeCloseTo(
      oneImage * 3,
      12,
    );
    expect(estimateCallCostUsd({ modelId, tokens: undefined, responseImages: 0 })).toBe(0);
  });

  it.each([
    ["gemini-3-pro-image-preview", "1K", 0.1344],
    ["gemini-3-pro-image-preview", "2K", 0.1344],
    ["gemini-3-pro-image-preview", "4K", 0.24],
    ["gemini-3.1-flash-image-preview", "512", 0.04482],
    ["gemini-3.1-flash-image-preview", "1K", 0.0672],
    ["gemini-3.1-flash-image-preview", "2K", 0.1008],
    ["gemini-3.1-flash-image-preview", "4K", 0.1512],
  ] as const)("estimates three %s %s images without token usage", (modelId, imageSize, unitPrice) => {
    expect(
      estimateCallCostUsd({ modelId, tokens: undefined, responseImages: 3, imageSize }),
    ).toBeCloseTo(unitPrice * 3, 12);
  });

  it.each([
    "unlisted-model",
    "experimental-chatgpt-private-model",
    "__proto__",
    "constructor",
  ])("does not fabricate a rate for %s", (modelId) => {
    expect(
      estimateCallCostUsd({
        modelId,
        tokens: { promptTokens: 1_000, responseTokens: 1_000 },
        responseImages: 1,
      }),
    ).toBe(0);
  });
});
