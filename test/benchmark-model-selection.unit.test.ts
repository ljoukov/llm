import { describe, expect, it } from "vitest";

import { benchmarkModelSelection, isBenchmarkModel } from "../benchmarks/model-selection.js";

describe("benchmark model selection", () => {
  it("normalizes qualified references with an independent speed modifier", () => {
    expect(benchmarkModelSelection("openai:subscription:gpt-6.1-sol", "fast")).toEqual({
      provider: "openai",
      access: "subscription",
      model: "gpt-6.1-sol",
      speed: "fast",
    });
  });

  it("validates inferred API routes and preserves native model colons", () => {
    expect(benchmarkModelSelection("gpt-6.1-sol")).toMatchObject({
      provider: "openai",
      access: "api",
      model: "gpt-6.1-sol",
    });
    expect(benchmarkModelSelection("vercel:api:publisher/model:variant:free")).toMatchObject({
      provider: "vercel",
      access: "api",
      model: "publisher/model:variant:free",
    });
  });

  it.each([
    "gpt-6.1-terra",
    "gpt-6.1-sol-fast",
    "openai:subscription:gpt-6.1-sol-fast",
    "chatgpt-gpt-6.1-sol",
    "openai:subscription:chatgpt-gpt-6.1-sol",
    "openai:subscription:gpt-image-2",
  ])("rejects invalid text selection %s before a benchmark starts", (label) => {
    expect(() => benchmarkModelSelection(label)).toThrow();
    expect(isBenchmarkModel(label)).toBe(false);
  });

  it("rejects unsupported speeds while accepting explicit subscription-only text routes", () => {
    expect(isBenchmarkModel("google:api:gemini-2.5-pro", "fast")).toBe(false);
    expect(isBenchmarkModel("openai:subscription:gpt-6.1-terra", "fast")).toBe(true);
  });
});
