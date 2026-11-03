import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveThinkingLevel } from "../src/thinking.js";
import { listModels } from "../src/model-catalog.js";
import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

beforeEach(() => {
  resetRuntimeSingletonsForTesting();
  vi.stubEnv("AI_GATEWAY_BASE_URL", "https://thinking.test/v1");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRuntimeSingletonsForTesting();
});

describe("portable thinking levels", () => {
  it.each([
    ["grok-4.7", "low", "low"],
    ["grok-4.7", "medium", "medium"],
    ["grok-4.7", "high", "high"],
    ["grok-4.7", "xhigh", "xhigh"],
    ["grok-4.7", "max", "xhigh"],
    ["grok-4.7", "ultra", "xhigh"],
    ["grok-4.6", "max", "xhigh"],
    ["grok-4.5", "max", "high"],
    ["grok-4.5", "xhigh", "high"],
    ["grok-4.5", "ultra", "high"],
  ] as const)("maps %s %s to %s without discovery or credentials", (model, thinkingLevel, effectiveLevel) => {
    for (const access of ["api", "subscription"] as const) {
      expect(resolveThinkingLevel({ provider: "xai", access, model, thinkingLevel })).toEqual({
        requestedLevel: thinkingLevel,
        effectiveLevel,
        source: "model",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the same model mapping for qualified and Gateway Grok routes", () => {
    expect(
      resolveThinkingLevel({ model: "xai:subscription:grok-4.7", thinkingLevel: "max" })
        ?.effectiveLevel,
    ).toBe("xhigh");
    for (const model of ["xai/grok-4.7", "spacexai/grok-4.7"]) {
      expect(
        resolveThinkingLevel({ provider: "vercel", model, thinkingLevel: "ultra" })?.effectiveLevel,
      ).toBe("xhigh");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves OpenAI/Claude maximums and Gemini's existing high mapping", () => {
    for (const model of [
      "openai:subscription:gpt-6.1-sol",
      "openai:api:gpt-6-astra",
      "anthropic:api:claude-opus-5-5",
    ]) {
      expect(resolveThinkingLevel({ model, thinkingLevel: "ultra" })?.effectiveLevel).toBe("max");
    }
    expect(resolveThinkingLevel({ model: "gemini-3.1-pro-preview", thinkingLevel: "max" })).toEqual(
      {
        requestedLevel: "max",
        effectiveLevel: "high",
        source: "model",
      },
    );
  });

  it("rejects known unsupported levels in strict mode, while ultra remains a highest-level preset", () => {
    expect(() =>
      resolveThinkingLevel({
        model: "grok-4.7",
        thinkingLevel: "max",
        thinkingLevelPolicy: "strict",
      }),
    ).toThrow(/Supported levels: low, medium, high, xhigh/);
    expect(
      resolveThinkingLevel({
        model: "grok-4.7",
        thinkingLevel: "ultra",
        thinkingLevelPolicy: "strict",
      })?.effectiveLevel,
    ).toBe("xhigh");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not guess support for future models or resolve an omitted level", () => {
    expect(resolveThinkingLevel({ model: "grok-future", thinkingLevel: "max" })).toEqual({
      requestedLevel: "max",
      effectiveLevel: "max",
      source: "passthrough",
    });
    expect(resolveThinkingLevel({ model: "grok-4.7" })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prefers cached Gateway efforts without depending on ordering, including short model refs", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "spacexai/grok-4.7",
              reasoning_options: [
                { type: "effort", values: ["max", "low", "high", "future-effort"] },
              ],
            },
            {
              id: "deepseek/deepseek-v4.1-flash-1017",
              reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
            },
            {
              id: "publisher/minimum-high",
              reasoning_options: [{ type: "effort", values: ["high", "max"] }],
            },
            { id: "publisher/fixed", reasoning_options: [] },
            {
              id: "publisher/future",
              reasoning_options: [{ type: "effort", values: ["future-effort"] }],
            },
          ],
        }),
      ),
    );
    await listModels({ provider: "vercel" });
    const resolve = (model: string, thinkingLevel: "low" | "xhigh" | "max" | "ultra") =>
      resolveThinkingLevel({ provider: "vercel", model, thinkingLevel });
    expect(resolve("spacexai/grok-4.7", "max")).toEqual({
      requestedLevel: "max",
      effectiveLevel: "max",
      source: "catalog",
    });
    expect(resolve("spacexai/grok-4.7", "xhigh")?.effectiveLevel).toBe("high");
    expect(resolve("deepseek-v4.1-flash-1017", "xhigh")?.effectiveLevel).toBe("high");
    expect(resolve("publisher/minimum-high", "low")?.effectiveLevel).toBe("high");
    expect(resolve("publisher/fixed", "ultra")?.effectiveLevel).toBeUndefined();
    expect(resolve("publisher/future", "ultra")?.source).toBe("passthrough");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
