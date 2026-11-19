import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  googleGet: vi.fn(),
  anthropicGet: vi.fn(),
  xaiList: vi.fn(),
  fireworksGet: vi.fn(),
  vercelCatalog: vi.fn(),
  codexModels: vi.fn(),
}));
vi.mock("../src/google/client.js", () => ({
  getGeminiBackend: () => "api",
  getGeminiClient: async () => ({ models: { get: mocks.googleGet } }),
  isGeminiTextModelId: (id: string) => id.startsWith("gemini-"),
  isGeminiImageModelId: () => false,
}));
vi.mock("../src/anthropic/client.js", () => ({
  getAnthropicClient: () => ({ getModel: mocks.anthropicGet }),
}));
vi.mock("../src/xai/client.js", () => ({
  getXaiClient: async () => ({ models: { list: mocks.xaiList } }),
}));
vi.mock("../src/fireworks/client.js", () => ({
  getFireworksClient: () => ({
    baseURL: "https://api.fireworks.ai/inference/v1",
    get: mocks.fireworksGet,
  }),
}));
vi.mock("../src/vercel/catalog.js", () => ({ getVercelModelCatalog: mocks.vercelCatalog }));
vi.mock("../src/openai/chatgpt-codex.js", () => ({ fetchChatGptCodexModels: mocks.codexModels }));

import { clearModelContextWindowCache, resolveModelContextWindow } from "../src/model-context.js";

beforeEach(() => {
  clearModelContextWindowCache();
  vi.clearAllMocks();
  mocks.codexModels.mockResolvedValue([]);
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("AI_GATEWAY_BASE_URL", "");
});
afterEach(() => {
  clearModelContextWindowCache();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("model context-window discovery", () => {
  it("uses real input/output metadata and deduplicates concurrent Google discovery", async () => {
    mocks.googleGet.mockResolvedValue({ inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 });
    const route = { provider: "google" as const, model: "gemini-2.5-pro" as const };
    const results = await Promise.all([
      resolveModelContextWindow(route),
      resolveModelContextWindow(route),
    ]);
    expect(results[0]).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536,
      limitType: "input",
      source: "provider",
    });
    expect(results[0]).toBe(results[1]);
    expect(mocks.googleGet).toHaveBeenCalledTimes(1);
    await resolveModelContextWindow(route);
    expect(mocks.googleGet).toHaveBeenCalledTimes(1);
  });

  it("expires successful metadata after an hour", async () => {
    vi.useFakeTimers();
    mocks.googleGet.mockResolvedValue({ inputTokenLimit: 1_000_000 });
    const route = { provider: "google" as const, model: "gemini-2.5-pro" as const };
    await resolveModelContextWindow(route);
    vi.advanceTimersByTime(60 * 60_000 + 1);
    await resolveModelContextWindow(route);
    expect(mocks.googleGet).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures or guess a limit when metadata is absent", async () => {
    mocks.googleGet.mockResolvedValueOnce({}).mockResolvedValueOnce({ inputTokenLimit: 123_000 });
    const route = { provider: "google" as const, model: "gemini-flash-latest" as const };
    await expect(resolveModelContextWindow(route)).rejects.toThrow(
      "compaction.contextWindowTokens",
    );
    await expect(resolveModelContextWindow(route)).resolves.toMatchObject({
      contextWindowTokens: 123_000,
    });
    expect(mocks.googleGet).toHaveBeenCalledTimes(2);
  });

  it("preserves other waiters when one caller aborts", async () => {
    let complete!: (value: unknown) => void;
    mocks.googleGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const route = { provider: "google" as const, model: "gemini-2.5-pro" as const };
    const aborted = resolveModelContextWindow(route, { signal: controller.signal });
    const surviving = resolveModelContextWindow(route);
    const failure = expect(aborted).rejects.toThrow("stop");
    controller.abort(new Error("stop"));
    await failure;
    complete({ inputTokenLimit: 500_000 });
    await expect(surviving).resolves.toMatchObject({ contextWindowTokens: 500_000 });
    await resolveModelContextWindow(route);
    expect(mocks.googleGet).toHaveBeenCalledTimes(1);
  });

  it("does not cache a request abandoned by every caller", async () => {
    let complete!: (value: unknown) => void;
    mocks.googleGet
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce({ inputTokenLimit: 500_000 });
    const controller = new AbortController();
    const route = { provider: "google" as const, model: "gemini-2.5-pro" as const };
    const abandoned = resolveModelContextWindow(route, { signal: controller.signal });
    await Promise.resolve();
    const failure = expect(abandoned).rejects.toThrow("stop");
    controller.abort(new Error("stop"));
    await failure;
    complete({ inputTokenLimit: 123_000 });
    await Promise.resolve();
    await expect(resolveModelContextWindow(route)).resolves.toMatchObject({
      contextWindowTokens: 500_000,
    });
    expect(mocks.googleGet).toHaveBeenCalledTimes(2);
  });

  it("uses signed-route Anthropic model input metadata", async () => {
    mocks.anthropicGet.mockResolvedValue({ max_input_tokens: 1_000_000, max_tokens: 128_000 });
    expect(
      await resolveModelContextWindow({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toMatchObject({
      limitType: "input",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
  });

  it("keeps xAI API and subscription discoveries separate and ignores price thresholds", async () => {
    mocks.xaiList
      .mockResolvedValueOnce({ data: [{ id: "grok-4.7", context_length: 2_000_000 }] })
      .mockResolvedValueOnce({ data: [{ id: "grok-4.7", long_context_threshold: 200_000 }] });
    expect(await resolveModelContextWindow({ provider: "xai", model: "grok-4.7" })).toMatchObject({
      contextWindowTokens: 2_000_000,
      limitType: "context",
    });
    await expect(
      resolveModelContextWindow({ provider: "xai", access: "subscription", model: "grok-4.7" }),
    ).rejects.toThrow("No context-window metadata");
    expect(mocks.xaiList).toHaveBeenCalledTimes(2);
  });

  it("uses the Fireworks management model resource", async () => {
    mocks.fireworksGet.mockResolvedValue({ contextLength: 262_144 });
    expect(
      await resolveModelContextWindow({ provider: "fireworks", model: "kimi-k3" }),
    ).toMatchObject({ contextWindowTokens: 262_144, limitType: "context" });
    expect(mocks.fireworksGet.mock.calls[0]?.[0]).toBe(
      "https://api.fireworks.ai/v1/accounts/fireworks/models/kimi-k3",
    );
  });

  it("reads exact model IDs from Vercel metadata", async () => {
    mocks.vercelCatalog.mockResolvedValue([
      { id: "publisher/private-model", contextWindow: 64_000, maxOutputTokens: 8_000 },
    ]);
    expect(
      await resolveModelContextWindow({ provider: "vercel", model: "publisher/private-model" }),
    ).toMatchObject({ contextWindowTokens: 64_000, maxOutputTokens: 8_000 });
  });

  it.each([
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6.1-terra",
    "gpt-6-luna",
  ] as const)("uses verified OpenAI API catalogue values for %s", async (model) => {
    expect(await resolveModelContextWindow({ model })).toMatchObject({
      contextWindowTokens: 1_050_000,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      source: "catalog",
    });
    await expect(
      resolveModelContextWindow({
        provider: "openai",
        access: "subscription",
        model,
      }),
    ).rejects.toThrow("No context-window metadata");
    vi.stubEnv("OPENAI_BASE_URL", "https://private.test/v1");
    await expect(resolveModelContextWindow({ model })).rejects.toThrow(
      "No context-window metadata",
    );
  });

  it("uses exact Gemini catalogue limits when provider metadata omits them", async () => {
    mocks.googleGet.mockResolvedValue({});
    expect(
      await resolveModelContextWindow({ provider: "google", model: "gemini-3.8-flash" }),
    ).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536,
      source: "catalog",
      limitType: "input",
    });
  });

  it.each([
    "gemini-4-argon",
    "gemini-4-neon",
    "gemini-4-hydrogen",
    "gemini-4-carbon",
  ] as const)("uses a unified context window for %s", async (model) => {
    mocks.googleGet.mockResolvedValue({});
    expect(await resolveModelContextWindow({ provider: "google", model })).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxInputTokens: undefined,
      maxOutputTokens: 65_536,
      source: "catalog",
      limitType: "context",
    });
  });

  it("discovers active Codex subscription windows independently of larger opt-in limits", async () => {
    mocks.codexModels.mockResolvedValue([
      { slug: "gpt-6.2-sol", context_window: 500_000, max_context_window: 1_050_000 },
    ]);
    expect(
      await resolveModelContextWindow({
        provider: "openai",
        access: "subscription",
        model: "gpt-6.2-sol",
      }),
    ).toMatchObject({ contextWindowTokens: 500_000, source: "provider", limitType: "context" });
    expect(
      await resolveModelContextWindow({ provider: "openai", model: "gpt-6.2-sol" }),
    ).toMatchObject({ contextWindowTokens: 1_050_000, source: "catalog" });
  });

  it("accepts a validated override without provider discovery", async () => {
    expect(
      await resolveModelContextWindow(
        { provider: "google", model: "gemini-2.5-pro" },
        { contextWindowTokens: 50_000 },
      ),
    ).toMatchObject({ contextWindowTokens: 50_000, source: "override", limitType: "context" });
    expect(mocks.googleGet).not.toHaveBeenCalled();
    await expect(
      resolveModelContextWindow({ model: "gpt-6-luna" }, { contextWindowTokens: Number.NaN }),
    ).rejects.toThrow("positive safe integer");
  });
});
