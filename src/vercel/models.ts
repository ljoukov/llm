import {
  FIREWORKS_MODEL_IDS,
  type FireworksModelId,
  isFireworksModelId,
} from "../fireworks/models.js";
import { loadLocalEnv } from "../utils/env.js";

/** Provider selection applies to the shared DeepSeek, GLM, and Kimi catalogue. */
export type LlmOpenModelProvider = "vercel" | "fireworks";
export const VERCEL_MODEL_IDS = [
  ...FIREWORKS_MODEL_IDS,
  "reflection/beam-free",
  "nvidia/nemotron-3.5-lightning-free",
  "moonshotai/kimi-k3.1-pro",
  "minimax/minimax-m3",
  "zai/glm-5.3",
] as const;
export type KnownVercelModelId = (typeof VERCEL_MODEL_IDS)[number];
/** Namespaced Gateway IDs are passed through unchanged, including colon suffixes. */
export type VercelModelId = KnownVercelModelId | `${string}/${string}`;

const VERCEL_CANONICAL_MODEL_IDS: Record<FireworksModelId, string> = {
  "deepseek-v4.1-flash-1017": "deepseek/deepseek-v4.1-flash-1017",
  "glm-5.3": "zai/glm-5.3",
  "kimi-k3": "moonshotai/kimi-k3",
};

export function isVercelModelId(value: string): value is VercelModelId {
  if (!value || /\s/.test(value)) return false;
  if (isFireworksModelId(value)) return true;
  return /^[^\s/:]+\/[^\s/]+$/.test(value);
}

export function resolveVercelModelId(model: string): string | undefined {
  if (!isVercelModelId(model)) return undefined;
  return isFireworksModelId(model) ? VERCEL_CANONICAL_MODEL_IDS[model] : model;
}

export function resolveOpenModelProvider(provider?: LlmOpenModelProvider): LlmOpenModelProvider {
  loadLocalEnv();
  const configured = provider ?? process.env.LLM_PROVIDER?.trim();
  if (configured) {
    if (configured === "vercel" || configured === "fireworks") return configured;
    throw new Error(`Unsupported LLM_PROVIDER: ${configured}. Expected vercel or fireworks.`);
  }
  return process.env.VERCEL_AI_GATEWAY_API_KEY?.trim() ? "vercel" : "fireworks";
}
