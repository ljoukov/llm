import { describe, expect, it } from "vitest";

import {
  FIREWORKS_DEFAULT_DEEPSEEK_MODEL,
  FIREWORKS_DEFAULT_GLM_MODEL,
  FIREWORKS_DEFAULT_KIMI_MODEL,
  FIREWORKS_MODEL_IDS,
  isFireworksModelId,
  isLlmTextModelId,
  resolveFireworksModelId,
} from "../src/index.js";
import { getFireworksPricing } from "../src/fireworks/pricing.js";

const currentModels = [
  ["deepseek-v4.1-flash-1017", "accounts/fireworks/models/deepseek-v4p1-flash-1017"],
  ["glm-5.3", "accounts/fireworks/models/glm-5p3"],
  ["kimi-k3", "accounts/fireworks/models/kimi-k3"],
] as const;

describe("fireworks model ids", () => {
  it("matches the current direct serverless LLM catalogue", () => {
    expect(FIREWORKS_MODEL_IDS).toEqual(currentModels.map(([model]) => model));
  });

  it.each(currentModels)("resolves %s to %s", (model, canonical) => {
    expect(isFireworksModelId(model)).toBe(true);
    expect(isLlmTextModelId(model)).toBe(true);
    expect(resolveFireworksModelId(model)).toBe(canonical);
    expect(resolveFireworksModelId(` ${model} `)).toBe(canonical);
    expect(getFireworksPricing(canonical)).toEqual(getFireworksPricing(model));
  });

  it.each([
    "kimi-k2.5",
    "glm-5",
    "minimax-m2.1",
    "firerouter/auto",
    "qwen3-embedding-8b",
    "glm-5.3-unknown",
    "glm-5p3",
    "__proto__",
    "constructor",
  ])("rejects retired, routed, non-text, and unknown model %s", (model) => {
    expect(isFireworksModelId(model)).toBe(false);
    expect(isLlmTextModelId(model)).toBe(false);
    expect(resolveFireworksModelId(model)).toBeUndefined();
    expect(getFireworksPricing(model)).toBeUndefined();
  });

  it("selects current default family models", () => {
    expect(FIREWORKS_DEFAULT_DEEPSEEK_MODEL).toBe("deepseek-v4.1-flash-1017");
    expect(FIREWORKS_DEFAULT_KIMI_MODEL).toBe("kimi-k3");
    expect(FIREWORKS_DEFAULT_GLM_MODEL).toBe("glm-5.3");
  });
});
