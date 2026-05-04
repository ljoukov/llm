import { describe, expect, it } from "vitest";

import {
  CHATGPT_IMAGE_MODEL_IDS,
  CHATGPT_MODEL_IDS,
  FIREWORKS_MODEL_IDS,
  GEMINI_IMAGE_MODEL_IDS,
  GEMINI_TEXT_MODEL_IDS,
  isChatGptImageModelId,
  isChatGptModelId,
  isExperimentalChatGptModelId,
  isLlmImageModelId,
  isLlmModelId,
  isLlmTextModelId,
  isOpenAiImageModelId,
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
  OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS,
  OPENAI_IMAGE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  validateOpenAiGptImage2Resolution,
} from "../src/index.js";
import type {
  LlmChatGptGenerateImagesRequest,
  LlmGeminiGenerateImagesRequest,
  LlmOpenAiImageResolution,
  LlmOpenAiGenerateImagesRequest,
} from "../src/index.js";

const _openAiImageRequestTypeCheck = {
  model: "gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  imageResolution: "1440x960",
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
  // @ts-expect-error gpt-image-2 uses imageResolution, not Gemini imageSize.
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
  model: "chatgpt-gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  numImages: 1,
} satisfies LlmChatGptGenerateImagesRequest;

const _invalidChatGptImageResolutionTypeCheck = {
  model: "chatgpt-gpt-image-2",
  stylePrompt: "style",
  imagePrompts: ["prompt"],
  // @ts-expect-error ChatGPT subscription image generation uses the built-in image_generation tool, not Images API imageResolution.
  imageResolution: "1024x1024",
} satisfies LlmChatGptGenerateImagesRequest;

describe("model id lists", () => {
  it("defines provider model ids as explicit const lists", () => {
    expect(OPENAI_MODEL_IDS).toEqual([
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
    ]);
    expect(CHATGPT_MODEL_IDS).toEqual([
      "chatgpt-gpt-5.5",
      "chatgpt-gpt-5.5-fast",
      "chatgpt-gpt-5.4",
      "chatgpt-gpt-5.4-fast",
      "chatgpt-gpt-5.4-mini",
      "chatgpt-gpt-5.3-codex-spark",
    ]);
    expect(FIREWORKS_MODEL_IDS).toContain("gpt-oss-120b");
    expect(OPENAI_IMAGE_MODEL_IDS).toEqual(["gpt-image-2"]);
    expect(CHATGPT_IMAGE_MODEL_IDS).toEqual(["chatgpt-gpt-image-2"]);
    expect(GEMINI_TEXT_MODEL_IDS).toContain("gemini-3.1-pro-preview");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3-pro-image-preview");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3.1-flash-image-preview");
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

  it("rejects removed OpenAI model ids", () => {
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5-codex");
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5.2");
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5.3-codex");
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5.3-codex-spark");
    expect(CHATGPT_MODEL_IDS).not.toContain("chatgpt-gpt-5-codex");
    expect(CHATGPT_MODEL_IDS).not.toContain("chatgpt-gpt-5.2");
    expect(CHATGPT_MODEL_IDS).not.toContain("chatgpt-gpt-5.1-codex-mini");
    expect(CHATGPT_MODEL_IDS).not.toContain("chatgpt-gpt-5.3-codex");
    expect(isOpenAiModelId("gpt-5-codex")).toBe(false);
    expect(isOpenAiModelId("gpt-5.2")).toBe(false);
    expect(isOpenAiModelId("gpt-5.3-codex")).toBe(false);
    expect(isOpenAiModelId("gpt-5.3-codex-spark")).toBe(false);
    expect(isChatGptModelId("chatgpt-gpt-5-codex")).toBe(false);
    expect(isChatGptModelId("chatgpt-gpt-5.2")).toBe(false);
    expect(isChatGptModelId("chatgpt-gpt-5.1-codex-mini")).toBe(false);
    expect(isChatGptModelId("chatgpt-gpt-5.3-codex")).toBe(false);
    expect(isLlmTextModelId("gpt-5-codex")).toBe(false);
    expect(isLlmTextModelId("gpt-5.2")).toBe(false);
    expect(isLlmModelId("gpt-5-codex")).toBe(false);
  });

  it("recognizes the supported OpenAI allowlist", () => {
    expect(isOpenAiModelId("gpt-5.5")).toBe(true);
    expect(isOpenAiModelId("gpt-5.5-fast")).toBe(true);
    expect(isOpenAiModelId("gpt-5.4")).toBe(true);
    expect(isOpenAiModelId("gpt-5.4-mini")).toBe(true);
    expect(isOpenAiModelId("gpt-5.4-nano")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.5")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.5-fast")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.4")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.4-fast")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.4-mini")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.3-codex-spark")).toBe(true);
    expect(isChatGptModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(isExperimentalChatGptModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(CHATGPT_MODEL_IDS).not.toContain("experimental-chatgpt-private-model");
    expect(isLlmTextModelId("gpt-5.5")).toBe(true);
    expect(isLlmTextModelId("gpt-5.5-fast")).toBe(true);
    expect(isLlmTextModelId("gpt-5.4")).toBe(true);
    expect(isLlmTextModelId("gpt-5.4-mini")).toBe(true);
    expect(isLlmTextModelId("gpt-5.4-nano")).toBe(true);
    expect(isLlmTextModelId("chatgpt-gpt-5.5")).toBe(true);
    expect(isLlmTextModelId("chatgpt-gpt-5.5-fast")).toBe(true);
    expect(isLlmTextModelId("chatgpt-gpt-5.4-fast")).toBe(true);
    expect(isLlmTextModelId("chatgpt-gpt-5.4-mini")).toBe(true);
    expect(isLlmTextModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(isOpenAiImageModelId("gpt-image-2")).toBe(true);
    expect(isChatGptImageModelId("chatgpt-gpt-image-2")).toBe(true);
    expect(isLlmImageModelId("gpt-image-2")).toBe(true);
    expect(isLlmImageModelId("chatgpt-gpt-image-2")).toBe(true);
    expect(isLlmTextModelId("gpt-image-2")).toBe(false);
    expect(isLlmTextModelId("chatgpt-gpt-image-2")).toBe(false);
    expect(isLlmModelId("gpt-image-2")).toBe(true);
    expect(isLlmModelId("chatgpt-gpt-image-2")).toBe(true);
    expect(isLlmModelId("gpt-5.5-fast")).toBe(true);
    expect(isLlmModelId("chatgpt-gpt-5.5-fast")).toBe(true);
    expect(isLlmModelId("chatgpt-gpt-5.4-fast")).toBe(true);
    expect(isLlmModelId("experimental-chatgpt-private-model")).toBe(true);
  });

  it("aggregates text and image model ids", () => {
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
