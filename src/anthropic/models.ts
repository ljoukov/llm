export const ANTHROPIC_MODEL_IDS = ["haiku-5-5", "sonnet-5-5", "opus-5-5", "fable-5-1"] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[number];

const ANTHROPIC_PROVIDER_MODELS = {
  "haiku-5-5": "claude-haiku-5-5",
  "sonnet-5-5": "claude-sonnet-5-5",
  "opus-5-5": "claude-opus-5-5",
  "fable-5-1": "claude-fable-5-1",
} as const satisfies Record<AnthropicModelId, string>;

export type AnthropicProviderModelId = (typeof ANTHROPIC_PROVIDER_MODELS)[AnthropicModelId];

export function isAnthropicModelId(value: string): value is AnthropicModelId {
  return (ANTHROPIC_MODEL_IDS as readonly string[]).includes(value);
}

export function resolveAnthropicProviderModel(model: AnthropicModelId): AnthropicProviderModelId {
  return ANTHROPIC_PROVIDER_MODELS[model];
}
