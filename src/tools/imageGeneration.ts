import { z } from "zod";

import {
  generateImages,
  tool,
  type LlmChatGptGenerateImagesRequest,
  type LlmFunctionTool,
  type LlmOpenAiGenerateImagesRequest,
  type LlmToolOutputContentItem,
} from "../llm.js";

type RuntimeImageToolRequestKeys = "stylePrompt" | "imagePrompts";

export type LlmImageGenerationToolOptions =
  | (Omit<LlmOpenAiGenerateImagesRequest, RuntimeImageToolRequestKeys> & {
      readonly stylePrompt?: string;
    })
  | (Omit<LlmChatGptGenerateImagesRequest, RuntimeImageToolRequestKeys> & {
      readonly stylePrompt?: string;
    });

const imageGenerationToolInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "A complete, production-ready description of the image to generate, including the desired canvas orientation or aspect ratio.",
    ),
});

export type LlmImageGenerationToolInput = z.infer<typeof imageGenerationToolInputSchema>;

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/**
 * Creates a client-executed image tool for runToolLoop()/runAgentLoop().
 * The outer loop model remains a text model; this tool calls the selected
 * public or ChatGPT-subscription image endpoint only after the model invokes it.
 */
export function createImageGenerationTool(
  options: LlmImageGenerationToolOptions,
): LlmFunctionTool<typeof imageGenerationToolInputSchema, LlmToolOutputContentItem[]> {
  return tool({
    description:
      "Generate an image from a complete visual prompt. Use this when the user asks to create or edit an image.",
    inputSchema: imageGenerationToolInputSchema,
    execute: async ({ prompt }) => {
      const images = await generateImages({
        ...options,
        stylePrompt: options.stylePrompt ?? "",
        imagePrompts: [prompt],
      } as LlmOpenAiGenerateImagesRequest | LlmChatGptGenerateImagesRequest);

      return images.map((image, index) => {
        const mimeType = image.mimeType ?? "image/png";
        return {
          type: "input_image" as const,
          image_url: `data:${mimeType};base64,${image.data.toString("base64")}`,
          filename: `generated-${index + 1}.${imageExtension(mimeType)}`,
          detail: "original" as const,
        };
      });
    },
  });
}
