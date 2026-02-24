import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isChatGptModelId,
  isFireworksModelId,
  isGeminiTextModelId,
  isLlmTextModelId,
  isOpenAiModelId,
  LLM_TEXT_MODEL_IDS,
  loadLocalEnv,
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

export function hasIntegrationCredentialsForModel(model: LlmTextModelId): boolean {
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
  if (isFireworksModelId(model)) {
    return availability.fireworks;
  }

  return false;
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
