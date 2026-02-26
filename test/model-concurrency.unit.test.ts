import { afterEach, describe, expect, it } from "vitest";

import {
  clampModelConcurrencyCap,
  configureModelConcurrency,
  normalizeModelIdForConfig,
  resetModelConcurrencyConfig,
  resolveModelConcurrencyCap,
} from "../src/utils/modelConcurrency.js";

describe("model concurrency config", () => {
  afterEach(() => {
    resetModelConcurrencyConfig();
  });

  it("normalizes model ids for config keys", () => {
    expect(normalizeModelIdForConfig("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelIdForConfig(" GEMINI-2.5-PRO ")).toBe("gemini-2.5-pro");
  });

  it("clamps configured caps to the supported range", () => {
    expect(clampModelConcurrencyCap(0)).toBe(1);
    expect(clampModelConcurrencyCap(1)).toBe(1);
    expect(clampModelConcurrencyCap(64)).toBe(64);
    expect(clampModelConcurrencyCap(65)).toBe(64);
  });

  it("prefers provider+model overrides over broader defaults", () => {
    configureModelConcurrency({
      globalCap: 4,
      providerCaps: { openai: 5 },
      modelCaps: { "gpt-5.2": 6 },
      providerModelCaps: {
        openai: { "gpt-5.2": 7 },
      },
    });

    expect(
      resolveModelConcurrencyCap({
        provider: "openai",
        modelId: "gpt-5.2",
      }),
    ).toBe(7);
  });

  it("uses higher OpenAI default and lower Gemini preview default", () => {
    expect(resolveModelConcurrencyCap({ provider: "openai", modelId: "gpt-5.3-codex" })).toBe(12);
    expect(resolveModelConcurrencyCap({ provider: "google", modelId: "gemini-3.1-pro-preview" })).toBe(
      2,
    );
    expect(resolveModelConcurrencyCap({ provider: "google", modelId: "gemini-2.5-pro" })).toBe(4);
  });

  it("clamps configured values to max 64", () => {
    configureModelConcurrency({
      providerCaps: {
        fireworks: 512,
      },
    });

    expect(
      resolveModelConcurrencyCap({
        provider: "fireworks",
        modelId: "kimi-k2.5",
      }),
    ).toBe(64);
  });

  it("supports resetting configured caps", () => {
    configureModelConcurrency({
      providerCaps: {
        openai: 9,
      },
    });
    expect(resolveModelConcurrencyCap({ provider: "openai", modelId: "gpt-5.2" })).toBe(9);

    resetModelConcurrencyConfig();
    expect(resolveModelConcurrencyCap({ provider: "openai", modelId: "gpt-5.2" })).toBe(12);
  });
});
