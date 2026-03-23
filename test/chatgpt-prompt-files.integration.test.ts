import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { files, generateText, isChatGptModelId } from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  hasCanonicalFilesBackend,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const requestedModels = resolveIntegrationRequestedModels();
const requestedChatGptModel = requestedModels.find((model) => isChatGptModelId(model));
const chatGptModel = requestedChatGptModel ?? "chatgpt-gpt-5.4";
const chatGptPromptFilesIt = requestedChatGptModel && hasCanonicalFilesBackend() ? it : it.skip;

assertIntegrationCredentialsForModels([chatGptModel]);

describe("integration: ChatGPT prompt files", () => {
  chatGptPromptFilesIt(
    `${chatGptModel}: reads prompt attachments referenced by canonical file_id`,
    async () => {
      const token = "CHATGPT_FILE_ID_TOKEN";
      const stored = await files.create({
        data: Buffer.from(`${token}\nSecond line.\n`, "utf8"),
        filename: "chatgpt-file-id-proof.txt",
        mimeType: "text/plain",
      });

      const result = await generateText({
        model: chatGptModel,
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
