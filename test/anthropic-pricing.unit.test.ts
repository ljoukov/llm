import { describe, expect, it } from "vitest";

import { ANTHROPIC_MODEL_IDS, isAnthropicModelId } from "../src/anthropic/models.js";
import { getAnthropicPricing } from "../src/anthropic/pricing.js";
import { CLAUDE_MODEL_IDS, isClaudeModelId } from "../src/claude/models.js";
import { estimateCallCostUsd } from "../src/utils/cost.js";

describe("Anthropic model allowlist", () => {
  it("accepts exactly the supported Claude model IDs", () => {
    expect(ANTHROPIC_MODEL_IDS).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
    for (const modelId of ANTHROPIC_MODEL_IDS) {
      expect(isAnthropicModelId(modelId)).toBe(true);
      expect(isAnthropicModelId(modelId.slice("claude-".length))).toBe(false);
      expect(isClaudeModelId(modelId)).toBe(true);
    }
    expect(isAnthropicModelId("claude-sonnet-4-5")).toBe(false);
    expect(isAnthropicModelId("claude-sonnet-5-5-latest")).toBe(false);
    expect(isAnthropicModelId("toString")).toBe(false);
  });
});

describe("Anthropic standard global pricing", () => {
  it("uses API-equivalent estimates for subscription and native model IDs", () => {
    for (const modelId of CLAUDE_MODEL_IDS) {
      const apiModelId = modelId;
      expect(getAnthropicPricing(modelId)).toEqual(getAnthropicPricing(apiModelId));
      const tokens = { promptTokens: 1_000, responseTokens: 100 };
      expect(estimateCallCostUsd({ modelId, tokens, responseImages: 0 })).toBe(
        estimateCallCostUsd({ modelId: apiModelId, tokens, responseImages: 0 }),
      );
    }
  });
  it.each([
    ["claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125, 0.2],
    ["claude-sonnet-5-5", 2, 10, 0.1, 2.5, 4],
    ["claude-opus-5-5", 4, 20, 0.2, 5, 8],
    ["claude-fable-5-1", 10, 50, 0.25, 12.5, 20],
  ] as const)("%s uses the official per-token input/output/cache rates", (modelId, input, output, read, write5m, write1h) => {
    expect(getAnthropicPricing(modelId)).toEqual({
      inputRate: input / 1_000_000,
      outputRate: output / 1_000_000,
      cachedRate: read / 1_000_000,
      cacheWrite5mRate: write5m / 1_000_000,
      cacheWrite1hRate: write1h / 1_000_000,
    });
  });

  it("applies Haiku's higher tier only above 100,000 total prompt tokens", () => {
    expect(getAnthropicPricing("claude-haiku-5-5", 100_000)?.inputRate).toBe(0.1 / 1_000_000);
    expect(getAnthropicPricing("claude-haiku-5-5", 100_001)).toEqual({
      inputRate: 0.5 / 1_000_000,
      outputRate: 2.5 / 1_000_000,
      cachedRate: 0.05 / 1_000_000,
      cacheWrite5mRate: 0.625 / 1_000_000,
      cacheWrite1hRate: 1 / 1_000_000,
    });
    expect(getAnthropicPricing("claude-sonnet-5-5", 900_000)).toEqual(
      getAnthropicPricing("claude-sonnet-5-5"),
    );
  });

  it("has no inferred rate for unsupported models", () => {
    expect(getAnthropicPricing("claude-opus-5-5-fast")).toBeUndefined();
    expect(getAnthropicPricing("claude-future")).toBeUndefined();
    expect(getAnthropicPricing("constructor")).toBeUndefined();
  });
});

describe("Anthropic cost accounting", () => {
  it.each([
    ["claude-haiku-5-5", 0.1, 0.5],
    ["claude-sonnet-5-5", 2, 10],
    ["claude-opus-5-5", 4, 20],
    ["claude-fable-5-1", 10, 50],
  ] as const)("prices %s input and output", (modelId, input, output) => {
    expect(
      estimateCallCostUsd({
        modelId,
        tokens: { promptTokens: 1_000, responseTokens: 100 },
        responseImages: 0,
      }),
    ).toBeCloseTo((1_000 * input + 100 * output) / 1_000_000, 12);
  });

  it("prices normal input, cache reads, and both cache-write TTLs separately", () => {
    expect(
      estimateCallCostUsd({
        modelId: "claude-sonnet-5-5",
        tokens: {
          promptTokens: 1_000,
          cachedTokens: 200,
          cacheWriteTokens: 300,
          anthropicCacheCreation5mInputTokens: 200,
          anthropicCacheCreation1hInputTokens: 100,
          responseTokens: 100,
          thinkingTokens: 50,
        },
        responseImages: 0,
      }),
    ).toBeCloseTo((500 * 2 + 200 * 0.1 + 200 * 2.5 + 100 * 4 + 100 * 10) / 1_000_000, 12);
  });

  it("uses five-minute pricing when cache-write TTL details are absent", () => {
    expect(
      estimateCallCostUsd({
        modelId: "claude-fable-5-1",
        tokens: { promptTokens: 1_000, cacheWriteTokens: 400 },
        responseImages: 0,
      }),
    ).toBeCloseTo((600 * 10 + 400 * 12.5) / 1_000_000, 12);
  });

  it("can derive cache-write totals from the TTL breakdown", () => {
    expect(
      estimateCallCostUsd({
        modelId: "claude-opus-5-5",
        tokens: {
          promptTokens: 1_000,
          anthropicCacheCreation5mInputTokens: 200,
          anthropicCacheCreation1hInputTokens: 100,
        },
        responseImages: 0,
      }),
    ).toBeCloseTo((700 * 4 + 200 * 5 + 100 * 8) / 1_000_000, 12);
  });

  it("counts cache reads and writes toward Haiku's prompt threshold", () => {
    expect(
      estimateCallCostUsd({
        modelId: "claude-haiku-5-5",
        tokens: {
          promptTokens: 100_001,
          cachedTokens: 50_000,
          cacheWriteTokens: 50_000,
          responseTokens: 10,
        },
        responseImages: 0,
      }),
    ).toBeCloseTo((0.5 + 50_000 * 0.05 + 50_000 * 0.625 + 10 * 2.5) / 1_000_000, 12);
  });

  it("supports an explicit known pricing model without inferring unknown model rates", () => {
    const options = {
      modelId: "private-claude-deployment",
      tokens: { promptTokens: 1_000, responseTokens: 100 },
      responseImages: 0,
    };
    expect(estimateCallCostUsd(options)).toBeNull();
    expect(estimateCallCostUsd({ ...options, pricingModelId: "claude-sonnet-5-5" })).toBeCloseTo(
      0.003,
      12,
    );
  });

  it("does not let inconsistent cache counters produce negative input costs", () => {
    expect(
      estimateCallCostUsd({
        modelId: "claude-sonnet-5-5",
        tokens: {
          promptTokens: 100,
          cachedTokens: 150,
          cacheWriteTokens: 200,
          anthropicCacheCreation1hInputTokens: 300,
        },
        responseImages: 0,
      }),
    ).toBeCloseTo((100 * 0.1) / 1_000_000, 12);
  });
});
