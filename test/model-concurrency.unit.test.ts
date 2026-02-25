import { describe, expect, it } from "vitest";

import {
  clampModelConcurrencyCap,
  normalizeModelIdForEnv,
  resolveModelConcurrencyCap,
} from "../src/utils/modelConcurrency.js";

describe("model concurrency env parsing", () => {
  it("normalizes model ids for env keys", () => {
    expect(normalizeModelIdForEnv("gpt-5.2")).toBe("GPT_5_2");
    expect(normalizeModelIdForEnv(" gemini-2.5-pro/experimental ")).toBe(
      "GEMINI_2_5_PRO_EXPERIMENTAL",
    );
  });

  it("clamps configured caps to the supported range", () => {
    expect(clampModelConcurrencyCap(0)).toBe(1);
    expect(clampModelConcurrencyCap(1)).toBe(1);
    expect(clampModelConcurrencyCap(64)).toBe(64);
    expect(clampModelConcurrencyCap(65)).toBe(64);
  });

  it("prefers provider+model overrides over broader defaults", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_MAX_PARALLEL_REQUESTS_PER_MODEL: "4",
      OPENAI_MAX_PARALLEL_REQUESTS_PER_MODEL: "5",
      LLM_MAX_PARALLEL_REQUESTS_MODEL_GPT_5_2: "6",
      OPENAI_MAX_PARALLEL_REQUESTS_MODEL_GPT_5_2: "7",
    };

    expect(
      resolveModelConcurrencyCap({
        providerEnvPrefix: "OPENAI",
        modelId: "gpt-5.2",
        env,
      }),
    ).toBe(7);
  });

  it("falls back to default when configured values are invalid", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_MAX_PARALLEL_REQUESTS_PER_MODEL: "not-a-number",
      GOOGLE_MAX_PARALLEL_REQUESTS_PER_MODEL: "",
      GOOGLE_MAX_PARALLEL_REQUESTS_MODEL_GEMINI_2_5_PRO: "NaN",
    };

    expect(
      resolveModelConcurrencyCap({
        providerEnvPrefix: "GOOGLE",
        modelId: "gemini-2.5-pro",
        env,
        defaultCap: 9,
      }),
    ).toBe(9);
  });

  it("clamps parsed env values to max 64", () => {
    const env: NodeJS.ProcessEnv = {
      LLM_MAX_PARALLEL_REQUESTS_PER_MODEL: "512",
    };

    expect(
      resolveModelConcurrencyCap({
        providerEnvPrefix: "FIREWORKS",
        modelId: "kimi-k2.5",
        env,
      }),
    ).toBe(64);
  });
});
