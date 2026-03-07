import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgentLoggingSession,
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
        modelId: "gpt-5.2",
        requestText: "hello",
        requestMetadata: {
          image_url: "data:image/png;base64,QUJDRA==",
        },
        attachments: [
          {
            filename: "input.png",
            bytes: Buffer.from([1, 2, 3]),
          },
        ],
      });
      call.appendThoughtDelta("thinking...");
      call.appendResponseDelta("answer");
      call.complete({
        costUsd: 0.123,
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
      expect(await fs.readFile(path.join(callDir, "input.png"))).toEqual(Buffer.from([1, 2, 3]));

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
        modelId: "gpt-5.2",
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
});
