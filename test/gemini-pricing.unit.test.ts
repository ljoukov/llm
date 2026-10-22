import { afterEach, describe, expect, it, vi } from "vitest";

import { GEMINI_IMAGE_MODEL_IDS, GEMINI_TEXT_MODEL_IDS } from "../src/google/client.js";
import { getGeminiImagePricing, getGeminiProPricing } from "../src/google/pricing.js";
import { estimateCallCostUsd } from "../src/utils/cost.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Gemini scheduled Standard pricing", () => {
  it.each([
    ["gemini-4-argon", "2026-11-30T23:59:59.999Z", 2, 10, 0.1],
    ["gemini-4-argon", "2026-12-01T00:00:00.000Z", 4, 20, 0.2],
    ["gemini-3.8-flash", "2026-12-31T23:59:59.999Z", 0.75, 3.75, 0.075],
    ["gemini-3.8-flash", "2027-01-01T00:00:00.000Z", 1.5, 7.5, 0.15],
    ["gemini-3.6-flash", "2026-12-31T23:59:59.999Z", 0.75, 3.75, 0.075],
    ["gemini-3.6-flash", "2027-01-01T00:00:00.000Z", 1.5, 7.5, 0.15],
  ] as const)("prices %s at %s", (modelId, at, input, output, cached) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));

    expect(getGeminiProPricing(modelId)).toEqual({
      threshold: Number.POSITIVE_INFINITY,
      inputRateLow: input / 1_000_000,
      inputRateHigh: input / 1_000_000,
      cachedRateLow: cached / 1_000_000,
      cachedRateHigh: cached / 1_000_000,
      outputRateLow: output / 1_000_000,
      outputRateHigh: output / 1_000_000,
    });
  });

  it.each([
    ["gemini-4-argon", 2, 10, 0.1],
    ["gemini-3.8-flash", 0.75, 3.75, 0.075],
  ] as const)("charges %s for cached input and thinking without a long-context surcharge", (modelId, input, output, cached) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));

    expect(
      estimateCallCostUsd({
        modelId,
        tokens: {
          promptTokens: 1_000_000,
          cachedTokens: 200_000,
          responseTokens: 100_000,
          thinkingTokens: 50_000,
        },
        responseImages: 0,
      }),
    ).toBeCloseTo(0.8 * input + 0.2 * cached + 0.15 * output);
  });
});

describe("Gemini pricing coverage", () => {
  it.each(
    GEMINI_TEXT_MODEL_IDS,
  )("has positive token rates for supported text model %s", (modelId) => {
    const pricing = getGeminiProPricing(modelId);
    expect(pricing).toBeDefined();
    expect(pricing?.inputRateLow).toBeGreaterThan(0);
    expect(pricing?.cachedRateLow).toBeGreaterThan(0);
    expect(pricing?.outputRateLow).toBeGreaterThan(0);
  });

  it.each(GEMINI_IMAGE_MODEL_IDS)("has image rates for supported image model %s", (modelId) => {
    const pricing = getGeminiImagePricing(modelId);
    expect(pricing).toBeDefined();
    expect(pricing?.inputRate).toBeGreaterThan(0);
    expect(pricing?.outputImageRate).toBeGreaterThan(0);
    expect(Object.values(pricing?.imagePrices ?? {}).every((rate) => rate > 0)).toBe(true);
  });

  it.each([
    ["gemini-3-flash-preview", 0.5, 3, 0.05],
    ["gemini-3.5-flash", 1.5, 9, 0.15],
    ["gemini-flash-latest", 1.5, 9, 0.15],
    ["gemini-3.5-flash-lite", 0.3, 2.5, 0.03],
    ["gemini-2.5-flash-lite", 0.1, 0.4, 0.01],
    ["gemini-flash-lite-latest", 0.1, 0.4, 0.01],
  ] as const)("prices the distinct text model %s", (modelId, input, output, cached) => {
    const pricing = getGeminiProPricing(modelId);
    expect(pricing?.inputRateLow).toBe(input / 1_000_000);
    expect(pricing?.outputRateLow).toBe(output / 1_000_000);
    expect(pricing?.cachedRateLow).toBe(cached / 1_000_000);
  });

  it.each([
    ["gemini-3-pro-image-preview", "1K", 1120, 120],
    ["gemini-3-pro-image-preview", "2K", 1120, 120],
    ["gemini-3-pro-image-preview", "4K", 2000, 120],
    ["gemini-3.1-flash-image-preview", "512", 747, 60],
    ["gemini-3.1-flash-image-preview", "1K", 1120, 60],
    ["gemini-3.1-flash-image-preview", "2K", 1680, 60],
    ["gemini-3.1-flash-image-preview", "4K", 2520, 60],
  ] as const)("prices %s %s image fallback from image tokens", (modelId, size, imageTokens, rate) => {
    const pricing = getGeminiImagePricing(modelId);
    const imageCost = (imageTokens * rate) / 1_000_000;
    expect(pricing?.imagePrices[size]).toBe(imageCost);
    expect(
      estimateCallCostUsd({ modelId, tokens: {}, responseImages: 1, imageSize: size }),
    ).toBeCloseTo(imageCost, 12);
  });

  it("charges Flash Image cached input at the discounted token rate", () => {
    expect(
      estimateCallCostUsd({
        modelId: "gemini-3.1-flash-image-preview",
        tokens: { promptTokens: 1_000_000, cachedTokens: 1_000_000 },
        responseImages: 0,
      }),
    ).toBeCloseTo(0.05, 12);
  });
});
