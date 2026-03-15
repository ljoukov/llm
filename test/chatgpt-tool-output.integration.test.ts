import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

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

function createPngChunk(type: string, data: Buffer): Buffer {
  const chunkType = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([chunkType, data])) >>> 0, 0);
  return Buffer.concat([length, chunkType, data, crc]);
}

function createLargePngDataUrl(): string {
  const width = 600;
  const height = 600;
  const rowStride = 1 + width * 4;
  const raw = Buffer.alloc(rowStride * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * rowStride] = 0;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const LARGE_FIXTURE_IMAGE_DATA_URL = createLargePngDataUrl();

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

  chatGptToolOutputIt(
    `${chatGptModel}: runAgentLoop accepts large image tool outputs without Files API spill`,
    async () => {
      let toolCalls = 0;

      expect(Buffer.byteLength(LARGE_FIXTURE_IMAGE_DATA_URL, "utf8")).toBeGreaterThan(
        1 * 1024 * 1024,
      );

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
            description: "Returns a single large image item for inspection.",
            inputSchema: z.object({ path: z.string() }).strict(),
            execute: async () => {
              toolCalls += 1;
              return [
                {
                  type: "input_image" as const,
                  image_url: LARGE_FIXTURE_IMAGE_DATA_URL,
                  filename: "tool-output-large.png",
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
