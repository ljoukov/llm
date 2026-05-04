import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  generateImages,
  generateJson,
  isChatGptModelId,
  isOpenAiImageModelId,
  isOpenAiModelId,
  streamText,
} from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedImageModels,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const requestedTextModels = resolveIntegrationRequestedModels();
const requestedImageModels = resolveIntegrationRequestedImageModels();
assertIntegrationCredentialsForModels(requestedTextModels);
assertIntegrationCredentialsForModels(requestedImageModels);

async function streamToStrings(call: ReturnType<typeof streamText>): Promise<{
  response: string;
  thought: string;
  sawUsage: boolean;
}> {
  let response = "";
  let thought = "";
  let sawUsage = false;
  for await (const event of call.events) {
    if (event.type === "delta") {
      if (event.channel === "response") {
        response += event.text;
      } else {
        thought += event.text;
      }
    } else if (event.type === "usage") {
      sawUsage = true;
    }
  }
  return { response, thought, sawUsage };
}

describe("integration: text model matrix", () => {
  for (const model of requestedTextModels) {
    it(`${model}: streams and returns result`, async () => {
      const call = streamText({
        model,
        input: "Return exactly: OK",
        ...(isOpenAiModelId(model) || isChatGptModelId(model)
          ? { thinkingLevel: "low" as const }
          : {}),
      });
      const streamed = await streamToStrings(call);
      const result = await call.result;

      expect(result.text.toUpperCase()).toContain("OK");
      expect(streamed.response.toUpperCase()).toContain("OK");
      expect(streamed.sawUsage).toBe(true);
      expect(result.usage?.totalTokens).toBeTypeOf("number");
      expect(Number.isFinite(result.costUsd)).toBe(true);
      if (isOpenAiModelId(model)) {
        expect(result.provider).toBe("openai");
      } else if (isChatGptModelId(model)) {
        expect(result.provider).toBe("chatgpt");
      } else if (model.startsWith("gemini-")) {
        expect(result.provider).toBe("gemini");
      } else {
        expect(result.provider).toBe("fireworks");
      }
    }, 180_000);
  }
});

describe("integration: structured output", () => {
  const chatGptModel = requestedTextModels.find((model) => isChatGptModelId(model));
  const chatGptIt = chatGptModel ? it : it.skip;

  chatGptIt("ChatGPT: generateJson returns validated JSON", async () => {
    if (!chatGptModel) {
      return;
    }
    const schema = z.object({ ok: z.boolean(), message: z.string() });
    const { value } = await generateJson({
      model: chatGptModel,
      input: 'Return exactly this JSON object: {"ok":true,"message":"hello"}. Return only JSON.',
      schema,
      thinkingLevel: "low",
    });

    expect(value.ok).toBe(true);
    expect(value.message).toContain("hello");
  });
});

describe("integration: image model matrix", () => {
  for (const model of requestedImageModels) {
    it(`${model}: returns image content`, async () => {
      if (isOpenAiImageModelId(model)) {
        const images = await generateImages({
          model,
          stylePrompt: "Simple icon style. White background, clean edges, no text.",
          imagePrompts: ["A single blue square centered in the frame"],
          imageResolution: "1024x1024",
          imageQuality: "low",
        });

        expect(images).toHaveLength(1);
        expect(images[0]?.data.length).toBeGreaterThan(0);
        expect(images[0]?.mimeType?.startsWith("image/") ?? false).toBe(true);
        return;
      }

      const call = streamText({
        model,
        input:
          "Generate a single simple 1:1 icon of a blue square on a white background. Include no text in the image.",
        responseModalities: ["IMAGE", "TEXT"],
        imageAspectRatio: "1:1",
        imageSize: "1K",
      });
      const streamed = await streamToStrings(call);
      const result = await call.result;

      expect(result.provider).toBe("gemini");
      expect(streamed.sawUsage).toBe(true);
      expect(result.usage?.totalTokens).toBeTypeOf("number");
      expect(Number.isFinite(result.costUsd)).toBe(true);

      const imageParts =
        result.content?.parts.filter(
          (part): part is { type: "inlineData"; data: string; mimeType?: string } =>
            part.type === "inlineData",
        ) ?? [];
      expect(imageParts.length).toBeGreaterThan(0);
      expect(imageParts[0]?.data.length).toBeGreaterThan(0);
      expect(imageParts[0]?.mimeType?.startsWith("image/") ?? false).toBe(true);
    }, 180_000);
  }
});
