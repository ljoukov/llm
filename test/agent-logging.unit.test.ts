import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgentLoggingSession,
  createAgentStreamEventLogger,
  redactDataUrlPayload,
  sanitiseLogValue,
} from "../src/agentLogging.js";

const realSetTimeout = setTimeout;

async function waitForIo<T>(check: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
    }
  }
  throw lastError;
}

async function getCallDir(logsRootDir: string): Promise<string> {
  return waitForIo(async () => {
    const runDirs = await fs.readdir(logsRootDir);
    expect(runDirs).toHaveLength(1);
    const runDir = path.join(logsRootDir, runDirs[0] ?? "");
    const modelDirs = await fs.readdir(runDir);
    expect(modelDirs).toHaveLength(1);
    const callDir = path.join(runDir, modelDirs[0] ?? "");
    await fs.readFile(path.join(callDir, "request.metadata.json"), "utf8");
    return callDir;
  });
}

describe("agent logging", () => {
  // These tests cover ordinary text, independent of developer credential prefixes.
  // Dedicated redaction tests supply explicit known credentials and boundary cases.
  beforeEach(() => {
    for (const name of Object.keys(process.env)) {
      if (
        /api.?key|token|password|secret|credential|private.?key|service.?account|cookie/iu.test(
          name,
        )
      ) {
        vi.stubEnv(name, "");
      }
    }
  });
  afterEach(() => vi.unstubAllEnvs());

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
      anthropicImage: {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
      },
    }) as Record<string, unknown>;

    expect(value.image_url).toBe("data:image/png;base64,...");
    expect((value.nested as Record<string, unknown>).image_url).toEqual({
      url: "data:image/png;base64,...",
    });
    expect((value.inlineData as Record<string, unknown>).data).toBe("[omitted:8b]");
    expect(value.anthropicImage).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "[omitted:8b]" },
    });
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
        modelId: "gpt-6-luna",
        requestedSpeed: "fast",
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
          provider: "responses-api",
          access: "subscription",
          modelId: "incorrect-transport-version",
          costUsd: 0.123,
          costSource: "estimate",
          requestedSpeed: "standard",
          effectiveSpeed: "standard",
          serviceTier: "default",
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
      expect(requestMetadata).toMatchObject({
        modelId: "gpt-6-luna",
        requestedSpeed: "fast",
      });

      const responseMetadata = JSON.parse(
        await fs.readFile(path.join(callDir, "response.metadata.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(responseMetadata.status).toBe("completed");
      expect(responseMetadata).toMatchObject({
        provider: "openai",
        access: "api",
        modelId: "gpt-6-luna",
        transportProvider: "responses-api",
        costUsd: 0.123,
        costSource: "estimate",
        requestedSpeed: "fast",
        effectiveSpeed: "standard",
        serviceTier: "default",
      });
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
        provider: "openai",
        access: "subscription",
        modelId: "gpt-6-sol",
        requestText: "hello",
      });
      call.appendResponseDelta("partial");
      call.fail(new Error("boom"), {
        responseText: "partial",
        toolCallText: JSON.stringify([{ name: "list_dir" }]),
        toolCallPayload: [{ name: "list_dir" }],
        metadata: {
          provider: "chatgpt",
          access: "api",
          modelId: "wrong-model",
          costUsd: null,
          costSource: "subscription",
          apiEquivalentCostUsd: 0.001,
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
      expect(responseMetadata).toMatchObject({
        provider: "openai",
        access: "subscription",
        modelId: "gpt-6-sol",
        transportProvider: "chatgpt",
        costUsd: null,
        costSource: "subscription",
        apiEquivalentCostUsd: 0.001,
      });
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
        modelId: "gpt-6-luna",
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

  it("persists throttled thought and response batches every five seconds while a call runs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-agent-logging-"));
    vi.useFakeTimers();
    try {
      const session = createAgentLoggingSession({
        workspaceDir: tempRoot,
        mirrorToConsole: false,
      });
      const call = session.startLlmCall({
        provider: "fireworks",
        modelId: "deepseek-v4-pro",
        requestText: "hello",
      });
      call.appendThoughtDelta("thinking");
      call.appendThoughtDelta(" through");
      call.appendResponseDelta("ans");
      const callDir = await getCallDir(session.logsRootDir);
      const thoughtsPath = path.join(callDir, "thoughts.txt");
      const responsePath = path.join(callDir, "response.txt");

      await vi.advanceTimersByTimeAsync(4_999);
      await expect(fs.readFile(thoughtsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(responsePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      call.appendThoughtDelta(" this");
      call.appendResponseDelta("wer");

      await vi.advanceTimersByTimeAsync(1);
      await waitForIo(async () => {
        expect(await fs.readFile(thoughtsPath, "utf8")).toBe("thinking through this");
        expect(await fs.readFile(responsePath, "utf8")).toBe("answer");
      });
      await expect(fs.readFile(path.join(callDir, "response.metadata.json"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );

      call.appendThoughtDelta(" more");
      call.appendResponseDelta(" next");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await fs.readFile(thoughtsPath, "utf8")).toBe("thinking through this");
      expect(await fs.readFile(responsePath, "utf8")).toBe("answer");
      await vi.advanceTimersByTimeAsync(1);
      await waitForIo(async () => {
        expect(await fs.readFile(thoughtsPath, "utf8")).toBe("thinking through this more");
        expect(await fs.readFile(responsePath, "utf8")).toBe("answer next");
      });
      expect(vi.getTimerCount()).toBe(0);
      call.complete();
      await session.flush();
    } finally {
      vi.useRealTimers();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "complete",
    "fail",
  ] as const)("flushes pending deltas immediately on %s and ignores late deltas", async (closeMethod) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-agent-logging-"));
    vi.useFakeTimers();
    try {
      const session = createAgentLoggingSession({
        workspaceDir: tempRoot,
        mirrorToConsole: false,
      });
      const call = session.startLlmCall({
        provider: "fireworks",
        modelId: "deepseek-v4-pro",
        requestText: "hello",
      });
      call.appendThoughtDelta("partial");
      call.appendResponseDelta("partial");
      const callDir = await getCallDir(session.logsRootDir);
      vi.advanceTimersByTime(5_000);
      call.appendThoughtDelta(" thought");
      call.appendResponseDelta(" response");
      if (closeMethod === "complete") {
        call.complete();
      } else {
        call.fail(new Error("interrupted"));
      }
      expect(vi.getTimerCount()).toBe(0);
      await waitForIo(async () => {
        expect(await fs.readFile(path.join(callDir, "thoughts.txt"), "utf8")).toBe(
          "partial thought",
        );
        expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe(
          "partial response",
        );
        expect(
          JSON.parse(await fs.readFile(path.join(callDir, "response.metadata.json"), "utf8"))
            .status,
        ).toBe(closeMethod === "complete" ? "completed" : "failed");
      });

      call.appendThoughtDelta(" ignored");
      call.appendResponseDelta(" ignored");
      call.complete();
      call.fail(new Error("ignored"));
      await vi.advanceTimersByTimeAsync(10_000);
      await session.flush();
      expect(await fs.readFile(path.join(callDir, "thoughts.txt"), "utf8")).toBe("partial thought");
      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe(
        "partial response",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("drains pending call deltas on an explicit session flush and keeps the call open", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-agent-logging-"));
    vi.useFakeTimers();
    try {
      const session = createAgentLoggingSession({
        workspaceDir: tempRoot,
        mirrorToConsole: false,
      });
      const call = session.startLlmCall({
        provider: "fireworks",
        modelId: "deepseek-v4-pro",
        requestText: "hello",
      });
      call.appendThoughtDelta("one");
      call.appendResponseDelta("first");
      await session.flush();
      const callDir = await getCallDir(session.logsRootDir);
      expect(await fs.readFile(path.join(callDir, "thoughts.txt"), "utf8")).toBe("one");
      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe("first");
      expect(vi.getTimerCount()).toBe(0);

      call.appendThoughtDelta(" two");
      call.appendResponseDelta(" second");
      call.complete({ responseText: "first second final" });
      await session.flush();
      expect(await fs.readFile(path.join(callDir, "thoughts.txt"), "utf8")).toBe("one two");
      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe(
        "first second final",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await session.flush();
      expect(await fs.readFile(path.join(callDir, "response.txt"), "utf8")).toBe(
        "first second final",
      );
    } finally {
      vi.useRealTimers();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("logs requested and actual serving speed separately from the model version", () => {
    const lines: string[] = [];
    const logger = createAgentStreamEventLogger({ append: (line) => lines.push(line) });
    const serving = {
      requestedSpeed: "fast" as const,
      effectiveSpeed: "standard" as const,
      serviceTier: "default",
    };

    logger.appendEvent({ type: "model", modelVersion: "gpt-6.1-sol", ...serving });
    logger.appendEvent({
      type: "usage",
      modelVersion: "gpt-6.1-sol",
      usage: { promptTokens: 1, responseTokens: 1 },
      costUsd: 0.000012,
      ...serving,
    });
    logger.flush();

    expect(lines[0]).toBe(
      "model: gpt-6.1-sol requestedSpeed=fast effectiveSpeed=standard serviceTier=default",
    );
    expect(lines[1]).toContain(
      "modelVersion=gpt-6.1-sol requestedSpeed=fast effectiveSpeed=standard serviceTier=default",
    );
    expect(lines.join("\n")).not.toContain("gpt-6.1-sol-fast");
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

      vi.advanceTimersByTime(4_999);
      expect(lines).toEqual([]);

      logger.appendEvent({ type: "delta", channel: "response", text: "answer" });

      expect(lines).toEqual(["thought_delta: hello", "response_delta: answer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits at most one aggregated thought delta log per five seconds", () => {
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

      vi.advanceTimersByTime(5_000);
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
