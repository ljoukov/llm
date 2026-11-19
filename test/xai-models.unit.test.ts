import { describe, expect, it } from "vitest";

import { isXaiModelId, resolveXaiModelId, XAI_MODEL_IDS } from "../src/xai/models.js";
import { getXaiPricing } from "../src/xai/pricing.js";

describe("native xAI model names and pricing", () => {
  it("accepts curated and future native Grok names", () => {
    expect(XAI_MODEL_IDS.every(isXaiModelId)).toBe(true);
    expect(isXaiModelId("grok-next-model-123")).toBe(true);
    expect(resolveXaiModelId(" grok-4.7 ")).toBe("grok-4.7");
  });

  it.each([
    "grok-",
    "gpt-6.1-sol",
    "grok-model:subscription",
    "xai/grok-4.7",
    "grok-model\n",
    "grok-model space",
    "grok-💥",
  ])("rejects malformed or ambiguous model name %s", (model) =>
    expect(isXaiModelId(model)).toBe(false));

  it.each([
    ["grok-4.7", [2, 0.5, 6], [4, 1, 12]],
    ["grok-4.3", [1.25, 0.2, 2.5], [2.5, 0.4, 5]],
    ["grok-4.20-multi-agent-0309", [1.25, 0.2, 2.5], [2.5, 0.4, 5]],
    ["grok-4.20-0309-reasoning", [1.25, 0.2, 2.5], [2.5, 0.4, 5]],
    ["grok-4.20-0309-non-reasoning", [1.25, 0.2, 2.5], [2.5, 0.4, 5]],
  ] as const)("prices %s at the inclusive 200k threshold", (model, shortRates, longRates) => {
    const [input, cached, output] = shortRates;
    const [longInput, longCached, longOutput] = longRates;
    expect(getXaiPricing(model, 199_999)).toEqual({
      inputRate: input / 1_000_000,
      cachedRate: cached / 1_000_000,
      outputRate: output / 1_000_000,
    });
    expect(getXaiPricing(model, 200_000)).toEqual({
      inputRate: longInput / 1_000_000,
      cachedRate: longCached / 1_000_000,
      outputRate: longOutput / 1_000_000,
    });
  });

  it("does not invent a price for an unrecognized model or subscription alias", () => {
    expect(getXaiPricing("grok-next-model-123")).toBeUndefined();
    expect(getXaiPricing("grok-build")).toBeUndefined();
    expect(getXaiPricing("constructor")).toBeUndefined();
    expect(getXaiPricing("__proto__")).toBeUndefined();
  });
});
