import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODEL_IDS,
  OPENAI_SUBSCRIPTION_IMAGE_MODEL_IDS,
  OPENAI_SUBSCRIPTION_MODEL_IDS,
  FIREWORKS_MODEL_IDS,
  GEMINI_IMAGE_MODEL_IDS,
  GEMINI_TEXT_MODEL_IDS,
  isAnthropicModelId,
  isGeminiTextModelId,
  isOpenAiSubscriptionModelId,
  isExperimentalChatGptModelId,
  isLlmImageModelId,
  isLlmModelId,
  isLlmTextModelId,
  isOpenAiModelId,
  LLM_IMAGE_MODEL_IDS,
  LLM_MODEL_IDS,
  LLM_TEXT_MODEL_IDS,
  OPENAI_GPT_IMAGE_2_BACKGROUNDS,
  OPENAI_GPT_IMAGE_2_MODERATION_LEVELS,
  OPENAI_GPT_IMAGE_2_NUM_IMAGES,
  OPENAI_GPT_IMAGE_2_OUTPUT_FORMATS,
  OPENAI_GPT_IMAGE_2_PARTIAL_IMAGE_COUNTS,
  OPENAI_GPT_IMAGE_2_POPULAR_RESOLUTIONS,
  OPENAI_GPT_IMAGE_2_QUALITY_LEVELS,
  OPENAI_GPT_IMAGE_2_RESOLUTIONS,
  OPENAI_GPT_IMAGE_2_SEMANTIC_SIZES,
  OPENAI_GPT_IMAGE_2_SEMANTIC_SIZE_RESOLUTIONS,
  OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS,
  OPENAI_IMAGE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  validateOpenAiGptImage2Resolution,
  resolveOpenAiGptImage2Size,
  resolveAnthropicProviderModel,
} from "../src/index.js";
import type {
  LlmSubscriptionGenerateImagesRequest,
  LlmGeminiGenerateImagesRequest,
  LlmOpenAiImageResolution,
  LlmOpenAiGenerateImagesRequest,
} from "../src/index.js";

const _openAiImageRequestTypeCheck = {
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  imageResolution: "1440x960",
  imageSize: undefined,
  imageQuality: "low",
  numImages: 2,
} satisfies LlmOpenAiGenerateImagesRequest;

const _customOpenAiResolutionTypeCheck = "1440x960" satisfies LlmOpenAiImageResolution;

// @ts-expect-error gpt-image-2 custom resolutions must be WIDTHxHEIGHT strings, not Gemini size names.
const _invalidOpenAiResolutionNameTypeCheck = "2K" satisfies LlmOpenAiImageResolution;

const _invalidOpenAiImageSizeTypeCheck = {
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  // @ts-expect-error gpt-image-2 imageSize accepts semantic orientations, not Gemini size names.
  imageSize: "2K",
} satisfies LlmOpenAiGenerateImagesRequest;

const _invalidGeminiResolutionTypeCheck = {
  model: "gemini-3-pro-image-preview",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  imageGradingPrompt: "grade",
  // @ts-expect-error Gemini image generation uses imageSize, not gpt-image-2 imageResolution.
  imageResolution: "1024x1024",
} satisfies LlmGeminiGenerateImagesRequest;

const _chatGptImageRequestTypeCheck = {
  provider: "openai",
  access: "subscription",
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  background: "opaque",
} satisfies LlmSubscriptionGenerateImagesRequest;

const _invalidChatGptImageSizeTypeCheck = {
  provider: "openai",
  access: "subscription",
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  // @ts-expect-error Subscription image generation derives aspect ratio from the prompt.
  imageSize: "portrait",
} satisfies LlmSubscriptionGenerateImagesRequest;

const _invalidChatGptImageQualityTypeCheck = {
  provider: "openai",
  access: "subscription",
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  // @ts-expect-error Subscription image generation always lets the service select quality.
  imageQuality: "high",
} satisfies LlmSubscriptionGenerateImagesRequest;

const _invalidChatGptNumImagesTypeCheck = {
  provider: "openai",
  access: "subscription",
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  // @ts-expect-error ChatGPT subscription image generation returns one image per prompt.
  numImages: 2,
} satisfies LlmSubscriptionGenerateImagesRequest;

describe("model id lists", () => {
  it("keeps new API and subscription routes explicit", () => {
    for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      expect(isOpenAiModelId(model)).toBe(true);
      expect(isOpenAiModelId(model + "-fast")).toBe(true);
      expect(isOpenAiSubscriptionModelId(model)).toBe(true);
      expect(isOpenAiSubscriptionModelId(model + "-fast")).toBe(true);
    }
    expect(isOpenAiModelId("gpt-6-arbitrary")).toBe(false);
    expect(isOpenAiSubscriptionModelId("chatgpt-arbitrary-model")).toBe(false);
  });

  it("defines provider model ids as explicit const lists", () => {
    expect(OPENAI_MODEL_IDS).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-sol-fast",
      "gpt-6-astra",
      "gpt-6-astra-fast",
      "gpt-6-sol",
      "gpt-6-sol-fast",
      "gpt-6-luna",
      "gpt-6-luna-fast",
      "gpt-5.6",
      "gpt-5.6-fast",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
    ]);
    expect(OPENAI_SUBSCRIPTION_MODEL_IDS).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-sol-fast",
      "gpt-6-astra",
      "gpt-6-astra-fast",
      "gpt-6-sol",
      "gpt-6-sol-fast",
      "gpt-6-luna",
      "gpt-6-luna-fast",
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
    ]);
    expect(FIREWORKS_MODEL_IDS).toEqual(["deepseek-v4.1-flash-1017", "glm-5.3", "kimi-k3"]);
    expect(ANTHROPIC_MODEL_IDS).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
    expect(OPENAI_IMAGE_MODEL_IDS).toEqual(["gpt-image-2"]);
    expect(OPENAI_SUBSCRIPTION_IMAGE_MODEL_IDS).toEqual(["gpt-image-2"]);
    expect(GEMINI_TEXT_MODEL_IDS).toContain("gemini-3.1-pro-preview");
    expect(GEMINI_TEXT_MODEL_IDS).toContain("gemini-4-argon");
    expect(GEMINI_TEXT_MODEL_IDS).toContain("gemini-3.8-flash");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3-pro-image-preview");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3.1-flash-image-preview");
  });

  it("recognizes the requested Gemini and Claude routes without allowing arbitrary ids", () => {
    for (const model of ["gemini-4-argon", "gemini-3.8-flash"]) {
      expect(isGeminiTextModelId(model)).toBe(true);
      expect(isLlmTextModelId(model)).toBe(true);
      expect(isLlmModelId(model)).toBe(true);
      expect(LLM_TEXT_MODEL_IDS).toContain(model);
      expect(isLlmImageModelId(model)).toBe(false);
    }
    for (const model of ANTHROPIC_MODEL_IDS) {
      expect(isAnthropicModelId(model)).toBe(true);
      expect(resolveAnthropicProviderModel(model)).toBe(model);
      expect(isLlmTextModelId(model)).toBe(true);
      expect(isLlmModelId(model)).toBe(true);
      expect(LLM_TEXT_MODEL_IDS).toContain(model);
      expect(isLlmImageModelId(model)).toBe(false);
    }
    expect(isAnthropicModelId("sonnet-arbitrary")).toBe(false);
    expect(isAnthropicModelId("sonnet-5-5")).toBe(false);
    expect(isAnthropicModelId("claude-arbitrary")).toBe(false);
    expect(isGeminiTextModelId("gemini-arbitrary")).toBe(false);
    expect(isLlmTextModelId("claude-arbitrary")).toBe(false);
    expect(isLlmTextModelId("gemini-arbitrary")).toBe(false);
  });

  it("exposes gpt-image-2 option constants from the official image docs", () => {
    expect(OPENAI_GPT_IMAGE_2_POPULAR_RESOLUTIONS).toEqual([
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "2048x2048",
      "2048x1152",
      "3840x2160",
      "2160x3840",
    ]);
    expect(OPENAI_GPT_IMAGE_2_RESOLUTIONS).toEqual([
      ...OPENAI_GPT_IMAGE_2_POPULAR_RESOLUTIONS,
      "auto",
    ]);
    expect(OPENAI_GPT_IMAGE_2_SEMANTIC_SIZES).toEqual(["square", "landscape", "portrait"]);
    expect(OPENAI_GPT_IMAGE_2_SEMANTIC_SIZE_RESOLUTIONS).toEqual({
      square: "1024x1024",
      landscape: "1536x1024",
      portrait: "1024x1536",
    });
    expect(resolveOpenAiGptImage2Size("auto")).toBe("auto");
    expect(resolveOpenAiGptImage2Size("square")).toBe("1024x1024");
    expect(resolveOpenAiGptImage2Size("landscape")).toBe("1536x1024");
    expect(resolveOpenAiGptImage2Size("portrait")).toBe("1024x1536");
    expect(OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS).toEqual({
      maxEdgePixels: 3840,
      edgeMultiplePixels: 16,
      maxLongToShortEdgeRatio: 3,
      minTotalPixels: 655_360,
      maxTotalPixels: 8_294_400,
      experimentalTotalPixelsThreshold: 3_686_400,
    });
    expect(OPENAI_GPT_IMAGE_2_QUALITY_LEVELS).toEqual(["low", "medium", "high", "auto"]);
    expect(OPENAI_GPT_IMAGE_2_OUTPUT_FORMATS).toEqual(["png", "jpeg", "webp"]);
    expect(OPENAI_GPT_IMAGE_2_BACKGROUNDS).toEqual(["opaque", "auto"]);
    expect(OPENAI_GPT_IMAGE_2_MODERATION_LEVELS).toEqual(["low", "auto"]);
    expect(OPENAI_GPT_IMAGE_2_PARTIAL_IMAGE_COUNTS).toEqual([0, 1, 2, 3]);
    expect(OPENAI_GPT_IMAGE_2_NUM_IMAGES).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("validates gpt-image-2 custom resolution constraints", () => {
    expect(validateOpenAiGptImage2Resolution("auto")).toEqual({ valid: true });
    expect(validateOpenAiGptImage2Resolution("1440x960")).toEqual({ valid: true });
    expect(validateOpenAiGptImage2Resolution("1440x200")).toMatchObject({
      valid: false,
    });
    expect(validateOpenAiGptImage2Resolution("1441x960")).toMatchObject({
      valid: false,
    });
    expect(validateOpenAiGptImage2Resolution("4096x4096")).toMatchObject({
      valid: false,
    });
  });

  it("rejects removed model aliases", () => {
    for (const alias of [
      "chatgpt-gpt-6.1-sol",
      "chatgpt-gpt-6.1-sol-fast",
      "chatgpt-gpt-image-2",
      "sonnet-5-5",
      "haiku-5-5",
    ]) {
      expect(isLlmModelId(alias)).toBe(false);
      expect(isOpenAiSubscriptionModelId(alias)).toBe(false);
    }
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5-codex");
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5.2");
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5.3-codex");
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5.3-codex-spark");
    expect(OPENAI_SUBSCRIPTION_MODEL_IDS).not.toContain("gpt-5-codex");
    expect(OPENAI_SUBSCRIPTION_MODEL_IDS).not.toContain("gpt-5.2");
    expect(OPENAI_SUBSCRIPTION_MODEL_IDS).not.toContain("gpt-5.1-codex-mini");
    expect(OPENAI_SUBSCRIPTION_MODEL_IDS).not.toContain("gpt-5.3-codex");
    expect(isOpenAiModelId("gpt-5-codex")).toBe(false);
    expect(isOpenAiModelId("gpt-5.2")).toBe(false);
    expect(isOpenAiModelId("gpt-5.3-codex")).toBe(false);
    expect(isOpenAiModelId("gpt-5.3-codex-spark")).toBe(false);
    expect(isOpenAiSubscriptionModelId("gpt-5-codex")).toBe(false);
    expect(isOpenAiSubscriptionModelId("gpt-5.2")).toBe(false);
    expect(isOpenAiSubscriptionModelId("gpt-5.1-codex-mini")).toBe(false);
    expect(isOpenAiSubscriptionModelId("gpt-5.3-codex")).toBe(false);
    expect(isLlmTextModelId("gpt-5-codex")).toBe(false);
    expect(isLlmTextModelId("gpt-5.2")).toBe(false);
    expect(isLlmModelId("gpt-5-codex")).toBe(false);
  });

  it("recognizes the supported allowlists and rejects pre-5.6 text models", () => {
    for (const model of OPENAI_MODEL_IDS) {
      expect(isOpenAiModelId(model)).toBe(true);
      expect(isLlmTextModelId(model)).toBe(true);
      expect(isLlmModelId(model)).toBe(true);
    }
    for (const model of OPENAI_SUBSCRIPTION_MODEL_IDS) {
      expect(isOpenAiSubscriptionModelId(model)).toBe(true);
      expect(isLlmTextModelId(model)).toBe(true);
      expect(isLlmModelId(model)).toBe(true);
    }
    for (const old of [
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-5.4",
      "gpt-5.4-fast",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex-spark",
    ]) {
      expect(isOpenAiModelId(old)).toBe(false);
      expect(isOpenAiSubscriptionModelId("chatgpt-" + old)).toBe(false);
      expect(isLlmTextModelId(old)).toBe(false);
      expect(isLlmModelId("chatgpt-" + old)).toBe(false);
    }
    expect(isOpenAiSubscriptionModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(isExperimentalChatGptModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(isLlmTextModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(OPENAI_SUBSCRIPTION_MODEL_IDS).not.toContain("experimental-chatgpt-private-model");
    for (const model of ["gpt-image-2"]) {
      expect(isLlmImageModelId(model)).toBe(true);
      expect(isLlmTextModelId(model)).toBe(false);
      expect(isLlmModelId(model)).toBe(true);
    }
  });

  it("aggregates deduplicated text and image model ids", () => {
    expect(new Set(LLM_TEXT_MODEL_IDS).size).toBe(LLM_TEXT_MODEL_IDS.length);
    expect(new Set(LLM_IMAGE_MODEL_IDS).size).toBe(LLM_IMAGE_MODEL_IDS.length);
    expect(new Set(LLM_MODEL_IDS).size).toBe(LLM_MODEL_IDS.length);
    for (const model of LLM_TEXT_MODEL_IDS) {
      expect(isLlmTextModelId(model)).toBe(true);
      expect(isLlmModelId(model)).toBe(true);
      expect(LLM_MODEL_IDS).toContain(model);
    }

    for (const model of LLM_IMAGE_MODEL_IDS) {
      expect(isLlmImageModelId(model)).toBe(true);
      expect(isLlmModelId(model)).toBe(true);
      expect(LLM_MODEL_IDS).toContain(model);
    }
  });
});
