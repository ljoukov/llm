export const OPENAI_MODEL_IDS = [
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const;

export type OpenAiModelId = (typeof OPENAI_MODEL_IDS)[number];

export function isOpenAiModelId(value: string): value is OpenAiModelId {
  return (OPENAI_MODEL_IDS as readonly string[]).includes(value);
}

export const CHATGPT_MODEL_IDS = [
  "chatgpt-gpt-5.5",
  "chatgpt-gpt-5.5-fast",
  "chatgpt-gpt-5.4",
  "chatgpt-gpt-5.4-fast",
  "chatgpt-gpt-5.4-mini",
  "chatgpt-gpt-5.3-codex-spark",
] as const;

const FAST_MODEL_SUFFIX = "-fast";
const OPENAI_PRIORITY_MODEL_IDS = ["gpt-5.5-fast"] as const;
const CHATGPT_PRIORITY_MODEL_IDS = ["chatgpt-gpt-5.5-fast", "chatgpt-gpt-5.4-fast"] as const;

export const EXPERIMENTAL_CHATGPT_MODEL_PREFIX = "experimental-chatgpt-" as const;

export type ListedChatGptModelId = (typeof CHATGPT_MODEL_IDS)[number];
export type ExperimentalChatGptModelId = `${typeof EXPERIMENTAL_CHATGPT_MODEL_PREFIX}${string}`;
export type ChatGptModelId = ListedChatGptModelId | ExperimentalChatGptModelId;

export function isExperimentalChatGptModelId(value: string): value is ExperimentalChatGptModelId {
  return (
    value.startsWith(EXPERIMENTAL_CHATGPT_MODEL_PREFIX) &&
    value.length > EXPERIMENTAL_CHATGPT_MODEL_PREFIX.length
  );
}

export function isChatGptModelId(value: string): value is ChatGptModelId {
  return (
    (CHATGPT_MODEL_IDS as readonly string[]).includes(value) || isExperimentalChatGptModelId(value)
  );
}

function stripFastSuffix(model: string): string {
  return model.endsWith(FAST_MODEL_SUFFIX) ? model.slice(0, -FAST_MODEL_SUFFIX.length) : model;
}

export function resolveOpenAiProviderModel(model: OpenAiModelId): string {
  return (OPENAI_PRIORITY_MODEL_IDS as readonly string[]).includes(model)
    ? stripFastSuffix(model)
    : model;
}

export function resolveOpenAiServiceTier(model: OpenAiModelId): "priority" | undefined {
  return (OPENAI_PRIORITY_MODEL_IDS as readonly string[]).includes(model) ? "priority" : undefined;
}

export function stripChatGptPrefix(model: ChatGptModelId): string {
  if (isExperimentalChatGptModelId(model)) {
    return model.slice(EXPERIMENTAL_CHATGPT_MODEL_PREFIX.length);
  }
  return model.slice("chatgpt-".length);
}

export function resolveChatGptProviderModel(model: ChatGptModelId): string {
  const providerModel = stripChatGptPrefix(model);
  return (CHATGPT_PRIORITY_MODEL_IDS as readonly string[]).includes(model)
    ? stripFastSuffix(providerModel)
    : providerModel;
}

export function resolveChatGptServiceTier(model: ChatGptModelId): "priority" | undefined {
  return (CHATGPT_PRIORITY_MODEL_IDS as readonly string[]).includes(model) ? "priority" : undefined;
}
