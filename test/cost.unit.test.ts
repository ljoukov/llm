import { describe, expect, it, vi } from "vitest";

import { isOpenAiImageModelId, LLM_MODEL_IDS } from "../src/index.js";
import { estimateCallCostUsd } from "../src/utils/cost.js";

describe("estimateCallCostUsd", () => {
  it.each([
    ["gpt-6.1-sol", 0.00781],
    ["gpt-6.1-sol", 0.00781],
    ["gpt-6.1-terra", 0.003905],
    ["gpt-6-sol", 0.00782],
    ["gpt-6-luna", 0.000391],
    ["gpt-6-astra", 0.0391],
    ["gpt-6-astra", 0.0391],
    ["gpt-5.6-sol", 0.01564],
    ["gpt-5.6-terra", 0.00902],
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
    ["gpt-6.1-terra", 1000, 0.003955],
    ["gpt-6.1-terra", 272000, 0.274955],
    ["gpt-6.1-terra", 272001, 0.548412],
    ["gpt-6-astra", 1000, 0.0396],
    ["gpt-6-astra", 272000, 2.7496],
    ["gpt-6-astra", 272001, 5.48422],
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
      ).toBeNull();
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

  it.each([
    ["deepseek-v4.1-flash-1017", 0.0009906000000000001],
    ["glm-5.3", 0.003926],
    ["kimi-k3", 0.01173],
  ] as const)("estimates current Fireworks %s costs", (modelId, expectedCost) => {
    expect(
      estimateCallCostUsd({
        modelId,
        tokens: { promptTokens: 1000, cachedTokens: 100, responseTokens: 500, thinkingTokens: 100 },
        responseImages: 0,
      }),
    ).toBeCloseTo(expectedCost, 10);
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

  it("estimates distinct Gemini Flash model costs", () => {
    const modelCosts = [
      ["gemini-2.5-flash", 0.001246],
      ["gemini-flash-latest", 0.00483],
      ["gemini-3-flash-preview", 0.00161],
    ] as const;
    for (const [modelId, expectedCost] of modelCosts) {
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

      expect(cost).toBeCloseTo(expectedCost, 8);
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
    // cached: 200 * (0.01/1M) = 0.000002
    // output: 400 * (0.40/1M) = 0.00016
    expect(cost).toBeCloseTo(0.000242, 8);
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

  it.each([
    "gpt-image-2",
    "gpt-image-2",
  ])("prices %s reported input and output tokens without charging per-image estimates again", (modelId) => {
    expect(
      estimateCallCostUsd({
        modelId,
        tokens: {
          promptTokens: 1000,
          promptTextTokens: 200,
          promptImageTokens: 800,
          cachedTokens: 500,
          responseTokens: 6000,
        },
        responseImages: 2,
        imageSize: "3840x2160",
        imageQuality: "high",
      }),
    ).toBeCloseTo((200 * 5 + 800 * 8 + 6000 * 30) / 1_000_000, 12);
  });

  it("uses the GPT Image output token breakdown when available", () => {
    expect(
      estimateCallCostUsd({
        modelId: "gpt-image-2",
        tokens: {
          promptTokens: 100,
          responseTokens: 500,
          responseImageTokens: 400,
          responseTextTokens: 100,
        },
        responseImages: 1,
      }),
    ).toBeCloseTo((100 * 5 + 400 * 30) / 1_000_000, 12);
  });

  it("adds known GPT Image input costs to the output fallback when output usage is missing", () => {
    expect(
      estimateCallCostUsd({
        modelId: "gpt-image-2",
        tokens: { promptTokens: 1000, promptImageTokens: 800 },
        responseImages: 2,
        imageQuality: "low",
        imageSize: "1024x1024",
      }),
    ).toBeCloseTo(0.012 + (200 * 5 + 800 * 8) / 1_000_000, 12);
  });

  it("prices a Gemini latest alias using the concrete model returned by the service", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T00:00:00Z"));
    try {
      expect(
        estimateCallCostUsd({
          modelId: "gemini-3.8-flash-001",
          pricingModelId: "gemini-flash-latest",
          tokens: { promptTokens: 1000, responseTokens: 1000 },
          responseImages: 0,
        }),
      ).toBeCloseTo(0.0045, 12);
    } finally {
      now.mockRestore();
    }
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
    expect(flashCost).toBeLessThan(proCost as number);
  });

  it("prices supported models with verified rate snapshots and retains unknown rates", () => {
    const tokens = {
      promptTokens: 1000,
      cachedTokens: 100,
      responseTokens: 500,
      thinkingTokens: 100,
      responseImageTokens: 0,
    };

    for (const modelId of LLM_MODEL_IDS) {
      const isGptImageModel = isOpenAiImageModelId(modelId);
      const responseImages = modelId.includes("image-preview") || isGptImageModel ? 1 : 0;
      const cost = estimateCallCostUsd({
        modelId,
        tokens,
        responseImages,
        imageSize: isGptImageModel ? "1024x1024" : "2K",
        imageQuality: isGptImageModel ? "medium" : undefined,
      });
      if (modelId === "grok-build") {
        expect(cost).toBeNull();
      } else {
        expect(cost, `expected non-zero cost mapping for ${modelId}`).toBeGreaterThan(0);
      }
    }
  });
});
