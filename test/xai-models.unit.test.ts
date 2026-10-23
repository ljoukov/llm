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

  it("uses the inclusive 200k long-context threshold", () => {
    const regular = getXaiPricing("grok-4.7", 199_999);
    const longContext = getXaiPricing("grok-4.7", 200_000);
    expect(regular?.inputRate).toBe(2 / 1_000_000);
    expect(longContext?.inputRate).toBe(4 / 1_000_000);
    expect(longContext?.cachedRate).toBe(1 / 1_000_000);
    expect(longContext?.outputRate).toBe(12 / 1_000_000);
  });

  it("does not invent a price for an unrecognized model or subscription alias", () => {
    expect(getXaiPricing("grok-next-model-123")).toBeUndefined();
    expect(getXaiPricing("grok-build")).toBeUndefined();
    expect(getXaiPricing("constructor")).toBeUndefined();
    expect(getXaiPricing("__proto__")).toBeUndefined();
  });
});
