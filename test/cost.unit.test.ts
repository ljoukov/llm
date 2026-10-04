import { describe, expect, it } from "vitest";

import { isChatGptImageModelId, isOpenAiImageModelId, LLM_MODEL_IDS } from "../src/index.js";
import { estimateCallCostUsd } from "../src/utils/cost.js";

describe("estimateCallCostUsd", () => {
  it.each([
    ["gpt-6.1-sol", 0.00781],
    ["chatgpt-gpt-6.1-sol", 0.00781],
    ["gpt-6-sol", 0.00782],
    ["chatgpt-gpt-6-luna", 0.000391],
    ["gpt-6-astra", 0.0391],
    ["chatgpt-gpt-6-astra", 0.0391],
    ["gpt-5.6-sol", 0.01564],
    ["chatgpt-gpt-5.6-terra", 0.00902],
    ["gpt-5.6-luna", 0.000902],
  ] as const)("prices %s standard, priority, and concrete versions", (modelId, expectedCost) => {
    const tokens = {
      promptTokens: 1000,
      cachedTokens: 100,
      responseTokens: 500,
      thinkingTokens: 100,
    };
    const estimate = (model: string, pricingModelId?: string) =>
      estimateCallCostUsd({ modelId: model, pricingModelId, tokens, responseImages: 0 });
    expect(estimate(modelId)).toBeCloseTo(expectedCost, 10);
    expect(estimate(modelId + "-fast")).toBeCloseTo(expectedCost * 2, 10);
    expect(estimate(modelId + "-2026-10-03")).toBeCloseTo(expectedCost, 10);
    expect(estimate(modelId + "-2026-10-03", modelId + "-fast")).toBeCloseTo(expectedCost * 2, 10);
  });

  it.each([
    ["gpt-6.1-sol", 1000, 0.00791],
    ["gpt-6.1-sol", 272000, 0.54991],
    ["gpt-6.1-sol", 272001, 1.096824],
    ["chatgpt-gpt-6-astra", 1000, 0.0396],
    ["chatgpt-gpt-6-astra", 272000, 2.7496],
    ["chatgpt-gpt-6-astra", 272001, 5.48422],
  ] as const)("prices %s cache writes at the %s token boundary", (modelId, promptTokens, expectedCost) => {
    expect(
      estimateCallCostUsd({
        modelId,
        tokens: {
          promptTokens,
          cachedTokens: 100,
          cacheWriteTokens: 200,
          responseTokens: 500,
          thinkingTokens: 100,
        },
        responseImages: 0,
      }),
    ).toBeCloseTo(expectedCost, 10);
  });

  it("does not invent pricing for retired or private models", () => {
    for (const modelId of [
      "gpt-5.5",
      "gpt-5.4-mini",
      "experimental-chatgpt-private-model",
      "__proto__",
      "constructor",
      "unlisted-model",
    ]) {
      expect(
        estimateCallCostUsd({
          modelId,
          tokens: { promptTokens: 1000, responseTokens: 600 },
          responseImages: 0,
        }),
      ).toBe(0);
    }
    expect(
      estimateCallCostUsd({
        modelId: "experimental-chatgpt-private-model",
        pricingModelId: "gpt-6-sol",
        tokens: { promptTokens: 1000, responseTokens: 600 },
        responseImages: 0,
      }),
    ).toBeCloseTo(0.008, 10);
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

  it("estimates GPT Image 2 output costs", () => {
    const squareLowCost = estimateCallCostUsd({
      modelId: "gpt-image-2",
      tokens: undefined,
      responseImages: 1,
      imageSize: "1024x1024",
      imageQuality: "low",
    });
    const landscapeHighCost = estimateCallCostUsd({
      modelId: "gpt-image-2",
      tokens: undefined,
      responseImages: 1,
      imageSize: "2048x1152",
      imageQuality: "high",
    });

    expect(squareLowCost).toBeCloseTo(0.006, 8);
    expect(landscapeHighCost).toBeCloseTo(0.165, 8);
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
      const isGptImageModel = isOpenAiImageModelId(modelId) || isChatGptImageModelId(modelId);
      const responseImages = modelId.includes("image-preview") || isGptImageModel ? 1 : 0;
      const cost = estimateCallCostUsd({
        modelId,
        tokens,
        responseImages,
        imageSize: isGptImageModel ? "1024x1024" : "2K",
        imageQuality: isGptImageModel ? "medium" : undefined,
      });
      expect(cost, `expected non-zero cost mapping for ${modelId}`).toBeGreaterThan(0);
    }
  });
});
