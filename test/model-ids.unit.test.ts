import { describe, expect, it } from "vitest";

import {
  CHATGPT_MODEL_IDS,
  FIREWORKS_MODEL_IDS,
  GEMINI_IMAGE_MODEL_IDS,
  GEMINI_TEXT_MODEL_IDS,
  isChatGptModelId,
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
    expect(OPENAI_MODEL_IDS).toContain("gpt-5.2");
    expect(CHATGPT_MODEL_IDS).toContain("chatgpt-gpt-5.3-codex");
    expect(FIREWORKS_MODEL_IDS).toContain("gpt-oss-120b");
    expect(GEMINI_TEXT_MODEL_IDS).toContain("gemini-3.1-pro-preview");
    expect(GEMINI_IMAGE_MODEL_IDS).toContain("gemini-3-pro-image-preview");
  });

  it("removes gpt-5-codex from supported model ids", () => {
    expect(OPENAI_MODEL_IDS).not.toContain("gpt-5-codex");
    expect(CHATGPT_MODEL_IDS).not.toContain("chatgpt-gpt-5-codex");
    expect(isOpenAiModelId("gpt-5-codex")).toBe(false);
    expect(isChatGptModelId("chatgpt-gpt-5-codex")).toBe(false);
    expect(isLlmTextModelId("gpt-5-codex")).toBe(false);
    expect(isLlmModelId("gpt-5-codex")).toBe(false);
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
