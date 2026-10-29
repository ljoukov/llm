import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listModels } from "../src/model-catalog.js";
import { getVercelModelCatalog } from "../src/vercel/catalog.js";
import { getVercelPricing } from "../src/vercel/pricing.js";
import { resolveCallCostUsd } from "../src/utils/cost.js";
import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

const catalogue = {
  data: [
    {
      id: "reflection/beam-free",
      name: "Beam",
      context_window: 100_000,
      tags: ["tool-use", "reasoning"],
      pricing: { input: "0", output: "0" },
    },
    {
      id: "publisher/future:reasoning",
      pricing: { input: "0.000002", output: "0.00001", input_cache_read: "0.0000002" },
    },
    { id: "publisher/unknown-price" },
    { id: "publisher/invalid-price", pricing: { input: "-1", output: "NaN" } },
    ...[
      "openai/gpt-6.1-sol-fast",
      "openai/chatgpt-gpt-6.1-sol",
      "anthropic/claude-opus-5-5-fast",
      "anthropic/claude-opus-5-fast",
      "publisher/genuine-model-fast",
    ].map((id) => ({ id, pricing: { input: "0.000002", output: "0.00001" } })),
    { id: "malformed" },
  ],
};

function response(payload: unknown = catalogue): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

const usage = { promptTokens: 1_000, cachedTokens: 100, responseTokens: 50, thinkingTokens: 10 };

beforeEach(() => {
  resetRuntimeSingletonsForTesting();
  vi.stubEnv("AI_GATEWAY_BASE_URL", "https://catalogue.test/v1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRuntimeSingletonsForTesting();
});

describe("RAM model catalogue", () => {
  it("exposes discovered model refs and rates through listModels", async () => {
    const models = await listModels({ provider: "vercel" });
    expect(models.find((model) => model.model === "reflection/beam-free")).toMatchObject({
      provider: "vercel",
      access: "api",
      model: "reflection/beam-free",
      pricing: { inputRate: 0, outputRate: 0 },
      pricingSource: "catalog",
    });
    await listModels({ provider: "vercel" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps API and subscription catalogues distinct without remote discovery", async () => {
    const api = await listModels({ provider: "openai" });
    const subscription = await listModels({ provider: "openai", access: "subscription" });
    expect(api.some((model) => model.model === "gpt-5.6")).toBe(true);
    expect(subscription.some((model) => model.model === "gpt-5.6")).toBe(false);
    for (const id of ["gpt-6.1-terra"]) {
      expect(api.some((model) => model.model === id)).toBe(false);
      expect(subscription.find((model) => model.model === id)).toMatchObject({
        provider: "openai",
        access: "subscription",
        model: id,
        supportedSpeeds: ["standard", "fast"],
      });
    }
    expect(
      subscription.every((model) => model.provider === "openai" && model.access === "subscription"),
    ).toBe(true);
    await expect(listModels({ provider: "vercel", access: "subscription" })).rejects.toThrow(
      "does not support subscription",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("filters known serving aliases while preserving unrelated native model names", async () => {
    const models = await listModels({ provider: "vercel" });
    const ids = models.map((model) => model.model);
    expect(ids).not.toContain("openai/gpt-6.1-sol-fast");
    expect(ids).not.toContain("openai/chatgpt-gpt-6.1-sol");
    expect(ids).not.toContain("anthropic/claude-opus-5-5-fast");
    expect(ids).not.toContain("anthropic/claude-opus-5-fast");
    expect(ids).toContain("publisher/genuine-model-fast");
  });

  it("lists each base model once with speed capabilities and known rates", async () => {
    const models = await listModels({ provider: "openai", access: "subscription" });
    expect(new Set(models.map((model) => model.model)).size).toBe(models.length);
    expect(models.some((model) => model.model.endsWith("-fast"))).toBe(false);
    expect(models.some((model) => model.model.startsWith("chatgpt-"))).toBe(false);
    const sol = models.find((model) => model.model === "gpt-6.1-sol");
    expect(sol).toMatchObject({
      supportedSpeeds: ["standard", "fast", "ultrafast"],
      pricingBySpeed: {
        standard: { inputRate: 2 / 1_000_000, outputRate: 10 / 1_000_000 },
        fast: { inputRate: 4 / 1_000_000, outputRate: 20 / 1_000_000 },
        ultrafast: { inputRate: 12 / 1_000_000 },
      },
    });
    expect(sol?.pricingBySpeed?.ultrafast?.outputRate).toBeCloseTo(60 / 1_000_000, 12);
    expect(models.find((model) => model.model === "gpt-image-2")?.supportedSpeeds).toEqual([]);
    const anthropic = await listModels({ provider: "anthropic" });
    expect(anthropic.find((model) => model.model === "claude-opus-5-5")).toMatchObject({
      supportedSpeeds: ["standard", "fast"],
      pricingBySpeed: { fast: { inputRate: 8 / 1_000_000, outputRate: 40 / 1_000_000 } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parses public per-token rates and preserves real free models", async () => {
    const models = await getVercelModelCatalog();
    expect(models.map((model) => model.id)).not.toContain("malformed");
    expect(models.find((model) => model.id === "reflection/beam-free")).toMatchObject({
      name: "Beam",
      contextWindow: 100_000,
      pricing: { inputRate: 0, outputRate: 0 },
    });
    expect(getVercelPricing("publisher/future:reasoning")).toMatchObject({
      inputRate: 0.000002,
      outputRate: 0.00001,
      cachedRate: 0.0000002,
    });
    expect(models.find((model) => model.id === "publisher/invalid-price")?.pricing).toBeUndefined();
    const [, options] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(options).not.toHaveProperty("headers");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://catalogue.test/v1/models");
  });

  it("shares one in-flight fetch and reuses the catalogue for five minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi.mocked(fetch);
    const [first, second] = await Promise.all([getVercelModelCatalog(), getVercelModelCatalog()]);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledOnce();
    now.mockReturnValue(1_000 + 5 * 60_000 - 1);
    expect(await getVercelModelCatalog()).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    now.mockReturnValue(1_000 + 5 * 60_000);
    await getVercelModelCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps stale prices through failed refreshes and avoids repeated failing fetches", async () => {
    const first = await getVercelModelCatalog();
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    expect(await getVercelModelCatalog({ refresh: true })).toBe(first);
    expect(await getVercelModelCatalog()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds optional catalogue fetch latency even when a transport ignores cancellation", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    try {
      const pending = getVercelModelCatalog();
      const rejected = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1_500);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows explicit refresh to replace prices before TTL expiry", async () => {
    await getVercelModelCatalog();
    vi.mocked(fetch).mockResolvedValue(
      response({
        data: [
          { id: "publisher/future:reasoning", pricing: { input: "0.000001", output: "0.000004" } },
        ],
      }),
    );
    await getVercelModelCatalog({ refresh: true });
    expect(getVercelPricing("publisher/future:reasoning")?.inputRate).toBe(0.000001);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("cost provenance", () => {
  it("never looks up alias prices, but preserves an actual reported charge", async () => {
    const options = {
      provider: "vercel",
      modelId: "openai/gpt-6.1-sol-fast",
      tokens: usage,
      responseImages: 0,
    };
    expect(await resolveCallCostUsd(options)).toEqual({ costUsd: null, costSource: "unknown" });
    expect(await resolveCallCostUsd({ ...options, reportedCostUsd: 0.123 })).toEqual({
      costUsd: 0.123,
      costSource: "reported",
    });
    expect(
      await resolveCallCostUsd({
        ...options,
        modelId: "publisher/unknown",
        pricingModelId: "anthropic/claude-opus-5-fast",
      }),
    ).toEqual({ costUsd: null, costSource: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
    const genuine = await resolveCallCostUsd({
      ...options,
      modelId: "publisher/genuine-model-fast",
    });
    expect(genuine.costSource).toBe("catalog");
    expect(genuine.costUsd).toBeGreaterThan(0);
  });

  it("uses a reported charge, including zero, without fetching a catalogue", async () => {
    for (const reportedCostUsd of [0, 0.123]) {
      expect(
        await resolveCallCostUsd({
          provider: "vercel",
          modelId: "publisher/unknown",
          tokens: usage,
          responseImages: 0,
          reportedCostUsd,
        }),
      ).toEqual({ costUsd: reportedCostUsd, costSource: "reported" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses current catalogue prices and keeps unknown distinct from zero", async () => {
    expect(
      await resolveCallCostUsd({
        provider: "vercel",
        modelId: "reflection/beam-free",
        tokens: usage,
        responseImages: 0,
      }),
    ).toEqual({ costUsd: 0, costSource: "catalog" });
    expect(
      await resolveCallCostUsd({
        provider: "vercel",
        modelId: "publisher/unknown-price",
        tokens: usage,
        responseImages: 0,
      }),
    ).toEqual({ costUsd: null, costSource: "unknown" });
    const paid = await resolveCallCostUsd({
      provider: "vercel",
      modelId: "publisher/future:reasoning",
      tokens: usage,
      responseImages: 0,
    });
    expect(paid.costSource).toBe("catalog");
    expect(paid.costUsd).toBeCloseTo(900 * 0.000002 + 100 * 0.0000002 + 60 * 0.00001, 12);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("falls back to static rates when optional catalogue access fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const known = await resolveCallCostUsd({
      provider: "vercel",
      modelId: "zai/glm-5.3",
      tokens: usage,
      responseImages: 0,
    });
    expect(known.costSource).toBe("estimate");
    expect(known.costUsd).toBeGreaterThan(0);
    expect(
      await resolveCallCostUsd({
        provider: "vercel",
        modelId: "publisher/future",
        tokens: usage,
        responseImages: 0,
      }),
    ).toEqual({ costUsd: null, costSource: "unknown" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("separates subscription usage value from a billed API charge", async () => {
    const cost = await resolveCallCostUsd({
      provider: "openai",
      access: "subscription",
      modelId: "gpt-6-sol",
      tokens: usage,
      responseImages: 0,
    });
    expect(cost).toMatchObject({ costUsd: null, costSource: "subscription" });
    expect(cost.apiEquivalentCostUsd).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps unknown faster Gateway rates separate from standard catalogue prices", async () => {
    const options = {
      provider: "vercel",
      modelId: "reflection/beam-free",
      speed: "fast" as const,
      tokens: usage,
      responseImages: 0,
    };
    expect(await resolveCallCostUsd(options)).toEqual({ costUsd: null, costSource: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await resolveCallCostUsd({ ...options, reportedCostUsd: 0.123 })).toEqual({
      costUsd: 0.123,
      costSource: "reported",
    });
    for (const effectiveServiceTier of ["flex", "unknown-tier"]) {
      expect(
        await resolveCallCostUsd({ ...options, effectiveSpeed: "standard", effectiveServiceTier }),
      ).toEqual({ costUsd: null, costSource: "unknown" });
    }
    expect(
      await resolveCallCostUsd({
        ...options,
        effectiveSpeed: "standard",
        effectiveServiceTier: "priority",
      }),
    ).toEqual({ costUsd: null, costSource: "unknown" });
    expect(await resolveCallCostUsd({ ...options, effectiveSpeed: "standard" })).toEqual({
      costUsd: 0,
      costSource: "catalog",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("prices the actual subscription speed without creating a billed charge", async () => {
    const cost = await resolveCallCostUsd({
      provider: "openai",
      access: "subscription",
      modelId: "gpt-6.1-sol",
      speed: "fast",
      effectiveServiceTier: "default",
      tokens: { promptTokens: 1000, responseTokens: 1000 },
      responseImages: 0,
    });
    expect(cost).toEqual({
      costUsd: null,
      costSource: "subscription",
      apiEquivalentCostUsd: 0.012,
    });
  });
});
