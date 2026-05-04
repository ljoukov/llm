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

export const OPENAI_IMAGE_MODEL_IDS = ["gpt-image-2"] as const;
export type OpenAiImageModelId = (typeof OPENAI_IMAGE_MODEL_IDS)[number];

export function isOpenAiImageModelId(value: string): value is OpenAiImageModelId {
  return (OPENAI_IMAGE_MODEL_IDS as readonly string[]).includes(value);
}

export const CHATGPT_IMAGE_MODEL_IDS = ["chatgpt-gpt-image-2"] as const;
export type ChatGptImageModelId = (typeof CHATGPT_IMAGE_MODEL_IDS)[number];

export function isChatGptImageModelId(value: string): value is ChatGptImageModelId {
  return (CHATGPT_IMAGE_MODEL_IDS as readonly string[]).includes(value);
}

export const OPENAI_GPT_IMAGE_2_POPULAR_RESOLUTIONS = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
export type OpenAiGptImage2PopularResolution =
  (typeof OPENAI_GPT_IMAGE_2_POPULAR_RESOLUTIONS)[number];

export const OPENAI_GPT_IMAGE_2_AUTO_RESOLUTION = "auto" as const;

export const OPENAI_GPT_IMAGE_2_RESOLUTIONS = [
  ...OPENAI_GPT_IMAGE_2_POPULAR_RESOLUTIONS,
  OPENAI_GPT_IMAGE_2_AUTO_RESOLUTION,
] as const;
export type OpenAiGptImage2ListedResolution = (typeof OPENAI_GPT_IMAGE_2_RESOLUTIONS)[number];
export type OpenAiGptImage2CustomResolution = `${number}x${number}`;
export type OpenAiGptImage2Resolution =
  | OpenAiGptImage2ListedResolution
  | OpenAiGptImage2CustomResolution;

export const OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS = {
  maxEdgePixels: 3840,
  edgeMultiplePixels: 16,
  maxLongToShortEdgeRatio: 3,
  minTotalPixels: 655_360,
  maxTotalPixels: 8_294_400,
  experimentalTotalPixelsThreshold: 3_686_400,
} as const;

export type OpenAiGptImage2ResolutionValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

export function validateOpenAiGptImage2Resolution(
  value: string,
): OpenAiGptImage2ResolutionValidationResult {
  if (value === OPENAI_GPT_IMAGE_2_AUTO_RESOLUTION) {
    return { valid: true };
  }

  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!match) {
    return { valid: false, reason: 'Expected "auto" or a WIDTHxHEIGHT pixel string.' };
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return { valid: false, reason: "Width and height must be safe integer pixel counts." };
  }

  const constraints = OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS;
  if (width > constraints.maxEdgePixels || height > constraints.maxEdgePixels) {
    return {
      valid: false,
      reason: `Width and height must each be at most ${constraints.maxEdgePixels}px.`,
    };
  }

  if (
    width % constraints.edgeMultiplePixels !== 0 ||
    height % constraints.edgeMultiplePixels !== 0
  ) {
    return {
      valid: false,
      reason: `Width and height must each be multiples of ${constraints.edgeMultiplePixels}px.`,
    };
  }

  const totalPixels = width * height;
  if (totalPixels < constraints.minTotalPixels || totalPixels > constraints.maxTotalPixels) {
    return {
      valid: false,
      reason: `Total pixels must be between ${constraints.minTotalPixels} and ${constraints.maxTotalPixels}.`,
    };
  }

  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (longEdge / shortEdge > constraints.maxLongToShortEdgeRatio) {
    return {
      valid: false,
      reason: `The long edge must be at most ${constraints.maxLongToShortEdgeRatio}:1 relative to the short edge.`,
    };
  }

  return { valid: true };
}

export const OPENAI_GPT_IMAGE_2_QUALITY_LEVELS = ["low", "medium", "high", "auto"] as const;
export type OpenAiGptImage2Quality = (typeof OPENAI_GPT_IMAGE_2_QUALITY_LEVELS)[number];

export const OPENAI_GPT_IMAGE_2_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OpenAiGptImage2OutputFormat = (typeof OPENAI_GPT_IMAGE_2_OUTPUT_FORMATS)[number];

export const OPENAI_GPT_IMAGE_2_BACKGROUNDS = ["opaque", "auto"] as const;
export type OpenAiGptImage2Background = (typeof OPENAI_GPT_IMAGE_2_BACKGROUNDS)[number];

export const OPENAI_GPT_IMAGE_2_MODERATION_LEVELS = ["low", "auto"] as const;
export type OpenAiGptImage2Moderation = (typeof OPENAI_GPT_IMAGE_2_MODERATION_LEVELS)[number];

export const OPENAI_GPT_IMAGE_2_PARTIAL_IMAGE_COUNTS = [0, 1, 2, 3] as const;
export type OpenAiGptImage2PartialImageCount =
  (typeof OPENAI_GPT_IMAGE_2_PARTIAL_IMAGE_COUNTS)[number];

export const OPENAI_GPT_IMAGE_2_NUM_IMAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type OpenAiGptImage2NumImages = (typeof OPENAI_GPT_IMAGE_2_NUM_IMAGES)[number];

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
const CHATGPT_IMAGE_GENERATION_PROVIDER_MODEL = "gpt-5.4" as const;

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

export function resolveChatGptImageProviderModel(_model: ChatGptImageModelId): string {
  return CHATGPT_IMAGE_GENERATION_PROVIDER_MODEL;
}

export function resolveChatGptServiceTier(model: ChatGptModelId): "priority" | undefined {
  return (CHATGPT_PRIORITY_MODEL_IDS as readonly string[]).includes(model) ? "priority" : undefined;
}
