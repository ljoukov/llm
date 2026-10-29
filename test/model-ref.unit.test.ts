import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
  model: "gpt-6.1-sol-fast",
} satisfies LlmModelRef;
const _openAiTerraSubscriptionTypes = [
  { provider: "openai", access: "subscription", model: "gpt-6.1-terra" },
  { provider: "openai", access: "subscription", model: "gpt-6.1-terra-fast" },
] as const satisfies readonly LlmModelRef[];
const invalidOpenAiTerraApi = { provider: "openai", model: "gpt-6.1-terra" } as const;
// @ts-expect-error GPT-6.1 Terra is only supported through subscription access.
const _invalidOpenAiTerraApi: LlmModelRef = invalidOpenAiTerraApi;
const invalidOpenAiTerraFastApi = {
  provider: "openai",
  access: "api",
  model: "gpt-6.1-terra-fast",
} as const;
// @ts-expect-error GPT-6.1 Terra Fast is only supported through subscription access.
const _invalidOpenAiTerraFastApi: LlmModelRef = invalidOpenAiTerraFastApi;
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
    model: "gpt-6.1-sol-fast",
  } as const;
  const vercel = { provider: "vercel", model: "reflection/beam-free" } as const;
  const qualifiedModel = "publisher/model" as `${string}/${string}`;
  const invalidQualifiedOpenAi = { provider: "openai", model: qualifiedModel } as const;
  void generateText({ ...api, input });
  void generateText({ ...subscription, input });
  void generateText({ ...vercel, input });
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
  it("defaults explicit providers to API access", () => {
    expect(resolveModelRef({ provider: "openai", model: "gpt-6.1-sol" })).toEqual({
      provider: "openai",
      access: "api",
      model: "gpt-6.1-sol",
    });
  });

  it.each([
    "gpt-6.1-terra",
    "gpt-6.1-terra-fast",
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
      "openai:subscription:gpt-6.1-sol-fast",
      { provider: "openai", access: "subscription", model: "gpt-6.1-sol-fast" },
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
