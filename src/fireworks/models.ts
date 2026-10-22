// Direct serverless LLM catalogue verified against app.fireworks.ai/models and the
// authenticated inference /models endpoint on 2026-10-22. Routers and non-LLMs are excluded.
export const FIREWORKS_MODEL_IDS = ["deepseek-v4.1-flash-1017", "glm-5.3", "kimi-k3"] as const;

export type FireworksModelId = (typeof FIREWORKS_MODEL_IDS)[number];

export const FIREWORKS_DEFAULT_DEEPSEEK_MODEL: FireworksModelId = "deepseek-v4.1-flash-1017";
export const FIREWORKS_DEFAULT_KIMI_MODEL: FireworksModelId = "kimi-k3";
export const FIREWORKS_DEFAULT_GLM_MODEL: FireworksModelId = "glm-5.3";

const FIREWORKS_CANONICAL_MODEL_IDS: Record<FireworksModelId, string> = {
  "deepseek-v4.1-flash-1017": "accounts/fireworks/models/deepseek-v4p1-flash-1017",
  "glm-5.3": "accounts/fireworks/models/glm-5p3",
  "kimi-k3": "accounts/fireworks/models/kimi-k3",
};

export function isFireworksModelId(value: string): value is FireworksModelId {
  return (FIREWORKS_MODEL_IDS as readonly string[]).includes(value.trim());
}

export function resolveFireworksModelId(model: string): string | undefined {
  const trimmed = model.trim();
  if (!isFireworksModelId(trimmed)) {
    return undefined;
  }
  return FIREWORKS_CANONICAL_MODEL_IDS[trimmed];
}
