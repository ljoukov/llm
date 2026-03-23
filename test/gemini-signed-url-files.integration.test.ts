import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { files, generateText, isGeminiTextModelId } from "../src/index.js";
import { getCanonicalFileSignedUrl } from "../src/files.js";
import {
  assertIntegrationCredentialsForModels,
  hasCanonicalFilesBackend,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gMXDxAohU56JAAAAA9JREFUKM9jYBgFo4B8AAACQAABjMWrdwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMy0yM1QxNToxNjo0MCswMDowMOg1bfYAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDMtMjNUMTU6MTY6NDArMDA6MDCZaNVKAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAzLTIzVDE1OjE2OjQwKzAwOjAwzn30lQAAAABJRU5ErkJggg==";

function escapePdfText(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
}

function buildPdfWithToken(token: string): Buffer {
  const pageText = `BT /F1 24 Tf 72 720 Td (${escapePdfText(token)}) Tj ET`;
  const header = Buffer.from("%PDF-1.4\n", "utf8");
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "utf8"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "utf8"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
      "utf8",
    ),
    Buffer.concat([
      Buffer.from(`4 0 obj\n<< /Length ${pageText.length.toString()} >>\nstream\n`, "utf8"),
      Buffer.from(pageText, "utf8"),
      Buffer.from("\nendstream\nendobj\n", "utf8"),
    ]),
    Buffer.from(
      "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      "utf8",
    ),
  ];

  let offset = header.byteLength;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(offset);
    offset += object.byteLength;
  }

  const xrefLines = offsets
    .map((entry, index) =>
      index === 0 ? "0000000000 65535 f \n" : `${entry.toString().padStart(10, "0")} 00000 n \n`,
    )
    .join("");
  const xref = Buffer.from(`xref\n0 ${offsets.length.toString()}\n${xrefLines}`, "utf8");
  const trailer = Buffer.from(
    `trailer\n<< /Size ${offsets.length.toString()} /Root 1 0 R >>\nstartxref\n${offset.toString()}\n%%EOF\n`,
    "utf8",
  );
  return Buffer.concat([header, ...objects, xref, trailer]);
}

type GeminiSignedUrlCase =
  | {
      label: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
      inputType: "input_file";
      prompt: string;
      expected: string;
    }
  | {
      label: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
      inputType: "input_image";
      prompt: string;
      expected: string;
    };

const requestedModels = resolveIntegrationRequestedModels();
const requestedGeminiModel = requestedModels.find((model) => model === "gemini-2.5-pro");
const geminiModel = requestedGeminiModel ?? "gemini-2.5-pro";
const geminiSignedUrlIt = requestedGeminiModel && hasCanonicalFilesBackend() ? it : it.skip;

if (requestedGeminiModel && isGeminiTextModelId(geminiModel)) {
  assertIntegrationCredentialsForModels([geminiModel]);
}

const geminiSignedUrlCases: readonly GeminiSignedUrlCase[] = [
  {
    label: "PDF",
    filename: "gemini-signed-url.pdf",
    mimeType: "application/pdf",
    bytes: buildPdfWithToken("GEMINI_SIGNED_URL_PDF_TOKEN"),
    inputType: "input_file",
    prompt:
      "Read the attached PDF and reply with the exact uppercase token it contains and nothing else.",
    expected: "GEMINI_SIGNED_URL_PDF_TOKEN",
  },
  {
    label: "PNG",
    filename: "gemini-signed-url.png",
    mimeType: "image/png",
    bytes: Buffer.from(RED_PNG_BASE64, "base64"),
    inputType: "input_image",
    prompt:
      "Look at the attached image and reply with the dominant color as a single uppercase word and nothing else.",
    expected: "RED",
  },
] as const;

describe("integration: Gemini signed URL prompt files", () => {
  for (const testCase of geminiSignedUrlCases) {
    geminiSignedUrlIt(
      `${geminiModel}: reads ${testCase.label} attachments from signed GCS URLs`,
      async () => {
        const stored = await files.create({
          data: testCase.bytes,
          filename: testCase.filename,
          mimeType: testCase.mimeType,
        });
        const signedUrl = await getCanonicalFileSignedUrl({ fileId: stored.id });

        const result = await generateText({
          model: geminiModel,
          thinkingLevel: "low",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: testCase.prompt,
                },
                testCase.inputType === "input_image"
                  ? {
                      type: "input_image",
                      image_url: signedUrl,
                      filename: stored.filename,
                    }
                  : {
                      type: "input_file",
                      file_url: signedUrl,
                      filename: stored.filename,
                    },
              ],
            },
          ],
        });

        expect(result.text.toUpperCase()).toContain(testCase.expected);
      },
      180_000,
    );
  }
});
