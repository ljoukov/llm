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
let chatGptCallCount = 0;
let failFirstTerminated = false;
let failFirstFileDownload = false;
let emitChatGptDeltas = true;

vi.mock("@google-cloud/storage", async () => {
  return await import("./helpers/mock-storage.js");
});

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      const callIndex = chatGptCallCount++;
      if (failFirstTerminated && callIndex === 0) {
        throw new Error("terminated");
      }
      if (failFirstFileDownload && callIndex === 0) {
        throw new Error(
          'ChatGPT Codex request failed (400): {"error":{"message":"Failed to download file from https://mock-gcs.local/file.png","type":"invalid_request_error","code":"invalid_value"}}',
        );
      }
      capturedRequest = options.request;
      if (emitChatGptDeltas) {
        options.onDelta?.({ thoughtDelta: "Thinking" });
        options.onDelta?.({ textDelta: "Hello" });
      }
      return {
        text: "Hello",
        reasoningText: "",
        reasoningSummaryText: "Thinking",
        toolCalls: [],
        webSearchCalls: [],
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 16,
        },
        model: "gpt-5.4-mini",
        status: "completed",
        blocked: false,
      };
    },
  };
});

describe("streamText (ChatGPT)", () => {
  beforeEach(() => {
    capturedRequest = null;
    chatGptCallCount = 0;
    failFirstTerminated = false;
    failFirstFileDownload = false;
    emitChatGptDeltas = true;
    vi.resetModules();
    resetRuntimeSingletonsForTesting();
    resetMockStorageState();
    installMockStorageEnv();
  });

  it("streams response + thought deltas and returns usage/cost", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "chatgpt-gpt-5.4-mini", input: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("chatgpt");
    expect(result.text).toBe("Hello");
    expect(result.thoughts).toBe("Thinking");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("maps inlineData application/pdf to input_file", async () => {
    const { generateText } = await import("../src/llm.js");

    const pdfB64 = Buffer.from("%PDF-1.4\\nhello").toString("base64");
    await generateText({
      model: "chatgpt-gpt-5.4-mini",
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
    const { DEFAULT_SIGNED_URL_TTL_SECONDS } = await import("../src/files.js");

    const largePdfB64 = Buffer.alloc(16 * 1024 * 1024, 0x61).toString("base64");
    const beforeCallMs = Date.now();
    await generateText({
      model: "chatgpt-gpt-5.4-mini",
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
    const signedUrlCalls = getMockStorageState().signedUrlCalls;
    expect(signedUrlCalls).toHaveLength(1);
    const expires = signedUrlCalls[0]?.options.expires;
    expect(typeof expires).toBe("number");
    expect(expires as number).toBeGreaterThanOrEqual(
      beforeCallMs + (DEFAULT_SIGNED_URL_TTL_SECONDS - 1) * 1000,
    );
    expect(expires as number).toBeLessThanOrEqual(
      Date.now() + (DEFAULT_SIGNED_URL_TTL_SECONDS + 1) * 1000,
    );
  });

  it("retries once when ChatGPT transport fails with terminated", async () => {
    failFirstTerminated = true;
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "chatgpt-gpt-5.4-mini",
      input: "hi",
    });

    expect(result.text).toBe("Hello");
    expect(chatGptCallCount).toBe(2);
  });

  it("retries once when ChatGPT fails to download a signed file URL", async () => {
    failFirstFileDownload = true;
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "chatgpt-gpt-5.4-mini",
      input: "hi",
    });

    expect(result.text).toBe("Hello");
    expect(chatGptCallCount).toBe(2);
  });

  it("maps chatgpt-gpt-5.4-fast to gpt-5.4 with priority service tier", async () => {
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "chatgpt-gpt-5.4-fast",
      input: "hi",
    });

    expect(capturedRequest?.model).toBe("gpt-5.4");
    expect(capturedRequest?.service_tier).toBe("priority");
    expect(result.modelVersion).toBe("chatgpt-gpt-5.4-fast");
  });

  it("maps chatgpt-gpt-5.5-fast to gpt-5.5 with priority service tier", async () => {
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "chatgpt-gpt-5.5-fast",
      input: "hi",
    });

    expect(capturedRequest?.model).toBe("gpt-5.5");
    expect(capturedRequest?.service_tier).toBe("priority");
    expect(result.modelVersion).toBe("chatgpt-gpt-5.5-fast");
  });

  it("rejects the OpenAI shell tool for ChatGPT-authenticated models", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({
      model: "chatgpt-gpt-5.5",
      input: "Use shell.",
      tools: [{ type: "shell" }],
    });
    const events = (async () => {
      for await (const _event of call.events) {
        // Drain until the stream surfaces the rejection.
      }
    })();

    await expect(call.result).rejects.toThrow(
      "OpenAI shell tool is only supported for OpenAI API models.",
    );
    await expect(events).rejects.toThrow(
      "OpenAI shell tool is only supported for OpenAI API models.",
    );
  });

  it("maps experimental ChatGPT ids to their provider model suffix", async () => {
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "experimental-chatgpt-private-model",
      input: "hi",
    });

    expect(capturedRequest?.model).toBe("private-model");
    expect(capturedRequest?.service_tier).toBeUndefined();
    expect(result.modelVersion).toBe("experimental-chatgpt-private-model");
  });

  it("maps mediaResolution=original to ChatGPT image detail on gpt-5.4", async () => {
    const { generateText } = await import("../src/llm.js");

    await generateText({
      model: "chatgpt-gpt-5.4",
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

  it("writes response.txt even when ChatGPT emits no response deltas", async () => {
    emitChatGptDeltas = false;
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-stream-chatgpt-"));
    try {
      const { createAgentLoggingSession, runWithAgentLoggingSession } = await import(
        "../src/agentLogging.js"
      );
      const { generateText } = await import("../src/llm.js");
      const session = createAgentLoggingSession({
        workspaceDir: tempRoot,
        mirrorToConsole: false,
      });

      const result = await runWithAgentLoggingSession(session, async () => {
        return await generateText({
          model: "chatgpt-gpt-5.4-mini",
          input: "hi",
        });
      });
      await session.flush();

      expect(result.text).toBe("Hello");

      const logsRoot = path.join(tempRoot, "llm_calls");
      const runDirs = await fs.readdir(logsRoot);
      const runDir = path.join(logsRoot, runDirs[0] ?? "");
      const modelDirs = await fs.readdir(runDir);
      const callDir = path.join(runDir, modelDirs[0] ?? "");
      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe("Hello");
    } finally {
      emitChatGptDeltas = true;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
