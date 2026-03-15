import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isChatGptModelId, runAgentLoop } from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const requestedModels = resolveIntegrationRequestedModels();
const requestedChatGptModel = requestedModels.find((model) => isChatGptModelId(model));
const chatGptModel = requestedChatGptModel ?? "chatgpt-gpt-5.4";
const chatGptToolOutputIt = requestedChatGptModel ? it : it.skip;

assertIntegrationCredentialsForModels([chatGptModel]);

const FIXTURE_IMAGE_BASE64 = fs
  .readFileSync(path.join(import.meta.dirname, "../benchmarks/view_image/input/rome-colosseum.jpg"))
  .toString("base64");

describe("integration: ChatGPT tool outputs", () => {
  chatGptToolOutputIt(
    `${chatGptModel}: runAgentLoop accepts image tool outputs with filenames`,
    async () => {
      let toolCalls = 0;

      const result = await runAgentLoop({
        model: chatGptModel,
        input: [
          {
            role: "system",
            content:
              'You are a strict test assistant. Always call the "view_image" tool exactly once before responding.',
          },
          {
            role: "user",
            content:
              'Call the "view_image" tool exactly once, then reply with exactly "OK" and nothing else.',
          },
        ],
        tools: {
          view_image: {
            description: "Returns a single image item for inspection.",
            inputSchema: z.object({ path: z.string() }).strict(),
            execute: async () => {
              toolCalls += 1;
              return [
                {
                  type: "input_image" as const,
                  image_url: `data:image/jpeg;base64,${FIXTURE_IMAGE_BASE64}`,
                  filename: "tool-output-image.jpg",
                },
              ];
            },
          },
        },
        maxSteps: 6,
        thinkingLevel: "low",
      });

      const sawSuccessfulViewImageCall = result.steps.some((step) =>
        step.toolCalls.some((call) => call.toolName === "view_image" && !call.error),
      );

      expect(toolCalls).toBeGreaterThanOrEqual(1);
      expect(sawSuccessfulViewImageCall).toBe(true);
      expect(result.text.toUpperCase()).toContain("OK");
    },
    180_000,
  );
});
