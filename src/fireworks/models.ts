export const FIREWORKS_MODEL_IDS = ["kimi-k2.5", "glm-5"] as const;

export type FireworksModelId = (typeof FIREWORKS_MODEL_IDS)[number];

export const FIREWORKS_DEFAULT_KIMI_MODEL: FireworksModelId = "kimi-k2.5";
export const FIREWORKS_DEFAULT_GLM_MODEL: FireworksModelId = "glm-5";

const FIREWORKS_CANONICAL_MODEL_IDS: Record<FireworksModelId, string> = {
  "kimi-k2.5": "accounts/fireworks/models/kimi-k2p5",
  "glm-5": "accounts/fireworks/models/glm-5",
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
