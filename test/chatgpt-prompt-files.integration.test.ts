import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { files, generateText } from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  integrationModelLabel,
  hasCanonicalFilesBackend,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const requestedModels = resolveIntegrationRequestedModels();
const requestedChatGptModel = requestedModels.find(
  (ref) => ref.provider === "openai" && ref.access === "subscription",
);
const chatGptModel =
  requestedChatGptModel ??
  ({ provider: "openai", access: "subscription", model: "gpt-6-sol" } as const);
const chatGptPromptFilesIt = requestedChatGptModel && hasCanonicalFilesBackend() ? it : it.skip;

if (requestedChatGptModel) assertIntegrationCredentialsForModels([chatGptModel]);

describe("integration: ChatGPT prompt files", () => {
  chatGptPromptFilesIt(
    `${integrationModelLabel(chatGptModel)}: reads prompt attachments referenced by canonical file_id`,
    async () => {
      const token = "CHATGPT_FILE_ID_TOKEN";
      const stored = await files.create({
        data: Buffer.from(`${token}\nSecond line.\n`, "utf8"),
        filename: "chatgpt-file-id-proof.txt",
        mimeType: "text/plain",
      });

      const result = await generateText({
        ...chatGptModel,
        input: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the attached file and reply with the exact uppercase token on the first line and nothing else.",
              },
              {
                type: "input_file",
                file_id: stored.id,
                filename: stored.filename,
              },
            ],
          },
        ],
        thinkingLevel: "low",
      });

      expect(result.text.toUpperCase()).toContain(token);
    },
    180_000,
  );
});
