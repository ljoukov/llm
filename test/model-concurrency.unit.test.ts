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
    expect(normalizeModelIdForConfig("gpt-6-luna")).toBe("gpt-6-luna");
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
      modelCaps: { "gpt-6-luna": 6 },
      providerModelCaps: {
        openai: { "gpt-6-luna": 7 },
      },
    });

    expect(
      resolveModelConcurrencyCap({
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).toBe(7);
  });

  it("uses higher OpenAI default and lower Gemini preview default", () => {
    expect(resolveModelConcurrencyCap({ provider: "openai", modelId: "gpt-6-sol" })).toBe(12);
    expect(
      resolveModelConcurrencyCap({ provider: "google", modelId: "gemini-3.1-pro-preview" }),
    ).toBe(2);
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
        modelId: "kimi-k3",
      }),
    ).toBe(64);
  });

  it("supports Anthropic defaults and provider/model overrides", () => {
    expect(resolveModelConcurrencyCap({ provider: "anthropic", modelId: "sonnet-5-5" })).toBe(4);

    configureModelConcurrency({
      providerCaps: { anthropic: 5 },
      providerModelCaps: { anthropic: { " SONNET-5-5 ": 7 } },
    });
    expect(resolveModelConcurrencyCap({ provider: "anthropic", modelId: "sonnet-5-5" })).toBe(7);
    expect(resolveModelConcurrencyCap({ provider: "anthropic", modelId: "haiku-5-5" })).toBe(5);

    resetModelConcurrencyConfig();
    expect(resolveModelConcurrencyCap({ provider: "anthropic", modelId: "sonnet-5-5" })).toBe(4);
  });

  it("keeps Claude subscription concurrency separate from the API", () => {
    expect(resolveModelConcurrencyCap({ provider: "claude", modelId: "claude-sonnet-5-5" })).toBe(
      2,
    );
    configureModelConcurrency({
      providerCaps: { claude: 3, anthropic: 5 },
      providerModelCaps: { claude: { " CLAUDE-SONNET-5-5 ": 1 } },
    });
    expect(resolveModelConcurrencyCap({ provider: "claude", modelId: "claude-sonnet-5-5" })).toBe(
      1,
    );
    expect(resolveModelConcurrencyCap({ provider: "claude", modelId: "claude-haiku-5-5" })).toBe(3);
    expect(resolveModelConcurrencyCap({ provider: "anthropic", modelId: "sonnet-5-5" })).toBe(5);
  });

  it("supports resetting configured caps", () => {
    configureModelConcurrency({
      providerCaps: {
        openai: 9,
      },
    });
    expect(resolveModelConcurrencyCap({ provider: "openai", modelId: "gpt-6-luna" })).toBe(9);

    resetModelConcurrencyConfig();
    expect(resolveModelConcurrencyCap({ provider: "openai", modelId: "gpt-6-luna" })).toBe(12);
  });

  it("keeps Vercel concurrency separate from direct Fireworks", () => {
    expect(resolveModelConcurrencyCap({ provider: "vercel", modelId: "zai/glm-5.3" })).toBe(6);
    configureModelConcurrency({ providerCaps: { vercel: 2, fireworks: 5 } });
    expect(resolveModelConcurrencyCap({ provider: "vercel", modelId: "zai/glm-5.3" })).toBe(2);
    expect(resolveModelConcurrencyCap({ provider: "fireworks", modelId: "glm-5.3" })).toBe(5);
  });
});
