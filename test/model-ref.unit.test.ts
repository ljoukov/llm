import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getSupportedModelSpeeds, isRemovedServingAlias } from "../src/model-selection.js";
import { OPENAI_MODEL_IDS } from "../src/openai/models.js";

import {
  generateText,
  generateJson,
  runToolLoop,
  runAgentLoop,
  generateImages,
  isQualifiedVercelModelId,
  parseModelRef,
  resolveModelRef,
  type LlmModelRef,
  type LlmTextModelSelection,
} from "../src/index.js";

const _knownVercelType = {
  provider: "vercel",
  model: "glm-5.3",
} satisfies LlmModelRef;
const _futureVercelType = {
  provider: "vercel",
  model: "publisher/future-model:free",
} satisfies LlmModelRef;
const _openAiApiType = {
  provider: "openai",
  model: "gpt-5.6",
} satisfies LlmModelRef;
const _openAiSubscriptionType = {
  provider: "openai",
  access: "subscription",
  model: "gpt-6.1-sol",
  speed: "fast",
} satisfies LlmModelRef;
const _openAiTerraSubscriptionTypes = [
  { provider: "openai", access: "subscription", model: "gpt-6.1-terra" },
  { provider: "openai", access: "subscription", model: "gpt-6.1-terra", speed: "fast" },
] as const satisfies readonly LlmModelRef[];
const invalidOpenAiTerraApi = { provider: "openai", model: "gpt-6.1-terra" } as const;
// @ts-expect-error GPT-6.1 Terra is only supported through subscription access.
const _invalidOpenAiTerraApi: LlmModelRef = invalidOpenAiTerraApi;
const invalidOpenAiFastAlias = {
  provider: "openai",
  access: "subscription",
  model: "gpt-6.1-sol-fast",
} as const;
// @ts-expect-error Synthetic -fast aliases have been removed on every route.
const _invalidOpenAiFastAlias: LlmModelRef = invalidOpenAiFastAlias;
const _anthropicSubscriptionType = {
  provider: "anthropic",
  access: "subscription",
  model: "claude-sonnet-5-5",
} satisfies LlmModelRef;
const _xaiSubscriptionType = {
  provider: "xai",
  access: "subscription",
  model: "grok-latest-future-model",
} satisfies LlmModelRef;
const _qualifiedSubscriptionType = {
  model: "openai:subscription:gpt-6.1-sol",
  speed: "fast",
} satisfies LlmTextModelSelection;
const _qualifiedMatchingRouteType = {
  provider: "openai",
  access: "subscription",
  model: "openai:subscription:gpt-6.1-sol",
  speed: "ultrafast",
} satisfies LlmTextModelSelection;
const invalidQualifiedApi = { model: "openai:api:gpt-arbitrary" } as const;
// @ts-expect-error A qualified string does not open the OpenAI model allowlist.
const _invalidQualifiedApi: LlmTextModelSelection = invalidQualifiedApi;
const conflictingQualifiedRoute = {
  model: "openai:subscription:gpt-6.1-sol",
  access: "api",
} as const;
// @ts-expect-error Qualified strings and explicit route fields must agree.
const _conflictingQualifiedRoute: LlmTextModelSelection = conflictingQualifiedRoute;
const invalidSpeed = { provider: "openai", model: "gpt-6.1-sol", speed: "turbo" } as const;
// @ts-expect-error Serving speeds are a closed literal union.
const _invalidSpeed: LlmTextModelSelection = invalidSpeed;

const invalidUnqualifiedVercel = { provider: "vercel", model: "future-model" } as const;
// @ts-expect-error Arbitrary Vercel IDs must include the publisher/model slash.
const _invalidUnqualifiedVercel: LlmModelRef = invalidUnqualifiedVercel;
const invalidOpenAiApi = { provider: "openai", model: "gpt-arbitrary" } as const;
// @ts-expect-error OpenAI API models retain a closed allowlist.
const _invalidOpenAiApi: LlmModelRef = invalidOpenAiApi;
const invalidOpenAiSubscription = {
  provider: "openai",
  access: "subscription",
  model: "gpt-5.6",
} as const;
// @ts-expect-error The API-only gpt-5.6 route cannot be used through subscription access.
const _invalidOpenAiSubscription: LlmModelRef = invalidOpenAiSubscription;
const invalidGoogleSubscription = {
  provider: "google",
  access: "subscription",
  model: "gemini-4-argon",
} as const;
// @ts-expect-error Google subscription access is not supported.
const _invalidGoogleSubscription: LlmModelRef = invalidGoogleSubscription;
const invalidProvider = { provider: "grok", model: "grok-latest" } as const;
// @ts-expect-error Canonical provider names are a closed allowlist.
const _invalidProvider: LlmModelRef = invalidProvider;
const invalidImplicitSubscription = { access: "subscription", model: "gpt-6.1-sol" } as const;
// @ts-expect-error Subscription selections must identify their provider explicitly.
const _invalidImplicitSubscription: LlmTextModelSelection = invalidImplicitSubscription;
const invalidLegacyOpenAi = {
  provider: "openai",
  access: "subscription",
  model: "chatgpt-gpt-6.1-sol",
} as const;
// @ts-expect-error chatgpt-* model aliases are removed.
const _invalidLegacyOpenAi: LlmModelRef = invalidLegacyOpenAi;
const invalidLegacyAnthropic = { provider: "anthropic", model: "sonnet-5-5" } as const;
// @ts-expect-error Native Anthropic IDs include the claude- prefix on both routes.
const _invalidLegacyAnthropic: LlmModelRef = invalidLegacyAnthropic;

// This function is checked by tsc and deliberately never invoked.
function _checkPublicRequestTypes(): void {
  const input = "Hello";
  const tools = {};
  const schema = z.object({ ok: z.boolean() });
  const api = { provider: "openai", model: "gpt-5.6" } as const;
  const subscription = {
    provider: "openai",
    access: "subscription",
    model: "gpt-6.1-sol",
    speed: "fast",
  } as const;
  const vercel = { provider: "vercel", model: "reflection/beam-free" } as const;
  const qualifiedModel = "publisher/model" as `${string}/${string}`;
  const invalidQualifiedOpenAi = { provider: "openai", model: qualifiedModel } as const;
  void generateText({ ...api, input });
  void generateText({ ...subscription, input });
  void generateText({ ...vercel, input });
  void generateText({ model: "openai:subscription:gpt-6.1-sol", speed: "fast", input });
  // @ts-expect-error Invalid providers must not be widened by the request type.
  void generateText({ ...invalidProvider, input });
  // @ts-expect-error OpenAI API model allowlists apply at every entrypoint.
  void generateText({ ...invalidOpenAiApi, input });
  // @ts-expect-error Provider and access remain correlated at every entrypoint.
  void generateText({ ...invalidGoogleSubscription, input });
  // @ts-expect-error Qualified passthrough IDs are limited to Vercel.
  void generateText({ ...invalidQualifiedOpenAi, input });
  void generateJson({ ...api, input, schema });
  void generateJson({ ...subscription, input, schema });
  void generateJson({ ...vercel, input, schema });
  void generateJson({ model: "openai:subscription:gpt-6.1-sol", speed: "fast", input, schema });
  // @ts-expect-error Invalid providers must not be widened by the request type.
  void generateJson({ ...invalidProvider, input, schema });
  // @ts-expect-error OpenAI API model allowlists apply at every entrypoint.
  void generateJson({ ...invalidOpenAiApi, input, schema });
  // @ts-expect-error Provider and access remain correlated at every entrypoint.
  void generateJson({ ...invalidGoogleSubscription, input, schema });
  // @ts-expect-error Qualified passthrough IDs are limited to Vercel.
  void generateJson({ ...invalidQualifiedOpenAi, input, schema });
  void runToolLoop({ ...api, input, tools });
  void runToolLoop({ ...subscription, input, tools });
  void runToolLoop({ ...vercel, input, tools });
  void runToolLoop({ model: "openai:subscription:gpt-6.1-sol", speed: "fast", input, tools });
  // @ts-expect-error Invalid providers must not be widened by the request type.
  void runToolLoop({ ...invalidProvider, input, tools });
  // @ts-expect-error OpenAI API model allowlists apply at every entrypoint.
  void runToolLoop({ ...invalidOpenAiApi, input, tools });
  // @ts-expect-error Provider and access remain correlated at every entrypoint.
  void runToolLoop({ ...invalidGoogleSubscription, input, tools });
  // @ts-expect-error Qualified passthrough IDs are limited to Vercel.
  void runToolLoop({ ...invalidQualifiedOpenAi, input, tools });
  void runAgentLoop({ ...api, input, tools });
  void runAgentLoop({ ...subscription, input, tools });
  void runAgentLoop({ ...vercel, input, tools });
  void runAgentLoop({ model: "openai:subscription:gpt-6.1-sol", speed: "fast", input, tools });
  for (const model of [
    "openai:subscription:gpt-6.1-sol",
    "openai:api:gpt-6-astra",
    "anthropic:api:claude-opus-5-5",
  ] as const) {
    const selection = { model, speed: "fast" } satisfies LlmTextModelSelection;
    void generateText({ ...selection, input });
    void runToolLoop({ ...selection, input, tools });
  }
  // @ts-expect-error Invalid providers must not be widened by the request type.
  void runAgentLoop({ ...invalidProvider, input, tools });
  // @ts-expect-error OpenAI API model allowlists apply at every entrypoint.
  void runAgentLoop({ ...invalidOpenAiApi, input, tools });
  // @ts-expect-error Provider and access remain correlated at every entrypoint.
  void runAgentLoop({ ...invalidGoogleSubscription, input, tools });
  // @ts-expect-error Qualified passthrough IDs are limited to Vercel.
  void runAgentLoop({ ...invalidQualifiedOpenAi, input, tools });
  const image = { model: "gpt-image-2", stylePrompt: "", imagePrompts: ["A blue square"] } as const;
  void generateImages({ ...image, provider: "openai" });
  void generateImages({ ...image, provider: "openai", access: "subscription" });
  void generateImages({ ...image, model: "openai:subscription:gpt-image-2" });
  const invalidImageProvider = { ...image, provider: "vercel" } as const;
  // @ts-expect-error Image generation does not accept unsupported providers.
  void generateImages(invalidImageProvider);
  const invalidImageModel = { ...image, provider: "openai", model: "publisher/model" } as const;
  // @ts-expect-error OpenAI image models retain their closed allowlist.
  void generateImages(invalidImageModel);
  const invalidImageAccess = {
    ...image,
    provider: "google",
    access: "subscription",
    model: "gemini-3-pro-image-preview",
  } as const;
  // @ts-expect-error Google images do not support subscription access.
  void generateImages(invalidImageAccess);
}

const implicitExperimental = { model: "experimental-chatgpt-private-model" } as const;
// @ts-expect-error Experimental subscription models require an explicit provider and access mode.
const _invalidImplicitExperimental: LlmTextModelSelection = implicitExperimental;

const originalGatewayKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
const originalProvider = process.env.LLM_PROVIDER;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalGatewayKey === undefined) delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  else process.env.VERCEL_AI_GATEWAY_API_KEY = originalGatewayKey;
  if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = originalProvider;
});

describe("model references", () => {
  it("normalizes qualified and structured selections identically with independent speed", () => {
    const expected = {
      provider: "openai",
      access: "subscription",
      model: "gpt-6.1-sol",
      speed: "fast",
    } as const;
    expect(resolveModelRef(expected)).toEqual(expected);
    expect(resolveModelRef({ model: "openai:subscription:gpt-6.1-sol", speed: "fast" })).toEqual(
      expected,
    );
    expect(resolveModelRef({ ...expected, model: "openai:subscription:gpt-6.1-sol" })).toEqual(
      expected,
    );
  });

  it("preserves omitted speed and explicit standard as different selections", () => {
    const selection = { provider: "openai", model: "gpt-6.1-sol" } as const;
    expect(resolveModelRef(selection)).not.toHaveProperty("speed");
    expect(resolveModelRef({ ...selection, speed: "standard" })).toMatchObject({
      speed: "standard",
    });
  });

  it("preserves provider-native colons when resolving direct qualified strings", () => {
    expect(
      resolveModelRef({ model: "vercel:api:publisher/model:variant:free", speed: "standard" }),
    ).toEqual({
      provider: "vercel",
      access: "api",
      model: "publisher/model:variant:free",
      speed: "standard",
    });
    expect(
      resolveModelRef({ provider: "vercel", model: "publisher/model:variant:free" }),
    ).toMatchObject({
      model: "publisher/model:variant:free",
    });
  });

  it.each([
    { model: "openai:subscription:gpt-6.1-sol", provider: "anthropic" },
    { model: "openai:subscription:gpt-6.1-sol", access: "api" },
    { model: "openai:api:gpt-arbitrary" },
    { model: "openai:subscription:chatgpt-gpt-6.1-sol" },
    { model: "openai:subscription:gpt-6.1-sol-fast" },
    { model: "openai:subscription:" },
    { model: "openai:token:gpt-6.1-sol" },
  ])("rejects contradictory or unsupported direct qualified selection %j", (selection) => {
    expect(() => resolveModelRef(selection as never)).toThrow();
  });

  it.each([
    { provider: "openai", model: "gpt-6.1-sol", speed: "turbo" },
    { provider: "openai", model: "gpt-6-luna", speed: "ultrafast" },
    { provider: "openai", access: "subscription", model: "gpt-6.1-terra", speed: "ultrafast" },
    {
      provider: "openai",
      access: "subscription",
      model: "experimental-chatgpt-private-model",
      speed: "fast",
    },
    { provider: "anthropic", model: "claude-sonnet-5-5", speed: "fast" },
    { provider: "anthropic", model: "claude-opus-5-5", speed: "ultrafast" },
    { provider: "google", model: "gemini-4-argon", speed: "fast" },
    { provider: "fireworks", model: "glm-5.3", speed: "fast" },
    { provider: "xai", model: "grok-4.7", speed: "fast" },
    { provider: "openai", model: "gpt-image-2", speed: "standard" },
    { provider: "vercel", model: "publisher/model", speed: "fast" },
    { provider: "vercel", model: "glm-5.3", speed: "fast" },
    { provider: "vercel", model: "anthropic/claude-sonnet-5-5", speed: "fast" },
    { provider: "vercel", model: "openai/gpt-6.1-terra", speed: "fast" },
    { provider: "vercel", model: "openai/gpt-6.1-sol", speed: "ultrafast" },
    { provider: "vercel", model: "openai/gpt-image-2", speed: "standard" },
    { provider: "vercel", model: "google/gemini-3-pro-image-preview", speed: "standard" },
  ])("rejects unsupported serving speeds before transport: %j", (selection) => {
    expect(() => resolveModelRef(selection as never)).toThrow("speed");
  });

  it("exposes route-specific speed capabilities without synthetic model entries", () => {
    expect(getSupportedModelSpeeds({ provider: "openai", model: "gpt-6.1-sol" })).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
    expect(
      getSupportedModelSpeeds({
        provider: "openai",
        access: "subscription",
        model: "gpt-6.1-terra",
      }),
    ).toEqual(["standard", "fast"]);
    expect(getSupportedModelSpeeds({ provider: "anthropic", model: "claude-opus-5-5" })).toEqual([
      "standard",
      "fast",
    ]);
    expect(getSupportedModelSpeeds({ provider: "anthropic", model: "claude-sonnet-5-5" })).toEqual([
      "standard",
    ]);
    expect(getSupportedModelSpeeds({ provider: "vercel", model: "publisher/model" })).toEqual([
      "standard",
    ]);
    expect(getSupportedModelSpeeds({ provider: "vercel", model: "openai/gpt-image-2" })).toEqual(
      [],
    );
    expect(getSupportedModelSpeeds({ provider: "openai", model: "gpt-image-2" })).toEqual([]);
    expect(
      resolveModelRef({ provider: "anthropic", model: "claude-opus-5-5", speed: "fast" }),
    ).toMatchObject({ speed: "fast" });
  });

  it("permits Vercel fast only for documented OpenAI base routes and Claude Opus 5.5", () => {
    for (const model of [
      ...OPENAI_MODEL_IDS.map((id) => `openai/${id}`),
      "anthropic/claude-opus-5-5",
    ]) {
      expect(getSupportedModelSpeeds({ provider: "vercel", model })).toEqual(["standard", "fast"]);
      expect(resolveModelRef({ provider: "vercel", model, speed: "fast" })).toMatchObject({
        model,
        speed: "fast",
      });
    }
  });

  it.each([
    "openai/gpt-6.1-sol-fast",
    "openai/gpt-6.1-terra-fast",
    "openai/chatgpt-gpt-6.1-sol",
    "anthropic/claude-opus-5-5-fast",
    "anthropic/claude-sonnet-5-5-fast",
    "anthropic/claude-opus-5-fast",
  ])("rejects known removed Gateway serving aliases without rewriting: %s", (model) => {
    expect(isRemovedServingAlias(model)).toBe(true);
    expect(() => resolveModelRef({ provider: "vercel", model })).toThrow("Removed model alias");
    expect(() => resolveModelRef({ model: `vercel:api:${model}` })).toThrow("Removed model alias");
    expect(getSupportedModelSpeeds({ provider: "vercel", model })).toEqual([]);
  });

  it("preserves unrelated native fast names and experimental private model suffixes", () => {
    for (const model of ["publisher/model-fast", "openai/future-native-model-fast"]) {
      expect(isRemovedServingAlias(model)).toBe(false);
      expect(resolveModelRef({ provider: "vercel", model })).toMatchObject({ model });
    }
    const model = "experimental-chatgpt-private-model-fast";
    expect(isRemovedServingAlias(model)).toBe(false);
    expect(resolveModelRef({ provider: "openai", access: "subscription", model })).toMatchObject({
      model,
    });
    expect(isRemovedServingAlias("chatgpt-gpt-image-2")).toBe(true);
    expect(isRemovedServingAlias("gpt-6.1-sol-fast")).toBe(true);
  });

  it("defaults explicit providers to API access", () => {
    expect(resolveModelRef({ provider: "openai", model: "gpt-6.1-sol" })).toEqual({
      provider: "openai",
      access: "api",
      model: "gpt-6.1-sol",
    });
  });

  it.each([
    "gpt-6.1-terra",
  ] as const)("resolves %s only with explicit OpenAI subscription access", (model) => {
    const ref = { provider: "openai", access: "subscription", model } as const;
    expect(resolveModelRef(ref)).toEqual(ref);
    expect(parseModelRef(`openai:subscription:${model}`)).toEqual(ref);
    expect(() => resolveModelRef({ provider: "openai", access: "api", model } as never)).toThrow();
    expect(() => resolveModelRef({ provider: "openai", model } as never)).toThrow();
    expect(() => resolveModelRef({ model } as never)).toThrow();
  });

  it("keeps explicit providers authoritative over environment preferences", () => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-gateway-key");
    vi.stubEnv("LLM_PROVIDER", "vercel");
    expect(resolveModelRef({ provider: "fireworks", model: "glm-5.3" })).toEqual({
      provider: "fireworks",
      access: "api",
      model: "glm-5.3",
    });
    expect(
      resolveModelRef({ provider: "openai", access: "subscription", model: "gpt-6.1-sol" }),
    ).toEqual({
      provider: "openai",
      access: "subscription",
      model: "gpt-6.1-sol",
    });
  });

  it("prefers a configured Vercel key for automatic open model selection", () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-gateway-key");
    expect(resolveModelRef({ model: "glm-5.3" })).toEqual({
      provider: "vercel",
      access: "api",
      model: "glm-5.3",
    });
  });

  it("uses canonical native provider IDs for automatic closed catalogue selection", () => {
    expect(resolveModelRef({ model: "gpt-6.1-sol" })).toMatchObject({
      provider: "openai",
      access: "api",
    });
    expect(resolveModelRef({ model: "claude-sonnet-5-5" })).toMatchObject({
      provider: "anthropic",
      access: "api",
    });
    expect(resolveModelRef({ model: "gemini-4-argon" })).toMatchObject({
      provider: "google",
      access: "api",
    });
  });

  it("passes future namespaced Vercel IDs through unchanged", () => {
    const model = "future-publisher/future-model:free";
    expect(isQualifiedVercelModelId(model)).toBe(true);
    expect(resolveModelRef({ provider: "vercel", model })).toEqual({
      provider: "vercel",
      access: "api",
      model,
    });
    expect(() => resolveModelRef({ model })).toThrow('provider: "vercel"');
  });

  it.each([
    "",
    "/",
    "publisher/",
    "/model",
    "publisher//model",
    "publisher/model/extra",
    "publisher /model",
    "publisher/model ",
    "publisher/model\n",
  ])("rejects malformed qualified Vercel ID %j at runtime", (model) => {
    expect(isQualifiedVercelModelId(model)).toBe(false);
    expect(() => resolveModelRef({ provider: "vercel", model })).toThrow();
  });

  it.each([
    { provider: "openai", access: "api", model: "gpt-arbitrary" },
    { provider: "openai", access: "api", model: "publisher/model" },
    { provider: "openai", access: "subscription", model: "publisher/model" },
    { provider: "openai", access: "subscription", model: "gpt-arbitrary" },
    { provider: "openai", access: "subscription", model: "gpt-5.6" },
    { provider: "openai", access: "api", model: "experimental-chatgpt-private-model" },
    { provider: "openai", access: "subscription", model: "chatgpt-gpt-6.1-sol" },
    { provider: "anthropic", access: "api", model: "sonnet-5-5" },
    { provider: "google", access: "subscription", model: "gemini-4-argon" },
    { provider: "fireworks", access: "subscription", model: "glm-5.3" },
    { provider: "vercel", access: "subscription", model: "reflection/beam-free" },
    { access: "subscription", model: "gpt-6.1-sol" },
    { model: "experimental-chatgpt-private-model" },
    { provider: "claude", access: "api", model: "claude-sonnet-5-5" },
    { provider: "openai", access: "token", model: "gpt-6.1-sol" },
  ])("rejects unsupported selections without selecting an alternative route: %j", (selection) => {
    expect(() => resolveModelRef(selection as never)).toThrow();
  });

  it("retains experimental subscription IDs only on the explicit subscription route", () => {
    expect(
      resolveModelRef({
        provider: "openai",
        access: "subscription",
        model: "experimental-chatgpt-private-model",
      }),
    ).toEqual({
      provider: "openai",
      access: "subscription",
      model: "experimental-chatgpt-private-model",
    });
  });

  it("uses the same native Anthropic model ID for API and subscription access", () => {
    for (const access of ["api", "subscription"] as const) {
      expect(
        resolveModelRef({ provider: "anthropic", access, model: "claude-sonnet-5-5" }),
      ).toEqual({
        provider: "anthropic",
        access,
        model: "claude-sonnet-5-5",
      });
    }
  });

  it.each([
    [
      "vercel:api:reflection/beam-free",
      { provider: "vercel", access: "api", model: "reflection/beam-free" },
    ],
    [
      "openai:subscription:gpt-6.1-sol",
      { provider: "openai", access: "subscription", model: "gpt-6.1-sol" },
    ],
    [
      "xai:subscription:grok-build-0.1",
      { provider: "xai", access: "subscription", model: "grok-build-0.1" },
    ],
    [
      "vercel:api:publisher/model:variant:free",
      { provider: "vercel", access: "api", model: "publisher/model:variant:free" },
    ],
  ])("parses %s and preserves colons inside model IDs", (slug, expected) => {
    expect(parseModelRef(slug)).toEqual(expected);
  });

  it.each([
    "",
    "gpt-6.1-sol",
    "openai:gpt-6.1-sol",
    "openai::gpt-6.1-sol",
    "openai:api:",
    ":api:gpt-6.1-sol",
    "openai:token:gpt-6.1-sol",
    "grok:api:grok-latest",
    "openai:api:gpt-arbitrary",
  ])("rejects malformed or unsupported string reference %j", (slug) =>
    expect(() => parseModelRef(slug)).toThrow());
});
