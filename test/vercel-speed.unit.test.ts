import { describe, expect, it } from "vitest";

import { extractVercelServingMetadata, resolveVercelSpeedOptions } from "../src/vercel/speed.js";

describe("Vercel serving speed", () => {
  it("uses native serving controls without manufacturing model aliases", () => {
    expect(resolveVercelSpeedOptions("openai/gpt-6.1-sol", "fast")).toEqual({
      gateway: { sort: "cost", serviceTier: "priority" },
    });
    expect(resolveVercelSpeedOptions("anthropic/claude-opus-5-5", "fast")).toEqual({
      gateway: { sort: "cost", speed: "fast", allowFallbackFromFast: false },
    });
    expect(resolveVercelSpeedOptions("publisher/model", undefined)).toEqual({
      gateway: { sort: "cost" },
    });
  });

  it("forces standard serving when explicitly selected", () => {
    expect(resolveVercelSpeedOptions("openai/gpt-6.1-sol", "standard")).toEqual({
      gateway: { sort: "cost", serviceTier: "default" },
    });
    expect(resolveVercelSpeedOptions("anthropic/claude-opus-5-5", "standard")).toEqual({
      gateway: { sort: "cost", serviceTier: "default" },
      anthropic: { speed: "standard" },
    });
    expect(() => resolveVercelSpeedOptions("openai/gpt-6-astra", "ultrafast")).toThrow(
      "Ultrafast speed is not supported",
    );
  });

  it.each([
    [{ provider_metadata: { gateway: { routing: { speed: "fast" } } } }, "fast", undefined],
    [{ provider_metadata: { gateway: { serviceTier: "priority" } } }, "fast", "priority"],
    [{ service_tier: "ultrafast" }, "ultrafast", "ultrafast"],
    [{ service_tier: "default" }, "standard", "default"],
    [{ provider_metadata: { gateway: {} } }, undefined, undefined],
    [{ provider_metadata: { gateway: { serviceTier: "flex" } } }, undefined, "flex"],
    [{ service_tier: "future-tier" }, undefined, "future-tier"],
  ])("reports effective serving metadata from %j", (payload, effectiveSpeed, serviceTier) => {
    expect(extractVercelServingMetadata(payload)).toEqual({
      ...(effectiveSpeed !== undefined ? { effectiveSpeed } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    });
  });

  it("does not invent an effective speed when the provider omits serving metadata", () => {
    expect(extractVercelServingMetadata({})).toEqual({});
  });
});
