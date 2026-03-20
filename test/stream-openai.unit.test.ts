import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

let capturedRequest: any = null;
let uploadedFiles: any[] = [];

vi.mock("../src/openai/calls.js", () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.output_text.delta", delta: "Hello" };
      yield { type: "response.reasoning_summary_text.delta", delta: "Thinking" };
    },
    async finalResponse() {
      return {
        id: "resp_123",
        model: "gpt-5.4-mini",
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 16,
        },
      };
    },
  };

  const fakeClient = {
    responses: {
      stream: (request: any) => {
        capturedRequest = request;
        return fakeStream;
      },
    },
  };

  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

vi.mock("../src/openai/client.js", () => ({
  getOpenAiClient: () => ({
    files: {
      create: async (body: any) => {
        uploadedFiles.push(body);
        return {
          id: "file_123",
          bytes: body?.file?.size ?? 0,
          created_at: 1,
          filename: body?.file?.name ?? "uploaded.bin",
          object: "file",
          purpose: body?.purpose ?? "user_data",
          status: "processed",
          expires_at: 1 + 48 * 60 * 60,
        };
      },
    },
    uploads: {
      create: async () => ({ id: "upload_123" }),
      parts: {
        create: async (_uploadId: string, _body: any) => ({ id: "part_123" }),
      },
      complete: async () => ({ file: { id: "file_123" } }),
    },
  }),
}));

describe("streamText (OpenAI)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gpt-5.4-mini", input: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("openai");
    expect(result.text).toBe("Hello");
    expect(result.thoughts).toBe("Thinking");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("maps thinkingLevel=high to OpenAI max reasoning effort", async () => {
    capturedRequest = null;
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gpt-5.4-mini", input: "hi", thinkingLevel: "high" });
    for await (const _event of call.events) {
      // Drain stream.
    }
    await call.result;

    expect(capturedRequest?.reasoning?.effort).toBe("high");
  });

  it("maps mediaResolution=original to OpenAI image detail on gpt-5.4", async () => {
    capturedRequest = null;
    const { generateText } = await import("../src/llm.js");

    await generateText({
      model: "gpt-5.4",
      mediaResolution: "original",
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            {
              type: "inlineData",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
            },
          ],
        },
      ],
    });

    const imagePart = capturedRequest?.input?.[0]?.content?.find(
      (p: any) => p?.type === "input_image",
    );
    expect(imagePart?.detail).toBe("original");
  });

  it("maps inlineData application/pdf to input_file", async () => {
    capturedRequest = null;
    const { generateText } = await import("../src/llm.js");

    const pdfB64 = Buffer.from("%PDF-1.4\\nhello").toString("base64");
    await generateText({
      model: "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize the PDF." },
            { type: "inlineData", mimeType: "application/pdf", data: pdfB64 },
          ],
        },
      ],
    });

    const input = capturedRequest?.input;
    expect(Array.isArray(input)).toBe(true);
    expect(input[0]?.role).toBe("user");
    expect(Array.isArray(input[0]?.content)).toBe(true);
    const filePart = input[0].content.find((p: any) => p?.type === "input_file");
    expect(filePart).toBeTruthy();
    expect(filePart.file_data).toBe(pdfB64);
    expect(filePart.filename).toBe("document.pdf");
  });

  it("uploads large prompt attachments and replaces file_data with file_id", async () => {
    capturedRequest = null;
    uploadedFiles = [];
    const { generateText } = await import("../src/llm.js");

    const largePdfB64 = Buffer.alloc(16 * 1024 * 1024, 0x61).toString("base64");
    await generateText({
      model: "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize the PDF." },
            {
              type: "inlineData",
              mimeType: "application/pdf",
              filename: "report.pdf",
              data: largePdfB64,
            },
          ],
        },
      ],
    });

    const input = capturedRequest?.input;
    const filePart = input?.[0]?.content?.find((p: any) => p?.type === "input_file");
    expect(filePart?.file_id).toBe("file_123");
    expect(filePart?.file_data).toBeUndefined();
    expect(filePart?.filename).toBeUndefined();
    expect(uploadedFiles).toHaveLength(1);
    expect(uploadedFiles[0]?.purpose).toBe("user_data");
  });

  it("writes upload logs and upload metrics for direct calls that offload prompt files", async () => {
    capturedRequest = null;
    uploadedFiles = [];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-stream-openai-logs-"));
    try {
      const workspaceDir = path.join(tempRoot, "workspace");
      const { createAgentLoggingSession, runWithAgentLoggingSession } = await import(
        "../src/agentLogging.js"
      );
      const { generateText } = await import("../src/llm.js");
      const session = createAgentLoggingSession({
        workspaceDir,
        mirrorToConsole: false,
      });

      const largePdfB64 = Buffer.alloc(16 * 1024 * 1024, 0x61).toString("base64");
      await runWithAgentLoggingSession(session, async () => {
        await generateText({
          model: "gpt-5.4-mini",
          input: [
            {
              role: "user",
              content: [
                { type: "text", text: "Summarize the PDF." },
                {
                  type: "inlineData",
                  mimeType: "application/pdf",
                  filename: "report.pdf",
                  data: largePdfB64,
                },
              ],
            },
          ],
        });
      });
      await session.flush();

      const agentLog = await fs.readFile(path.join(workspaceDir, "agent.log"), "utf8");
      expect(agentLog).toContain("[upload]");
      expect(agentLog).toContain("source=prompt_inline_offload");
      expect(agentLog).toContain("backend=openai");
      expect(agentLog).toContain('filename="report.pdf"');

      const logsRoot = path.join(workspaceDir, "llm_calls");
      const runDirs = await fs.readdir(logsRoot);
      const runDir = path.join(logsRoot, runDirs[0] ?? "");
      const modelDirs = await fs.readdir(runDir);
      const callDir = path.join(runDir, modelDirs[0] ?? "");
      const responseMetadata = JSON.parse(
        await fs.readFile(path.join(callDir, "response.metadata.json"), "utf8"),
      ) as {
        uploads?: {
          count?: number;
          totalBytes?: number;
          totalLatencyMs?: number;
        };
      };

      expect(responseMetadata.uploads?.count).toBe(1);
      expect(responseMetadata.uploads?.totalBytes).toBeGreaterThan(0);
      expect(responseMetadata.uploads?.totalLatencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
