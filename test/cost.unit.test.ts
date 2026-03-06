import { describe, expect, it } from "vitest";

import { LLM_MODEL_IDS } from "../src/index.js";
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

  it("estimates GPT-5.4 costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-5.4",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (2.5/1M) = 0.00225
    // cached: 100 * (0.25/1M) = 0.000025
    // output: 600 * (15/1M) = 0.009
    expect(cost).toBeCloseTo(0.011275, 8);
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

  it("prices chatgpt-gpt-5.4-fast at GPT-5.4 priority rates", () => {
    const cost = estimateCallCostUsd({
      modelId: "chatgpt-gpt-5.4-fast",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (5/1M) = 0.0045
    // cached: 100 * (0.5/1M) = 0.00005
    // output: 600 * (30/1M) = 0.018
    expect(cost).toBeCloseTo(0.02255, 8);
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
    // cached: 100 * (0.03/1M) = 0.000003
    // output: 600 * (1.20/1M) = 0.00072
    expect(cost).toBeCloseTo(0.000993, 8);
  });

  it("estimates Fireworks gpt-oss-120b costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-oss-120b",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (0.15/1M) = 0.000135
    // cached: 100 * (0.075/1M) = 0.0000075
    // output: 600 * (0.60/1M) = 0.00036
    expect(cost).toBeCloseTo(0.0005025, 8);
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

  it("estimates Gemini 2.5 Flash costs (including gemini-flash-latest alias)", () => {
    const modelIds = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-3-flash-preview"] as const;
    for (const modelId of modelIds) {
      const cost = estimateCallCostUsd({
        modelId,
        tokens: {
          promptTokens: 1000,
          cachedTokens: 200,
          responseTokens: 300,
          thinkingTokens: 100,
        },
        responseImages: 0,
      });

      // non-cached prompt: 800 * (0.30/1M) = 0.00024
      // cached: 200 * (0.03/1M) = 0.000006
      // output: 400 * (2.5/1M) = 0.001
      expect(cost).toBeCloseTo(0.001246, 8);
    }
  });

  it("estimates Gemini Flash Lite costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gemini-flash-lite-latest",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 200,
        responseTokens: 300,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 800 * (0.10/1M) = 0.00008
    // cached: 200 * (0.025/1M) = 0.000005
    // output: 400 * (0.40/1M) = 0.00016
    expect(cost).toBeCloseTo(0.000245, 8);
  });

  it("estimates Gemini 3.1 Pro preview costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gemini-3.1-pro-preview",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 200,
        responseTokens: 300,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 800 * (2/1M) = 0.0016
    // cached: 200 * (0.2/1M) = 0.00004
    // output: 400 * (12/1M) = 0.0048
    expect(cost).toBeCloseTo(0.00644, 8);
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

  it("estimates Gemini 3.1 Flash image-preview costs lower than Gemini 3 Pro image-preview", () => {
    const tokens = {
      promptTokens: 1000,
      cachedTokens: 0,
      responseTokens: 2000,
      responseImageTokens: 0,
    };

    const flashCost = estimateCallCostUsd({
      modelId: "gemini-3.1-flash-image-preview",
      tokens,
      responseImages: 1,
      imageSize: "2K",
    });

    const proCost = estimateCallCostUsd({
      modelId: "gemini-3-pro-image-preview",
      tokens,
      responseImages: 1,
      imageSize: "2K",
    });

    expect(flashCost).toBeGreaterThan(0);
    expect(proCost).toBeGreaterThan(0);
    expect(flashCost).toBeLessThan(proCost);
  });

  it("has non-zero pricing coverage for all supported model ids", () => {
    const tokens = {
      promptTokens: 1000,
      cachedTokens: 100,
      responseTokens: 500,
      thinkingTokens: 100,
      responseImageTokens: 0,
    };

    for (const modelId of LLM_MODEL_IDS) {
      const responseImages = modelId.includes("image-preview") ? 1 : 0;
      const cost = estimateCallCostUsd({ modelId, tokens, responseImages, imageSize: "2K" });
      expect(cost, `expected non-zero cost mapping for ${modelId}`).toBeGreaterThan(0);
    }
  });
});
