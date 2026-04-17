import { describe, expect, it } from "vitest";

import {
  CHATGPT_MODEL_IDS,
  FIREWORKS_MODEL_IDS,
  GEMINI_IMAGE_MODEL_IDS,
  GEMINI_TEXT_MODEL_IDS,
  isChatGptModelId,
  isExperimentalChatGptModelId,
  isLlmImageModelId,
  isLlmModelId,
  isLlmTextModelId,
  isOpenAiModelId,
  LLM_IMAGE_MODEL_IDS,
  LLM_MODEL_IDS,
  LLM_TEXT_MODEL_IDS,
  OPENAI_MODEL_IDS,
} from "../src/index.js";

describe("model id lists", () => {
  it("defines provider model ids as explicit const lists", () => {
    expect(OPENAI_MODEL_IDS).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]);
    expect(CHATGPT_MODEL_IDS).toEqual([
      "chatgpt-gpt-5.4",
      "chatgpt-gpt-5.4-fast",
      "chatgpt-gpt-5.4-mini",
      "chatgpt-gpt-5.3-codex-spark",
    ]);
    expect(FIREWORKS_MODEL_IDS).toContain("gpt-oss-120b");
    expect(GEMINI_TEXT_MODEL_IDS).toContain("gemini-3.1-pro-preview");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3-pro-image-preview");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3.1-flash-image-preview");
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
    expect(isOpenAiModelId("gpt-5.4")).toBe(true);
    expect(isOpenAiModelId("gpt-5.4-mini")).toBe(true);
    expect(isOpenAiModelId("gpt-5.4-nano")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.4")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.4-fast")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.4-mini")).toBe(true);
    expect(isChatGptModelId("chatgpt-gpt-5.3-codex-spark")).toBe(true);
    expect(isChatGptModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(isExperimentalChatGptModelId("experimental-chatgpt-private-model")).toBe(true);
    expect(CHATGPT_MODEL_IDS).not.toContain("experimental-chatgpt-private-model");
    expect(isLlmTextModelId("gpt-5.4")).toBe(true);
    expect(isLlmTextModelId("gpt-5.4-mini")).toBe(true);
    expect(isLlmTextModelId("gpt-5.4-nano")).toBe(true);
    expect(isLlmTextModelId("chatgpt-gpt-5.4-fast")).toBe(true);
    expect(isLlmTextModelId("chatgpt-gpt-5.4-mini")).toBe(true);
    expect(isLlmTextModelId("experimental-chatgpt-private-model")).toBe(true);
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
