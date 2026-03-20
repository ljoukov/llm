export const OPENAI_MODEL_IDS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"] as const;

export type OpenAiModelId = (typeof OPENAI_MODEL_IDS)[number];

export function isOpenAiModelId(value: string): value is OpenAiModelId {
  return (OPENAI_MODEL_IDS as readonly string[]).includes(value);
}

export const CHATGPT_MODEL_IDS = [
  "chatgpt-gpt-5.4",
  "chatgpt-gpt-5.4-fast",
  "chatgpt-gpt-5.4-mini",
  "chatgpt-gpt-5.3-codex-spark",
] as const;

export type ChatGptModelId = (typeof CHATGPT_MODEL_IDS)[number];

export function isChatGptModelId(value: string): value is ChatGptModelId {
  return (CHATGPT_MODEL_IDS as readonly string[]).includes(value);
}

export function stripChatGptPrefix(model: ChatGptModelId): string {
  return model.slice("chatgpt-".length);
}

export function resolveChatGptProviderModel(model: ChatGptModelId): string {
  switch (model) {
    case "chatgpt-gpt-5.4-fast":
      return "gpt-5.4";
    default:
      return stripChatGptPrefix(model);
  }
}

export function resolveChatGptServiceTier(model: ChatGptModelId): "priority" | undefined {
  return model === "chatgpt-gpt-5.4-fast" ? "priority" : undefined;
}
