export const CLAUDE_MODEL_IDS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODEL_IDS)[number];

export function isClaudeModelId(value: string): value is ClaudeModelId {
  return (CLAUDE_MODEL_IDS as readonly string[]).includes(value);
}

export function resolveClaudeProviderModel(model: ClaudeModelId): ClaudeModelId {
  return model;
}
