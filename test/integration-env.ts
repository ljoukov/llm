import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ANTHROPIC_MODEL_IDS,
  GEMINI_IMAGE_MODEL_IDS,
  GEMINI_TEXT_MODEL_IDS,
  FIREWORKS_MODEL_IDS,
  OPENAI_IMAGE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  OPENAI_SUBSCRIPTION_MODEL_IDS,
  isLlmImageModelId,
  loadLocalEnv,
  parseModelRef,
  resolveModelRef,
  type LlmImageModelRef,
  type LlmModelRef,
  type LlmTextModelRef,
} from "../src/index.js";
import { resolveOpenModelProvider } from "../src/vercel/models.js";
import { getSupportedModelSpeeds, LLM_SPEEDS, type LlmSpeed } from "../src/model-selection.js";

export type IntegrationProviderAvailability = {
  readonly openAi: boolean;
  readonly google: boolean;
  readonly anthropic: boolean;
  readonly anthropicSubscription: boolean;
  readonly fireworks: boolean;
  readonly vercel: boolean;
  readonly openAiSubscription: boolean;
  readonly xai: boolean;
  readonly xaiSubscription: boolean;
};

let availabilityCache: IntegrationProviderAvailability | null = null;

function hasCodexStore(): boolean {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
    return Boolean(doc?.tokens?.access_token && doc?.tokens?.refresh_token);
  } catch {
    return false;
  }
}

export function getIntegrationProviderAvailability(): IntegrationProviderAvailability {
  if (availabilityCache) return availabilityCache;
  loadLocalEnv();
  const tokenProviderUrl = process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL?.trim();
  const tokenProviderKey =
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY?.trim() ||
    process.env.CHATGPT_AUTH_API_KEY?.trim();
  availabilityCache = {
    openAi: Boolean(process.env.OPENAI_API_KEY?.trim()),
    google: Boolean(
      process.env.GEMINI_API_KEY?.trim() ||
        process.env.GOOGLE_API_KEY?.trim() ||
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim(),
    ),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    // Explicit opt-ins assert that the corresponding CLI is installed and logged in.
    anthropicSubscription: process.env.LLM_INTEGRATION_CLAUDE_SUBSCRIPTION?.trim() === "1",
    fireworks: Boolean(
      process.env.FIREWORKS_TOKEN?.trim() || process.env.FIREWORKS_API_KEY?.trim(),
    ),
    vercel: Boolean(process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()),
    openAiSubscription: Boolean((tokenProviderUrl && tokenProviderKey) || hasCodexStore()),
    xai: Boolean(process.env.XAI_API_KEY?.trim()),
    xaiSubscription: process.env.LLM_INTEGRATION_GROK_SUBSCRIPTION?.trim() === "1",
  };
  return availabilityCache;
}

export function integrationModelLabel(ref: LlmModelRef): string {
  return `${ref.provider}:${ref.access ?? "api"}:${ref.model}${ref.speed ? ` speed=${ref.speed}` : ""}`;
}

export function hasIntegrationCredentialsForModel(ref: LlmModelRef): boolean {
  const availability = getIntegrationProviderAvailability();
  switch (ref.provider) {
    case "openai":
      return ref.access === "subscription" ? availability.openAiSubscription : availability.openAi;
    case "anthropic":
      return ref.access === "subscription"
        ? availability.anthropicSubscription
        : availability.anthropic;
    case "google":
      return availability.google;
    case "fireworks":
      return availability.fireworks;
    case "vercel":
      return availability.vercel;
    case "xai":
      return ref.access === "subscription" ? availability.xaiSubscription : availability.xai;
  }
}

function resolveCredentialHintForModel(ref: LlmModelRef): string {
  switch (ref.provider) {
    case "openai":
      return ref.access === "subscription"
        ? "CHATGPT_AUTH_TOKEN_PROVIDER_URL + CHATGPT_AUTH_API_KEY (or CODEX auth store)"
        : "OPENAI_API_KEY";
    case "anthropic":
      return ref.access === "subscription"
        ? "Claude Code subscription login + LLM_INTEGRATION_CLAUDE_SUBSCRIPTION=1"
        : "ANTHROPIC_API_KEY";
    case "google":
      return "GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_SERVICE_ACCOUNT_JSON";
    case "fireworks":
      return "FIREWORKS_TOKEN or FIREWORKS_API_KEY";
    case "vercel":
      return "VERCEL_AI_GATEWAY_API_KEY";
    case "xai":
      return ref.access === "subscription"
        ? "Grok CLI subscription login + LLM_INTEGRATION_GROK_SUBSCRIPTION=1"
        : "XAI_API_KEY";
  }
}

export function assertIntegrationCredentialsForModels(models: readonly LlmModelRef[]): void {
  const missing = models.filter((ref) => !hasIntegrationCredentialsForModel(ref));
  if (!missing.length) return;
  const details = missing.map(
    (ref) => `${integrationModelLabel(ref)} [${resolveCredentialHintForModel(ref)}]`,
  );
  throw new Error(
    `Missing integration credentials for requested models: ${details.join(", ")}. ` +
      "Set the required environment variables or narrow the requested model list.",
  );
}

export function openAiIntegrationModels(): readonly LlmTextModelRef[] {
  return [
    ...OPENAI_MODEL_IDS.map((model) => ({
      provider: "openai" as const,
      access: "api" as const,
      model,
    })),
    ...OPENAI_SUBSCRIPTION_MODEL_IDS.map((model) => ({
      provider: "openai" as const,
      access: "subscription" as const,
      model,
    })),
  ];
}

/** Cross selected base routes with serving speeds without manufacturing model aliases. */
export function openAiIntegrationSpeedVariants(
  models: readonly LlmTextModelRef[],
): readonly LlmTextModelRef[] {
  const rawSpeeds = process.env.LLM_INTEGRATION_SPEEDS?.trim();
  const requestedSpeeds = rawSpeeds
    ? [
        ...new Set(
          rawSpeeds
            .split(",")
            .map((speed) => speed.trim())
            .filter(Boolean),
        ),
      ]
    : undefined;
  if (
    requestedSpeeds?.some((speed) => !(LLM_SPEEDS as readonly string[]).includes(speed)) ||
    requestedSpeeds?.length === 0
  ) {
    throw new Error(
      `LLM_INTEGRATION_SPEEDS must contain standard, fast, or ultrafast; received: ${rawSpeeds}.`,
    );
  }
  const variants = models.flatMap((ref) => {
    const supported = getSupportedModelSpeeds(ref);
    const speeds = requestedSpeeds
      ? supported.filter((speed) => requestedSpeeds.includes(speed))
      : supported;
    return speeds.map((speed: LlmSpeed) => resolveModelRef({ ...ref, speed }) as LlmTextModelRef);
  });
  if (!variants.length) {
    throw new Error(
      "LLM_INTEGRATION_SPEEDS selected no supported speeds for the requested OpenAI routes.",
    );
  }
  return variants;
}

function parseRequestedModels(raw: string): readonly LlmModelRef[] {
  const unique = new Map<string, LlmModelRef>();
  for (const selector of raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const ref = selector.includes(":")
      ? parseModelRef(selector)
      : (resolveModelRef({ model: selector }) as LlmModelRef);
    unique.set(integrationModelLabel(ref), ref);
  }
  if (!unique.size) throw new Error("Integration model selectors must contain at least one model.");
  return [...unique.values()];
}

export function resolveIntegrationRequestedModels(): readonly LlmTextModelRef[] {
  const raw = process.env.LLM_INTEGRATION_MODELS?.trim();
  const refs: readonly LlmModelRef[] = raw
    ? parseRequestedModels(raw)
    : [
        ...openAiIntegrationModels(),
        ...ANTHROPIC_MODEL_IDS.flatMap((model) => [
          { provider: "anthropic" as const, access: "api" as const, model },
          { provider: "anthropic" as const, access: "subscription" as const, model },
        ]),
        ...GEMINI_TEXT_MODEL_IDS.map((model) => ({ provider: "google" as const, model })),
        ...FIREWORKS_MODEL_IDS.map((model) => ({ provider: resolveOpenModelProvider(), model })),
      ];
  const images = refs.filter((ref) => isLlmImageModelId(ref.model));
  if (images.length)
    throw new Error(
      `LLM_INTEGRATION_MODELS requires text models: ${images.map(integrationModelLabel).join(", ")}`,
    );
  return refs as readonly LlmTextModelRef[];
}

export function resolveIntegrationRequestedImageModels(): readonly LlmImageModelRef[] {
  const raw = process.env.LLM_INTEGRATION_IMAGE_MODELS?.trim();
  const refs: readonly LlmModelRef[] = raw
    ? parseRequestedModels(raw)
    : [
        ...OPENAI_IMAGE_MODEL_IDS.flatMap((model) => [
          { provider: "openai" as const, access: "api" as const, model },
          { provider: "openai" as const, access: "subscription" as const, model },
        ]),
        ...GEMINI_IMAGE_MODEL_IDS.map((model) => ({ provider: "google" as const, model })),
      ];
  const text = refs.filter((ref) => !isLlmImageModelId(ref.model));
  if (text.length)
    throw new Error(
      `LLM_INTEGRATION_IMAGE_MODELS requires image models: ${text.map(integrationModelLabel).join(", ")}`,
    );
  return refs as readonly LlmImageModelRef[];
}

export function hasCanonicalFilesBackend(): boolean {
  loadLocalEnv();
  const bucket =
    process.env.LLM_FILES_GCS_BUCKET?.trim() ||
    process.env.VERTEX_GCS_BUCKET?.trim() ||
    process.env.LLM_VERTEX_GCS_BUCKET?.trim();
  return Boolean(bucket && process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim());
}
