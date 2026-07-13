import { describe, expect, it } from "vitest";

import { generateImages } from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedImageModels,
} from "./integration-env.js";

const subscriptionModel = resolveIntegrationRequestedImageModels().find(
  (model) => model === "chatgpt-gpt-image-2",
);
const subscriptionIt = subscriptionModel ? it : it.skip;

function readPngDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || data[0] !== 0x89 || data.subarray(1, 4).toString("ascii") !== "PNG") {
    return undefined;
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

describe("integration: ChatGPT subscription GPT Image 2 prompt-driven aspect ratios", () => {
  subscriptionIt(
    "selects landscape, portrait, and square canvases from explicit prompt instructions",
    async () => {
      if (!subscriptionModel) {
        return;
      }
      assertIntegrationCredentialsForModels([subscriptionModel]);

      const cases = [
        {
          label: "landscape",
          prompt:
            "Create a very wide panoramic 3:1 landscape canvas showing a blue circle on an empty horizon. The final image must be much wider than it is tall. No text.",
          assertDimensions: ({ width, height }: { width: number; height: number }) => {
            expect(width / height).toBeGreaterThanOrEqual(2.5);
          },
        },
        {
          label: "portrait",
          prompt:
            "Create a tall upright 2:3 portrait poster canvas showing a blue circle above a distant horizon. The final image must be taller than it is wide. No text.",
          assertDimensions: ({ width, height }: { width: number; height: number }) => {
            expect(height).toBeGreaterThan(width);
          },
        },
        {
          label: "square",
          prompt:
            "Create an exact 1:1 square icon canvas with a single centered blue circle. The final image must have equal width and height. No text.",
          assertDimensions: ({ width, height }: { width: number; height: number }) => {
            expect(Math.abs(width - height) / Math.max(width, height)).toBeLessThanOrEqual(0.05);
          },
        },
      ];

      for (const testCase of cases) {
        const images = await generateImages({
          model: subscriptionModel,
          stylePrompt: "Minimal flat graphic, plain background, no text.",
          imagePrompts: [testCase.prompt],
          background: "auto",
        });
        expect(images).toHaveLength(1);
        expect(images[0]?.mimeType).toBe("image/png");
        const dimensions = images[0] ? readPngDimensions(images[0].data) : undefined;
        expect(dimensions?.width).toBeGreaterThan(0);
        expect(dimensions?.height).toBeGreaterThan(0);
        if (!dimensions) {
          throw new Error("Expected a PNG with readable dimensions.");
        }
        testCase.assertDimensions(dimensions);
        console.info(
          `subscription image: promptAspect=${testCase.label} structuredSize=auto structuredQuality=auto background=auto output=${dimensions.width}x${dimensions.height} bytes=${images[0]?.data.byteLength ?? 0}`,
        );
      }
    },
    600_000,
  );
});
