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

  it("estimates ChatGPT codex spark costs (gpt-5.3-codex-spark) at GPT-5 mini rates", () => {
    const cost = estimateCallCostUsd({
      modelId: "chatgpt-gpt-5.3-codex-spark",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (0.25/1M) = 0.000225
    // cached: 100 * (0.025/1M) = 0.0000025
    // output: 600 * (2/1M) = 0.0012
    expect(cost).toBeCloseTo(0.0014275, 8);
  });

  it("estimates Fireworks kimi-k2.5 costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "kimi-k2.5",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (0.60/1M) = 0.00054
    // cached: 100 * (0.10/1M) = 0.00001
    // output: 600 * (3.00/1M) = 0.0018
    expect(cost).toBeCloseTo(0.00235, 8);
  });

  it("estimates Fireworks glm-5 costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "glm-5",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (1.00/1M) = 0.0009
    // cached: 100 * (0.20/1M) = 0.00002
    // output: 600 * (3.20/1M) = 0.00192
    expect(cost).toBeCloseTo(0.00284, 8);
  });

  it("estimates Fireworks minimax-m2.1 costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "minimax-m2.1",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (0.30/1M) = 0.00027
    // cached: 100 * (0.15/1M) = 0.000015
    // output: 600 * (1.20/1M) = 0.00072
    expect(cost).toBeCloseTo(0.001005, 8);
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
