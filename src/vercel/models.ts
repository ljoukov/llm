import {
  FIREWORKS_MODEL_IDS,
  type FireworksModelId,
  isFireworksModelId,
} from "../fireworks/models.js";
import { loadLocalEnv } from "../utils/env.js";

/** Provider selection applies to the shared DeepSeek, GLM, and Kimi catalogue. */
export type LlmOpenModelProvider = "vercel" | "fireworks";
export const VERCEL_MODEL_IDS = FIREWORKS_MODEL_IDS;
export type VercelModelId = FireworksModelId;

const VERCEL_CANONICAL_MODEL_IDS: Record<VercelModelId, string> = {
  "deepseek-v4.1-flash-1017": "deepseek/deepseek-v4.1-flash-1017",
  "glm-5.3": "zai/glm-5.3",
  "kimi-k3": "moonshotai/kimi-k3",
};

export function isVercelModelId(value: string): value is VercelModelId {
  return isFireworksModelId(value);
}

export function resolveVercelModelId(model: string): string | undefined {
  const id = model.trim();
  return isVercelModelId(id) ? VERCEL_CANONICAL_MODEL_IDS[id] : undefined;
}

export function resolveOpenModelProvider(provider?: LlmOpenModelProvider): LlmOpenModelProvider {
  loadLocalEnv();
  const configured = provider ?? process.env.LLM_PROVIDER?.trim();
  if (configured) {
    if (configured === "vercel" || configured === "fireworks") return configured;
    throw new Error(`Unsupported LLM_PROVIDER: ${configured}. Expected vercel or fireworks.`);
  }
  return process.env.AI_GATEWAY_API_KEY?.trim() ? "vercel" : "fireworks";
}
