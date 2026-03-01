import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isChatGptModelId,
  isFireworksModelId,
  isGeminiImageModelId,
  isGeminiTextModelId,
  isLlmImageModelId,
  isLlmTextModelId,
  isOpenAiModelId,
  LLM_IMAGE_MODEL_IDS,
  LLM_TEXT_MODEL_IDS,
  loadLocalEnv,
  type LlmImageModelId,
  type LlmTextModelId,
} from "../src/index.js";

export type IntegrationProviderAvailability = {
  readonly openAi: boolean;
  readonly gemini: boolean;
  readonly fireworks: boolean;
  readonly chatGpt: boolean;
};

let availabilityCache: IntegrationProviderAvailability | null = null;

function hasCodexStore(): boolean {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const doc = JSON.parse(raw) as any;
    const tokens = doc?.tokens;
    return Boolean(tokens?.access_token && tokens?.refresh_token);
  } catch {
    return false;
  }
}

export function getIntegrationProviderAvailability(): IntegrationProviderAvailability {
  if (availabilityCache) {
    return availabilityCache;
  }

  loadLocalEnv();

  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim());
  const hasFireworks = Boolean(
    process.env.FIREWORKS_TOKEN?.trim() || process.env.FIREWORKS_API_KEY?.trim(),
  );
  const tokenProviderUrl = process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL?.trim();
  const tokenProviderKey =
    process.env.CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY?.trim() ||
    process.env.CHATGPT_AUTH_API_KEY?.trim();
  const hasChatGpt = Boolean((tokenProviderUrl && tokenProviderKey) || hasCodexStore());

  availabilityCache = {
    openAi: hasOpenAi,
    gemini: hasGemini,
    fireworks: hasFireworks,
    chatGpt: hasChatGpt,
  };

  return availabilityCache;
}

export function hasIntegrationCredentialsForModel(
  model: LlmTextModelId | LlmImageModelId,
): boolean {
  const availability = getIntegrationProviderAvailability();

  if (isOpenAiModelId(model)) {
    return availability.openAi;
  }
  if (isChatGptModelId(model)) {
    return availability.chatGpt;
  }
  if (isGeminiTextModelId(model)) {
    return availability.gemini;
  }
  if (isGeminiImageModelId(model)) {
    return availability.gemini;
  }
  if (isFireworksModelId(model)) {
    return availability.fireworks;
  }

  return false;
}

function resolveCredentialHintForModel(model: LlmTextModelId | LlmImageModelId): string {
  if (isOpenAiModelId(model)) {
    return "OPENAI_API_KEY";
  }
  if (isChatGptModelId(model)) {
    return "CHATGPT_AUTH_TOKEN_PROVIDER_URL + CHATGPT_AUTH_API_KEY (or CODEX auth store)";
  }
  if (isGeminiTextModelId(model) || isGeminiImageModelId(model)) {
    return "GOOGLE_SERVICE_ACCOUNT_JSON";
  }
  if (isFireworksModelId(model)) {
    return "FIREWORKS_TOKEN or FIREWORKS_API_KEY";
  }
  return "unknown credentials";
}

export function assertIntegrationCredentialsForModels(
  models: readonly (LlmTextModelId | LlmImageModelId)[],
): void {
  const missing = models.filter((model) => !hasIntegrationCredentialsForModel(model));
  if (missing.length === 0) {
    return;
  }
  const details = missing.map((model) => `${model} [${resolveCredentialHintForModel(model)}]`);
  throw new Error(
    `Missing integration credentials for requested models: ${details.join(", ")}. ` +
      "Set the required environment variables or narrow the requested model list.",
  );
}

export function resolveIntegrationRequestedModels(): readonly LlmTextModelId[] {
  const raw = process.env.LLM_INTEGRATION_MODELS?.trim();
  if (!raw) {
    return LLM_TEXT_MODEL_IDS;
  }

  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const invalid = parsed.filter((entry) => !isLlmTextModelId(entry));
  if (invalid.length > 0) {
    throw new Error(
      `LLM_INTEGRATION_MODELS contains unsupported model ids: ${invalid.join(", ")}. ` +
        `Allowed: ${LLM_TEXT_MODEL_IDS.join(", ")}`,
    );
  }

  return [...new Set(parsed)] as readonly LlmTextModelId[];
}

export function resolveIntegrationRequestedImageModels(): readonly LlmImageModelId[] {
  const raw = process.env.LLM_INTEGRATION_IMAGE_MODELS?.trim();
  if (!raw) {
    return LLM_IMAGE_MODEL_IDS;
  }

  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const invalid = parsed.filter((entry) => !isLlmImageModelId(entry));
  if (invalid.length > 0) {
    throw new Error(
      `LLM_INTEGRATION_IMAGE_MODELS contains unsupported model ids: ${invalid.join(", ")}. ` +
        `Allowed: ${LLM_IMAGE_MODEL_IDS.join(", ")}`,
    );
  }

  return [...new Set(parsed)] as readonly LlmImageModelId[];
}
