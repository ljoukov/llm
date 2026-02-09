import { describe, expect, it } from "vitest";

import { estimateCallCostUsd } from "../src/utils/cost.js";

describe("estimateCallCostUsd", () => {
  it("estimates OpenAI costs (known model)", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-5.2",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 0,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // input: 1000 * (1.75/1M) = 0.00175
    // output: 600 * (14/1M) = 0.0084
    expect(cost).toBeCloseTo(0.01015, 8);
  });

  it("estimates Gemini Pro costs (known model, low tier)", () => {
    const cost = estimateCallCostUsd({
      modelId: "gemini-2.5-pro",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 200,
        responseTokens: 300,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 800 * (1.25/1M) = 0.001
    // cached: 200 * (0.125/1M) = 0.000025
    // output: 400 * (10/1M) = 0.004
    expect(cost).toBeCloseTo(0.005025, 8);
  });

  it("estimates Gemini image-preview costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gemini-3-pro-image-preview",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 0,
        responseTokens: 2000,
        responseImageTokens: 0,
      },
      responseImages: 1,
      imageSize: "2K",
    });

    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });
});
