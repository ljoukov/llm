import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { files, generateText, isChatGptModelId } from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  hasCanonicalFilesBackend,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gMXDxAohU56JAAAAA9JREFUKM9jYBgFo4B8AAACQAABjMWrdwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMy0yM1QxNToxNjo0MCswMDowMOg1bfYAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDMtMjNUMTU6MTY6NDArMDA6MDCZaNVKAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAzLTIzVDE1OjE2OjQwKzAwOjAwzn30lQAAAABJRU5ErkJggg==";
const RED_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCABAAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnRDGqYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//Z";
const RED_WEBP_BASE64 =
  "UklGRloAAABXRUJQVlA4IE4AAADwAwCdASpAAEAAPpFIoEwlpCMiIggAsBIJaQDTyoAAEDuTwRbaZ3EAAP7upj//gN18W0y//3OB/3OB/3OB/G1DJheOmvIZc3w+KZAAAAA=";
const RED_GIF_BASE64 =
  "R0lGODlhQABAAPAAAP8AAAAAACH5BAAAAAAALAAAAABAAEAAAAJFhI+py+0Po5y02ouz3rz7D4biSJbmiabqyrbuC8fyTNf2jef6zvf+DwwKh8Si8YhMKpfMpvMJjUqn1Kr1is1qt9yuF1AAADs=";

type PromptFormatCase =
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

const requestedModels = resolveIntegrationRequestedModels();
const requestedChatGptModel = requestedModels.find((model) => isChatGptModelId(model));
const chatGptModel = requestedChatGptModel ?? "chatgpt-gpt-5.4";
const chatGptFormatIt = requestedChatGptModel && hasCanonicalFilesBackend() ? it : it.skip;

assertIntegrationCredentialsForModels([chatGptModel]);

const chatGptFormatCases: readonly PromptFormatCase[] = [
  {
    label: "TXT",
    filename: "format-proof.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("TXT_FORMAT_TOKEN\nSecond line.\n", "utf8"),
    inputType: "input_file",
    prompt:
      "Read the attached text file and reply with the exact uppercase token on the first line and nothing else.",
    expected: "TXT_FORMAT_TOKEN",
  },
  {
    label: "Markdown",
    filename: "format-proof.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# Heading\n\nMARKDOWN_FORMAT_TOKEN\n", "utf8"),
    inputType: "input_file",
    prompt:
      "Read the attached Markdown file and reply with the exact uppercase token it contains and nothing else.",
    expected: "MARKDOWN_FORMAT_TOKEN",
  },
  {
    label: "LaTeX",
    filename: "format-proof.tex",
    mimeType: "application/x-tex",
    bytes: Buffer.from(
      "\\documentclass{article}\n\\begin{document}\nLATEX_FORMAT_TOKEN\n\\end{document}\n",
      "utf8",
    ),
    inputType: "input_file",
    prompt:
      "Read the attached LaTeX file and reply with the exact uppercase token it contains and nothing else.",
    expected: "LATEX_FORMAT_TOKEN",
  },
  {
    label: "PDF",
    filename: "format-proof.pdf",
    mimeType: "application/pdf",
    bytes: buildPdfWithToken("PDF_FORMAT_TOKEN"),
    inputType: "input_file",
    prompt:
      "Read the attached PDF and reply with the exact uppercase token it contains and nothing else.",
    expected: "PDF_FORMAT_TOKEN",
  },
  {
    label: "PNG",
    filename: "format-proof.png",
    mimeType: "image/png",
    bytes: Buffer.from(RED_PNG_BASE64, "base64"),
    inputType: "input_image",
    prompt:
      "Look at the attached image and reply with the dominant color as a single uppercase word and nothing else.",
    expected: "RED",
  },
  {
    label: "JPEG",
    filename: "format-proof.jpg",
    mimeType: "image/jpeg",
    bytes: Buffer.from(RED_JPEG_BASE64, "base64"),
    inputType: "input_image",
    prompt:
      "Look at the attached image and reply with the dominant color as a single uppercase word and nothing else.",
    expected: "RED",
  },
  {
    label: "WebP",
    filename: "format-proof.webp",
    mimeType: "image/webp",
    bytes: Buffer.from(RED_WEBP_BASE64, "base64"),
    inputType: "input_image",
    prompt:
      "Look at the attached image and reply with the dominant color as a single uppercase word and nothing else.",
    expected: "RED",
  },
  {
    label: "GIF",
    filename: "format-proof.gif",
    mimeType: "image/gif",
    bytes: Buffer.from(RED_GIF_BASE64, "base64"),
    inputType: "input_image",
    prompt:
      "Look at the attached image and reply with the dominant color as a single uppercase word and nothing else.",
    expected: "RED",
  },
] as const;

describe("integration: ChatGPT prompt file formats", () => {
  for (const formatCase of chatGptFormatCases) {
    chatGptFormatIt(
      `${chatGptModel}: reads ${formatCase.label} attachments referenced by canonical file_id`,
      async () => {
        const stored = await files.create({
          data: formatCase.bytes,
          filename: formatCase.filename,
          mimeType: formatCase.mimeType,
        });

        const result = await generateText({
          model: chatGptModel,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: formatCase.prompt,
                },
                formatCase.inputType === "input_image"
                  ? {
                      type: "input_image",
                      file_id: stored.id,
                    }
                  : {
                      type: "input_file",
                      file_id: stored.id,
                      filename: stored.filename,
                    },
              ],
            },
          ],
          thinkingLevel: "low",
        });

        expect(result.text.toUpperCase()).toContain(formatCase.expected);
      },
      180_000,
    );
  }
});
