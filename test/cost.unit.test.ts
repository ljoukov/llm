import { describe, expect, it } from "vitest";

import { isChatGptImageModelId, isOpenAiImageModelId, LLM_MODEL_IDS } from "../src/index.js";
import { estimateCallCostUsd } from "../src/utils/cost.js";

describe("estimateCallCostUsd", () => {
  it("estimates GPT-5.5 costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-5.5",
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

  it("prices GPT-5.5 fast aliases at priority rates", () => {
    for (const modelId of ["gpt-5.5-fast", "chatgpt-gpt-5.5-fast"]) {
      const cost = estimateCallCostUsd({
        modelId,
        tokens: {
          promptTokens: 1000,
          cachedTokens: 100,
          responseTokens: 500,
          thinkingTokens: 100,
        },
        responseImages: 0,
      });

      // non-cached prompt: 900 * (12.5/1M) = 0.01125
      // cached: 100 * (1.25/1M) = 0.000125
      // output: 600 * (75/1M) = 0.045
      expect(cost).toBeCloseTo(0.056375, 8);
    }
  });

  it("estimates GPT-5.4 mini costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-5.4-mini",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 0,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // input: 1000 * (0.25/1M) = 0.00025
    // output: 600 * (2/1M) = 0.0012
    expect(cost).toBeCloseTo(0.00145, 8);
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

  it("estimates GPT-5.4 nano costs", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-5.4-nano",
      tokens: {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 500,
        thinkingTokens: 100,
      },
      responseImages: 0,
    });

    // non-cached prompt: 900 * (0.05/1M) = 0.000045
    // cached: 100 * (0.005/1M) = 0.0000005
    // output: 600 * (0.4/1M) = 0.00024
    expect(cost).toBeCloseTo(0.0002855, 8);
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

  it("prices experimental ChatGPT models at GPT-5.4 standard rates", () => {
    const cost = estimateCallCostUsd({
      modelId: "experimental-chatgpt-private-model",
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

  it("prices gpt-5.4-fast at GPT-5.4 priority rates", () => {
    const cost = estimateCallCostUsd({
      modelId: "gpt-5.4-fast",
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
