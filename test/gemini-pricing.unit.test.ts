import { afterEach, describe, expect, it, vi } from "vitest";

import { getGeminiProPricing } from "../src/google/pricing.js";
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
