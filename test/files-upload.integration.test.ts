import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  files,
  generateText,
  isGeminiTextModelId,
  isOpenAiModelId,
  loadLocalEnv,
} from "../src/index.js";
import {
  hasIntegrationCredentialsForModel,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const LARGE_FILE_TARGET_BYTES = 8 * 1024 * 1024;
const RUN_LARGE_FILE_TESTS = (() => {
  loadLocalEnv();
  return process.env.LLM_INTEGRATION_LARGE_FILES?.trim() === "1";
})();

const requestedModels = resolveIntegrationRequestedModels();
const openAiModel = requestedModels.find((model) => isOpenAiModelId(model));
const geminiModel = requestedModels.find((model) => isGeminiTextModelId(model));
const hasGeminiApi = Boolean(
  process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim(),
);
const hasVertexMirrorBucket = Boolean(
  process.env.VERTEX_GCS_BUCKET?.trim() || process.env.LLM_VERTEX_GCS_BUCKET?.trim(),
);

function escapePdfText(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
}

function buildPdfWithPadding(label: string, targetBytes: number): Buffer {
  const pageText = `BT /F1 24 Tf 72 720 Td (${escapePdfText(label)}) Tj ET`;

  const render = (paddingBytes: number): Buffer => {
    const header = Buffer.from("%PDF-1.4\n", "utf8");
    const pageStream = Buffer.from(pageText, "utf8");
    const paddingStream = Buffer.alloc(Math.max(0, paddingBytes), 0x30);
    const objects = [
      Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "utf8"),
      Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "utf8"),
      Buffer.from(
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
        "utf8",
      ),
      Buffer.concat([
        Buffer.from(`4 0 obj\n<< /Length ${pageStream.byteLength.toString()} >>\nstream\n`, "utf8"),
        pageStream,
        Buffer.from("\nendstream\nendobj\n", "utf8"),
      ]),
      Buffer.from(
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        "utf8",
      ),
      Buffer.concat([
        Buffer.from(
          `6 0 obj\n<< /Length ${paddingStream.byteLength.toString()} >>\nstream\n`,
          "utf8",
        ),
        paddingStream,
        Buffer.from("\nendstream\nendobj\n", "utf8"),
      ]),
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
      `trailer\n<< /Size ${offsets.length.toString()} /Root 1 0 R >>\nstartxref\n${(
        header.byteLength + objects.reduce((sum, entry) => sum + entry.byteLength, 0)
      ).toString()}\n%%EOF\n`,
      "utf8",
    );

    return Buffer.concat([header, ...objects, xref, trailer]);
  };

  let paddingBytes = Math.max(1_024, targetBytes - 2_048);
  for (let index = 0; index < 4; index += 1) {
    const rendered = render(paddingBytes);
    const delta = targetBytes - rendered.byteLength;
    if (delta === 0) {
      return rendered;
    }
    paddingBytes = Math.max(0, paddingBytes + delta);
  }
  return render(paddingBytes);
}

function buildInlinePdfPart(label: string) {
  const pdf = buildPdfWithPadding(label, LARGE_FILE_TARGET_BYTES);
  return {
    type: "inlineData" as const,
    mimeType: "application/pdf",
    filename: `${label.toLowerCase()}.pdf`,
    data: pdf.toString("base64"),
  };
}

const openAiLargeFilesIt =
  RUN_LARGE_FILE_TESTS && openAiModel && hasIntegrationCredentialsForModel(openAiModel)
    ? it
    : it.skip;

const crossProviderFileIdIt =
  RUN_LARGE_FILE_TESTS &&
  openAiModel &&
  geminiModel &&
  hasIntegrationCredentialsForModel(openAiModel) &&
  hasIntegrationCredentialsForModel(geminiModel) &&
  (hasGeminiApi || hasVertexMirrorBucket)
    ? it
    : it.skip;

describe("integration: large file uploads", () => {
  openAiLargeFilesIt(
    `${openAiModel ?? "openai"}: automatically offloads oversized inline PDFs`,
    async () => {
      if (!openAiModel) {
        return;
      }

      const tokenA = "PDF_ALPHA_TOKEN";
      const tokenB = "PDF_BETA_TOKEN";
      const result = await generateText({
        model: openAiModel,
        input: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read both attached PDFs and reply with the two tokens they contain, separated by a single space and nothing else.",
              },
              buildInlinePdfPart(tokenA),
              buildInlinePdfPart(tokenB),
            ],
          },
        ],
        thinkingLevel: "low",
      });

      const upper = result.text.toUpperCase();
      expect(upper).toContain(tokenA);
      expect(upper).toContain(tokenB);
    },
    240_000,
  );

  crossProviderFileIdIt(
    `${openAiModel ?? "openai"} -> ${geminiModel ?? "gemini"}: reuses canonical file ids across providers`,
    async () => {
      if (!openAiModel || !geminiModel) {
        return;
      }

      const token = "CANONICAL_FILE_TOKEN";
      const pdf = buildPdfWithPadding(token, LARGE_FILE_TARGET_BYTES);
      const stored = await files.create({
        data: pdf,
        filename: "canonical-proof.pdf",
        mimeType: "application/pdf",
      });

      const openAiResult = await generateText({
        model: openAiModel,
        input: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the attached PDF and reply with the exact uppercase token it contains and nothing else.",
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
      expect(openAiResult.text.toUpperCase()).toContain(token);

      const geminiResult = await generateText({
        model: geminiModel,
        input: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the attached PDF and reply with the exact uppercase token it contains and nothing else.",
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
      expect(geminiResult.text.toUpperCase()).toContain(token);
    },
    240_000,
  );
});
