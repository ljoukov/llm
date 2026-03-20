import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createAgentLoggingSession,
  createAgentStreamEventLogger,
  redactDataUrlPayload,
  sanitiseLogValue,
} from "../src/agentLogging.js";

describe("agent logging", () => {
  it("redacts data-url image payloads", () => {
    const dataUrl = "data:image/png;base64,AAAA";

    expect(redactDataUrlPayload(dataUrl)).toBe("data:image/png;base64,...");

    const value = sanitiseLogValue({
      image_url: dataUrl,
      nested: {
        image_url: { url: dataUrl },
      },
      inlineData: {
        mimeType: "application/pdf",
        data: "Zm9vYmFy",
      },
    }) as Record<string, unknown>;

    expect(value.image_url).toBe("data:image/png;base64,...");
    expect((value.nested as Record<string, unknown>).image_url).toEqual({
      url: "data:image/png;base64,...",
    });
    expect((value.inlineData as Record<string, unknown>).data).toBe("[omitted:8b]");
  });

  it("writes agent.log and per-call artifacts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-agent-logging-"));
    try {
      const workspaceDir = path.join(tempRoot, "workspace");
      const session = createAgentLoggingSession({
        workspaceDir,
        mirrorToConsole: false,
      });

      session.logLine("[agent:test-run] run_started");
      const call = session.startLlmCall({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        requestText: "hello",
        requestMetadata: {
          image_url: "data:image/png;base64,QUJDRA==",
        },
        attachments: [
          {
            filename: "input-1.png",
            bytes: Buffer.from([1, 2, 3]),
          },
        ],
        toolCallResponseText: JSON.stringify([
          {
            type: "function_call_output",
            callId: "call_1",
            output: { ok: true },
          },
        ]),
        toolCallResponsePayload: [
          {
            type: "function_call_output",
            callId: "call_1",
            output: { ok: true },
          },
        ],
      });
      call.appendThoughtDelta("thinking...");
      call.appendResponseDelta("ans");
      call.complete({
        responseText: "answer",
        toolCallText: JSON.stringify([{ name: "lookup", arguments: { query: "hello" } }]),
        toolCallPayload: [{ name: "lookup", arguments: { query: "hello" } }],
        attachments: [
          {
            filename: "output-1.png",
            bytes: Buffer.from([4, 5, 6]),
          },
        ],
        metadata: {
          costUsd: 0.123,
        },
      });
      await session.flush();

      const agentLog = await fs.readFile(path.join(workspaceDir, "agent.log"), "utf8");
      expect(agentLog).toContain("[agent:test-run] run_started");

      const logsRoot = path.join(workspaceDir, "llm_calls");
      const runDirs = await fs.readdir(logsRoot);
      expect(runDirs).toHaveLength(1);
      const runDir = path.join(logsRoot, runDirs[0] ?? "");
      const modelDirs = await fs.readdir(runDir);
      expect(modelDirs).toHaveLength(1);
      const callDir = path.join(runDir, modelDirs[0] ?? "");

      expect(await fs.readFile(path.join(callDir, "request.txt"), "utf8")).toContain("hello");
      expect(await fs.readFile(path.join(callDir, "thoughts.txt"), "utf8")).toBe("thinking...");
      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe("answer");
      expect(await fs.readFile(path.join(callDir, "tool_call.txt"), "utf8")).toContain("lookup");
      expect(JSON.parse(await fs.readFile(path.join(callDir, "tool_call.json"), "utf8"))).toEqual([
        { name: "lookup", arguments: { query: "hello" } },
      ]);
      expect(await fs.readFile(path.join(callDir, "tool_call_response.txt"), "utf8")).toContain(
        "function_call_output",
      );
      expect(
        JSON.parse(await fs.readFile(path.join(callDir, "tool_call_response.json"), "utf8")),
      ).toEqual([
        {
          type: "function_call_output",
          callId: "call_1",
          output: { ok: true },
        },
      ]);
      expect(await fs.readFile(path.join(callDir, "input-1.png"))).toEqual(Buffer.from([1, 2, 3]));
      expect(await fs.readFile(path.join(callDir, "output-1.png"))).toEqual(Buffer.from([4, 5, 6]));

      const requestMetadata = JSON.parse(
        await fs.readFile(path.join(callDir, "request.metadata.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(requestMetadata.request).toEqual({
        image_url: "data:image/png;base64,...",
      });

      const responseMetadata = JSON.parse(
        await fs.readFile(path.join(callDir, "response.metadata.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(responseMetadata.status).toBe("completed");
      expect(responseMetadata.costUsd).toBe(0.123);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes error.txt for failed calls", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-agent-logging-"));
    try {
      const workspaceDir = path.join(tempRoot, "workspace");
      const session = createAgentLoggingSession({
        workspaceDir,
        mirrorToConsole: false,
      });

      const call = session.startLlmCall({
        provider: "chatgpt",
        modelId: "chatgpt-gpt-5.4",
        requestText: "hello",
      });
      call.appendResponseDelta("partial");
      call.fail(new Error("boom"), {
        responseText: "partial",
        toolCallText: JSON.stringify([{ name: "list_dir" }]),
        toolCallPayload: [{ name: "list_dir" }],
        metadata: {
          costUsd: 0.001,
        },
      });
      await session.flush();

      const logsRoot = path.join(workspaceDir, "llm_calls");
      const runDirs = await fs.readdir(logsRoot);
      const runDir = path.join(logsRoot, runDirs[0] ?? "");
      const modelDirs = await fs.readdir(runDir);
      const callDir = path.join(runDir, modelDirs[0] ?? "");

      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe("partial");
      expect(await fs.readFile(path.join(callDir, "error.txt"), "utf8")).toBe("boom\n");
      expect(await fs.readFile(path.join(callDir, "tool_call.txt"), "utf8")).toContain("list_dir");
      expect(JSON.parse(await fs.readFile(path.join(callDir, "tool_call.json"), "utf8"))).toEqual([
        { name: "list_dir" },
      ]);

      const responseMetadata = JSON.parse(
        await fs.readFile(path.join(callDir, "response.metadata.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(responseMetadata.status).toBe("failed");
      expect(responseMetadata.error).toBe("boom");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports redirecting per-call artifacts to a custom directory", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-agent-logging-"));
    try {
      const workspaceDir = path.join(tempRoot, "logs", "agent");
      const session = createAgentLoggingSession({
        workspaceDir,
        callLogsDir: "../llm-calls",
        mirrorToConsole: false,
      });

      session.logLine("[agent:test-run] custom_root");
      const call = session.startLlmCall({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        requestText: "hello",
      });
      call.appendResponseDelta("answer");
      call.complete();
      await session.flush();

      expect(await fs.readFile(path.join(workspaceDir, "agent.log"), "utf8")).toContain(
        "[agent:test-run] custom_root",
      );

      const logsRoot = path.join(tempRoot, "logs", "llm-calls");
      const runDirs = await fs.readdir(logsRoot);
      expect(runDirs).toHaveLength(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("throttles thought delta log lines and flushes before response deltas", () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const logger = createAgentStreamEventLogger({
        append: (line) => {
          lines.push(line);
        },
      });

      logger.appendEvent({ type: "delta", channel: "thought", text: "hel" });
      logger.appendEvent({ type: "delta", channel: "thought", text: "lo" });

      vi.advanceTimersByTime(3_999);
      expect(lines).toEqual([]);

      logger.appendEvent({ type: "delta", channel: "response", text: "answer" });

      expect(lines).toEqual(["thought_delta: hello", "response_delta: answer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits at most one aggregated thought delta log per four seconds", () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const logger = createAgentStreamEventLogger({
        append: (line) => {
          lines.push(line);
        },
      });

      logger.appendEvent({ type: "delta", channel: "thought", text: "alpha" });
      logger.appendEvent({ type: "delta", channel: "thought", text: " beta" });

      vi.advanceTimersByTime(4_000);
      expect(lines).toEqual(["thought_delta: alpha beta"]);

      logger.appendEvent({ type: "delta", channel: "thought", text: " gamma" });
      vi.advanceTimersByTime(2_000);
      expect(lines).toEqual(["thought_delta: alpha beta"]);

      logger.flush();
      expect(lines).toEqual(["thought_delta: alpha beta", "thought_delta:  gamma"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
