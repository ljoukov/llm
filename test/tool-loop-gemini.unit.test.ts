import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let scenario: "tool" | "length" = "tool";

vi.mock("../src/utils/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/env.js")>()),
  loadLocalEnv: vi.fn(),
}));

vi.mock("../src/google/calls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/google/calls.js")>()),
  runGeminiCall: async (fn: (client: any) => Promise<unknown>) =>
    fn({
      models: {
        generateContentStream: async (request: any) => {
          requests.push(request);
          const first = requests.length === 1;
          async function* stream() {
            yield {
              modelVersion: request.model,
              candidates: [
                {
                  content: {
                    role: "model",
                    parts:
                      scenario === "length"
                        ? [{ text: "unfinished reasoning", thought: true }]
                        : first
                          ? [{ functionCall: { name: "multiply", args: { a: 2, b: 3 } } }]
                          : [{ text: "6" }],
                  },
                },
              ],
            };
            // Real streams may send their finish reason in a content-free terminal chunk.
            yield {
              candidates: [{ finishReason: scenario === "length" ? "MAX_TOKENS" : "STOP" }],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: scenario === "length" ? 0 : 2,
                thoughtsTokenCount: scenario === "length" ? 65_536 : 3,
                totalTokenCount: scenario === "length" ? 65_546 : 15,
              },
            };
          }
          return stream();
        },
      },
    }),
}));

beforeEach(() => {
  requests = [];
  scenario = "tool";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function multiplyTools() {
  const { tool } = await import("../src/llm.js");
  return {
    multiply: tool({
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => ({ value: a * b }),
    }),
  };
}

describe("Gemini tool-loop output controls", () => {
  it.each([
    "gemini-4-argon",
    "gemini-3.8-flash",
  ] as const)("forwards an explicit output limit on every %s completion through runAgentLoop", async (model) => {
    const { runAgentLoop } = await import("../src/agent.js");
    const result = await runAgentLoop({
      provider: "google",
      model,
      input: "Multiply then return the result.",
      logging: false,
      maxOutputTokens: 65_536,
      tools: await multiplyTools(),
    });
    expect(result.text).toBe("6");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.config.maxOutputTokens)).toEqual([65_536, 65_536]);
    expect(result.steps.map((step) => step.finishReason)).toEqual(["STOP", "STOP"]);
  });

  it("preserves the existing 32000 default when the override is omitted", async () => {
    const { runToolLoop } = await import("../src/llm.js");
    await runToolLoop({
      model: "gemini-4-argon",
      input: "Multiply.",
      tools: await multiplyTools(),
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.config.maxOutputTokens)).toEqual([32_000, 32_000]);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid Gemini maxOutputTokens %s before inference", async (maxOutputTokens) => {
    const { runToolLoop } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        model: "gemini-4-argon",
        input: "Multiply.",
        maxOutputTokens,
        tools: await multiplyTools(),
      }),
    ).rejects.toThrow("maxOutputTokens must be a positive safe integer");
    expect(requests).toHaveLength(0);
  });

  it("retains a reasoning-only MAX_TOKENS stop in results, events, and native logs without replay", async () => {
    const { runAgentLoop } = await import("../src/agent.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-gemini-length-"));
    scenario = "length";
    const events: any[] = [];
    try {
      const result = await runAgentLoop({
        provider: "google",
        model: "gemini-4-argon",
        input: "Multiply.",
        maxOutputTokens: 65_536,
        tools: await multiplyTools(),
        onEvent: (event) => events.push(event),
        logging: { workspaceDir: root, mirrorToConsole: false },
      });
      expect(requests).toHaveLength(1);
      expect(result.text).toBe("");
      expect(result.thoughts).toBe("unfinished reasoning");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.finishReason).toBe("MAX_TOKENS");
      expect(result.steps[0]?.usage?.thinkingTokens).toBe(65_536);
      expect(events).toContainEqual({
        type: "model",
        modelVersion: "gemini-4-argon",
        finishReason: "MAX_TOKENS",
      });
      const entries = await fs.readdir(root, { recursive: true });
      const metadataPath = entries.find((name) => name.endsWith("response.metadata.json"));
      expect(metadataPath).toBeDefined();
      const metadata = JSON.parse(await fs.readFile(path.join(root, metadataPath ?? ""), "utf8"));
      expect(metadata.finishReason).toBe("MAX_TOKENS");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
