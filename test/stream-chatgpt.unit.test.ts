import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

let capturedRequest: any = null;
let chatGptCallCount = 0;
let failFirstTerminated = false;
let emitChatGptDeltas = true;

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      const callIndex = chatGptCallCount++;
      if (failFirstTerminated && callIndex === 0) {
        throw new Error("terminated");
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
        model: "gpt-5.1-codex-mini",
        status: "completed",
        blocked: false,
      };
    },
  };
});

describe("streamText (ChatGPT)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    chatGptCallCount = 0;
    failFirstTerminated = false;
    emitChatGptDeltas = true;
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "chatgpt-gpt-5.1-codex-mini", input: "hi" });

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
    capturedRequest = null;
    chatGptCallCount = 0;
    failFirstTerminated = false;
    emitChatGptDeltas = true;
    const { generateText } = await import("../src/llm.js");

    const pdfB64 = Buffer.from("%PDF-1.4\\nhello").toString("base64");
    await generateText({
      model: "chatgpt-gpt-5.1-codex-mini",
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

  it("retries once when ChatGPT transport fails with terminated", async () => {
    chatGptCallCount = 0;
    failFirstTerminated = true;
    emitChatGptDeltas = true;
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "chatgpt-gpt-5.1-codex-mini",
      input: "hi",
    });

    expect(result.text).toBe("Hello");
    expect(chatGptCallCount).toBe(2);
  });

  it("maps chatgpt-gpt-5.4-fast to gpt-5.4 with priority service tier", async () => {
    capturedRequest = null;
    chatGptCallCount = 0;
    failFirstTerminated = false;
    emitChatGptDeltas = true;
    const { generateText } = await import("../src/llm.js");

    const result = await generateText({
      model: "chatgpt-gpt-5.4-fast",
      input: "hi",
    });

    expect(capturedRequest?.model).toBe("gpt-5.4");
    expect(capturedRequest?.service_tier).toBe("priority");
    expect(result.modelVersion).toBe("chatgpt-gpt-5.4-fast");
  });

  it("writes response.txt even when ChatGPT emits no response deltas", async () => {
    capturedRequest = null;
    chatGptCallCount = 0;
    failFirstTerminated = false;
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
          model: "chatgpt-gpt-5.1-codex-mini",
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
