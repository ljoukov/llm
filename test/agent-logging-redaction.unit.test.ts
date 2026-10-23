import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentLoggingSession, createAgentStreamEventLogger } from "../src/agentLogging.js";
import { runAgentLoop } from "../src/agent.js";
import { tool } from "../src/llm.js";
import { createLogTextRedactor, redactFinalLogText } from "../src/utils/logRedaction.js";

// This localhost fixture must not load developer credentials from an on-disk .env.
vi.mock("../src/utils/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/env.js")>()),
  loadLocalEnv: vi.fn(),
}));

async function textFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of await textFiles(filename)) files.set(name, value);
    } else {
      files.set(filename, await fs.readFile(filename, "utf8"));
    }
  }
  return files;
}

function expectPrivate(files: Map<string, string>, secret: string): void {
  expect(files.size).toBeGreaterThan(0);
  for (const value of files.values()) {
    expect(value.includes(secret)).toBe(false);
    expect(value.includes(secret.slice(0, Math.floor(secret.length / 2)))).toBe(false);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("native logging credential redaction", () => {
  it("preserves benign proof text ending in a short credential prefix", () => {
    vi.stubEnv("LLM_LOG_TEST_API_KEY", "sk-fixture-abcdefghijklmnopqrstuvwxyz");
    const proof = "This proves";
    expect(redactFinalLogText(proof)).toBe(proof);
    const redact = createLogTextRedactor();
    const first = redact(proof);
    // A possible prefix is held only while active, then harmless short tails return.
    expect(first).toBe("This prove");
    expect(first + redact("", true)).toBe(proof);
  });

  it("redacts late-loaded credentials in errors, text, JSON, console and custom sinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-log-redaction-"));
    const lines: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = createAgentLoggingSession({
      workspaceDir: root,
      sink: {
        append: (line) => {
          lines.push(line);
        },
      },
    });
    // The SDK module and session already exist when configuration is loaded.
    const secret = "fixture-native-log-credential-abcdefghijklmnopqrstuvwxyz";
    const escaped = 'fixture-native-log-quoted-"credential\\with\nnewline';
    vi.stubEnv("LLM_LOG_TEST_API_KEY", secret);
    vi.stubEnv("LLM_LOG_TEST_PRIVATE_KEY", escaped);
    try {
      session.logLine(`provider error: ${secret}`);
      const call = session.startLlmCall({
        provider: "vercel",
        modelId: "reflection/beam-free",
        requestText: JSON.stringify({ text: secret, escaped }),
        requestMetadata: { text: secret, escaped },
        toolCallResponseText: secret,
        toolCallResponsePayload: { secret },
      });
      call.appendThoughtDelta(secret);
      call.appendResponseDelta(secret);
      call.fail(new Error(`provider echoed ${secret}`), {
        responseText: secret,
        toolCallText: secret,
        toolCallPayload: { escaped },
        metadata: {
          echoed: secret,
          costUsd: 0,
          usage: { promptTokens: 10, responseTokens: 3, thinkingTokens: 2 },
        },
      });
      await session.flush();
      const files = await textFiles(root);
      expectPrivate(files, secret);
      for (const value of files.values()) {
        expect(value.includes(escaped)).toBe(false);
        expect(value.includes(JSON.stringify(escaped).slice(1, -1))).toBe(false);
      }
      const error = [...files].find(([name]) => name.endsWith("error.txt"))?.[1];
      expect(error).toBe("provider echoed [REDACTED]\n");
      const metadata = JSON.parse(
        [...files].find(([name]) => name.endsWith("response.metadata.json"))?.[1] ?? "{}",
      );
      expect(metadata.costUsd).toBe(0);
      expect(metadata.usage).toEqual({ promptTokens: 10, responseTokens: 3, thinkingTokens: 2 });
      expect(lines.join("\n").includes(secret)).toBe(false);
      expect(consoleLog.mock.calls.flat().join("\n").includes(secret)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "complete",
    "fail",
  ] as const)("keeps split credentials private across flushes and %s", async (close) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-log-boundary-"));
    vi.useFakeTimers();
    const secret = "fixture-native-log-boundary-abcdefghijklmnopqrstuvwxyz";
    vi.stubEnv("LLM_LOG_TEST_API_KEY", secret);
    const first = secret.slice(0, Math.floor(secret.length / 2));
    const rest = secret.slice(first.length);
    const session = createAgentLoggingSession({ workspaceDir: root, mirrorToConsole: false });
    const stream = createAgentStreamEventLogger({ append: (line) => session.logLine(line) });
    try {
      const call = session.startLlmCall({
        provider: "vercel",
        modelId: "reflection/beam-free",
        requestText: "Math input.",
      });
      call.appendThoughtDelta(`Reasoning! ${first}`);
      call.appendResponseDelta(`Answer! ${first}`);
      stream.appendEvent({ type: "delta", channel: "thought", text: first });
      stream.appendEvent({ type: "delta", channel: "response", text: first });
      await vi.advanceTimersByTimeAsync(5_000);
      // Explicit flush keeps an active call open and must not release its held tail.
      await session.flush();
      expectPrivate(await textFiles(root), secret);
      call.appendThoughtDelta(`${rest}!`);
      call.appendResponseDelta(`${rest}!`);
      stream.appendEvent({ type: "delta", channel: "thought", text: `${rest}!` });
      stream.appendEvent({ type: "delta", channel: "response", text: `${rest}!` });
      if (close === "complete") call.complete({ responseText: `Answer! ${secret}!` });
      else call.fail(new Error("cancelled"));
      stream.flush();
      await session.flush();
      const files = await textFiles(root);
      expectPrivate(files, secret);
      expect([...files.values()].join("\n")).toContain("[REDACTED]!");
      expect([...files.values()].join("\n")).toContain("Reasoning!");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "complete",
    "fail",
  ] as const)("redacts prefix-only terminal tails on %s", async (close) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-log-terminal-"));
    const secret = "fixture-native-log-terminal-abcdefghijklmnopqrstuvwxyz";
    vi.stubEnv("LLM_LOG_TEST_API_KEY", secret);
    const first = secret.slice(0, Math.floor(secret.length / 2));
    const session = createAgentLoggingSession({ workspaceDir: root, mirrorToConsole: false });
    const stream = createAgentStreamEventLogger({ append: (line) => session.logLine(line) });
    try {
      const call = session.startLlmCall({
        provider: "vercel",
        modelId: "reflection/beam-free",
        requestText: "Math input.",
      });
      call.appendThoughtDelta(first);
      call.appendResponseDelta(first);
      stream.appendEvent({ type: "delta", channel: "thought", text: first });
      stream.appendEvent({ type: "delta", channel: "response", text: first });
      if (close === "complete") call.complete({ responseText: first });
      else call.fail(new Error("cancelled"), { responseText: first });
      stream.flush();
      await session.flush();
      const files = await textFiles(root);
      expectPrivate(files, secret);
      expect([...files.values()].join("\n")).toContain("[REDACTED_PARTIAL_SECRET]");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a credential echoed by an actual local HTTP400 out of native agent files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-log-http-"));
    const secret = "fixture-native-log-http-abcdefghijklmnopqrstuvwxyz";
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: `fixture echoed ${secret}`, type: "invalid_request_error" },
        }),
      );
    });
    try {
      await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local fixture port.");
      vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", secret);
      vi.stubEnv("AI_GATEWAY_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
      let caught: unknown;
      try {
        await runAgentLoop({
          provider: "vercel",
          access: "api",
          model: "reflection/beam-free",
          input: "Local error fixture.",
          tools: {
            local: tool({
              description: "Local fixture only.",
              inputSchema: z.object({}),
              execute: () => {
                throw new Error("Tool must not execute.");
              },
            }),
          },
          maxSteps: 1,
          filesystemTool: false,
          subagentTool: false,
          imageGenerationTool: false,
          telemetry: false,
          onEvent: () => undefined,
          logging: { workspaceDir: root, mirrorToConsole: false },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      // Only persisted logging changes; the original provider error remains available to callers.
      expect((caught as Error).message.includes(secret)).toBe(true);
      expect(requests).toBe(1);
      const files = await textFiles(root);
      expectPrivate(files, secret);
      for (const name of ["error.txt", "response.metadata.json", "agent.log"]) {
        expect([...files.keys()].some((filename) => filename.endsWith(name))).toBe(true);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
