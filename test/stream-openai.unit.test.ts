import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";
import {
  getMockStorageState,
  installMockStorageEnv,
  resetMockStorageState,
} from "./helpers/mock-storage.js";

let capturedRequest: any = null;

vi.mock("@google-cloud/storage", async () => {
  return await import("./helpers/mock-storage.js");
});

vi.mock("../src/openai/calls.js", () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.output_text.delta", delta: "Hello" };
      yield { type: "response.reasoning_summary_text.delta", delta: "Thinking" };
    },
    async finalResponse() {
      return {
        id: "resp_123",
        model: capturedRequest?.model ?? "gpt-5.4-mini",
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

describe("streamText (OpenAI)", () => {
  beforeEach(() => {
    capturedRequest = null;
    vi.resetModules();
    resetRuntimeSingletonsForTesting();
    resetMockStorageState();
    installMockStorageEnv();
  });

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
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gpt-5.4-mini", input: "hi", thinkingLevel: "high" });
    for await (const _event of call.events) {
      // Drain stream.
    }
    await call.result;

    expect(capturedRequest?.reasoning?.effort).toBe("high");
  });

  it("maps gpt-5.5-fast to gpt-5.5 with priority service tier", async () => {
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "gpt-5.5-fast",
      input: "hi",
    });

    expect(capturedRequest?.model).toBe("gpt-5.5");
    expect(capturedRequest?.service_tier).toBe("priority");
    expect(result.modelVersion).toBe("gpt-5.5");
  });

  it("maps mediaResolution=original to OpenAI image detail on gpt-5.4", async () => {
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

  it("uploads large prompt attachments and replaces file_data with signed file_url", async () => {
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
    expect(filePart?.file_url).toMatch(
      /^https:\/\/mock-gcs\.local\/llm-test-bucket\/canonical-files\/file_[a-f0-9]{64}\.pdf\?signed=1$/u,
    );
    expect(filePart?.file_data).toBeUndefined();
    expect(filePart?.file_id).toBeUndefined();
    expect(filePart?.filename).toBeUndefined();

    const mockStorage = getMockStorageState();
    expect(mockStorage.saveCalls).toHaveLength(1);
    expect(mockStorage.signedUrlCalls).toHaveLength(1);
    expect(mockStorage.saveCalls[0]?.objectName).toMatch(
      /^canonical-files\/file_[a-f0-9]{64}\.pdf$/u,
    );
  });

  it("writes upload logs and upload metrics for direct calls that offload prompt files", async () => {
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
      expect(agentLog).toContain("backend=gcs");
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
      expect(getMockStorageState().signedUrlCalls).toHaveLength(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
