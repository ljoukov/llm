import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; access: string }>,
  requests: [] as Array<Record<string, any>>,
  toolLoop: false,
  returnedModel: undefined as string | undefined,
}));

vi.mock("../src/xai/calls.js", () => ({
  runXaiCall: async (fn: (client: any) => unknown, model: string, access: string) => {
    state.calls.push({ model, access });
    return fn({
      chat: {
        completions: {
          create: async (request: Record<string, any>) => {
            state.requests.push(structuredClone(request));
            const firstTurn = state.requests.length === 1;
            return (async function* () {
              yield {
                model: state.returnedModel ?? request.model,
                choices: [{ index: 0, delta: { reasoning_content: "Think carefully." } }],
              };
              if (state.toolLoop && firstTurn) {
                yield {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "multiply_1",
                            function: { name: "multiply", arguments: '{"a":2,"b":3}' },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                };
              } else {
                yield {
                  choices: [
                    {
                      index: 0,
                      delta: { content: state.toolLoop ? "6" : '{"value":6}' },
                      finish_reason: "stop",
                    },
                  ],
                };
              }
              yield {
                choices: [],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 20,
                  completion_tokens_details: { reasoning_tokens: 5 },
                },
              };
            })();
          },
        },
      },
    });
  },
}));

beforeEach(() => {
  state.calls = [];
  state.requests = [];
  state.toolLoop = false;
  state.returnedModel = undefined;
});

describe("xAI shared inference routes", () => {
  it("records provider, returned model version, and requested/sent thinking throughout an agent trace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-xai-thinking-trace-"));
    try {
      state.returnedModel = "grok-4.7-20261103";
      const { runAgentLoop } = await import("../src/agent.js");
      const { tool } = await import("../src/llm.js");
      const events: Array<Record<string, any>> = [];
      await runAgentLoop({
        model: "xai:subscription:grok-4.7",
        input: "hello",
        thinkingLevel: "max",
        tools: { noop: tool({ inputSchema: z.object({}), execute: () => "done" }) },
        filesystemTool: false,
        subagentTool: false,
        logging: { workspaceDir: root, mirrorToConsole: false },
        telemetry: {
          sink: {
            emit: (event) => {
              events.push(event);
            },
          },
        },
      });
      const trace = await fs.readFile(path.join(root, "agent.log"), "utf8");
      for (const text of [
        "provider=xai",
        "access=subscription",
        "modelVersion=grok-4.7-20261103",
        "requestedThinkingLevel=max",
        "effectiveThinkingLevel=xhigh",
        "thinkingLevelSource=model",
      ]) {
        expect(trace).toContain(text);
      }
      const logs = path.join(root, "llm_calls");
      const paths = await fs.readdir(logs, { recursive: true });
      for (const file of ["request.metadata.json", "response.metadata.json"]) {
        const relative = paths.find((name) => name.endsWith(file));
        expect(relative).toBeDefined();
        const metadata = JSON.parse(await fs.readFile(path.join(logs, relative ?? ""), "utf8"));
        expect(metadata).toMatchObject({
          provider: "xai",
          access: "subscription",
          modelId: "grok-4.7",
          thinking: { requestedLevel: "max", effectiveLevel: "xhigh", source: "model" },
        });
        if (file === "response.metadata.json")
          expect(metadata.modelVersion).toBe("grok-4.7-20261103");
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent.run.completed",
          provider: "xai",
          access: "subscription",
          modelVersion: "grok-4.7-20261103",
          thinking: { requestedLevel: "max", effectiveLevel: "xhigh", source: "model" },
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    "max",
    "ultra",
  ] as const)("adapts %s locally and exposes the resolution in text/JSON results and streams", async (thinkingLevel) => {
    const { generateJson } = await import("../src/llm.js");
    const events: unknown[] = [];
    const result = await generateJson({
      model: "xai:subscription:grok-4.7",
      input: "hello",
      thinkingLevel,
      schema: z.object({ value: z.number() }),
      onEvent: (event) => events.push(event),
    });
    expect(state.requests[0]?.reasoning_effort).toBe("xhigh");
    expect(result.result.thinking).toEqual({
      requestedLevel: thinkingLevel,
      effectiveLevel: "xhigh",
      source: "model",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "model", thinking: result.result.thinking }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", thinking: result.result.thinking }),
    );
    expect(state.calls).toHaveLength(1);
  });

  it("rejects strict max before invoking credentials", async () => {
    const { generateText } = await import("../src/llm.js");
    await expect(
      generateText({
        model: "grok-4.7",
        input: "hello",
        thinkingLevel: "max",
        thinkingLevelPolicy: "strict",
      }),
    ).rejects.toThrow("not supported");
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    "api",
    "subscription",
  ] as const)("streams through xAI %s credentials with canonical metadata", async (access) => {
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({
      provider: "xai",
      access,
      model: "grok-4.7",
      input: "hello",
      thinkingLevel: "high",
    });
    expect(state.calls).toEqual([{ model: "grok-4.7", access }]);
    expect(state.requests[0]).toMatchObject({
      model: "grok-4.7",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
    });
    expect(state.requests[0]).not.toHaveProperty("providerOptions");
    expect(result).toMatchObject({
      provider: "xai",
      access,
      modelVersion: "grok-4.7",
      thoughts: "Think carefully.",
      text: '{"value":6}',
    });
    if (access === "subscription") {
      expect(result).toMatchObject({ costUsd: null, costSource: "subscription" });
      expect(result.apiEquivalentCostUsd).toBeGreaterThan(0);
    } else {
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.costSource).toBe("estimate");
    }
  });

  it.each([
    "api",
    "subscription",
  ] as const)("supports structured JSON using xAI %s", async (access) => {
    const { generateJson } = await import("../src/llm.js");
    const result = await generateJson({
      provider: "xai",
      access,
      model: "grok-4.7",
      input: "six",
      schema: z.object({ value: z.number() }),
    });
    expect(result.value).toEqual({ value: 6 });
    expect(state.calls).toEqual([{ model: "grok-4.7", access }]);
    expect(state.requests[0]?.response_format?.type).toBe("json_schema");
    expect(result.result).toMatchObject({ provider: "xai", access });
  });

  it.each([
    "api",
    "subscription",
  ] as const)("preserves xAI %s access and reasoning through function-tool turns", async (access) => {
    state.toolLoop = true;
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      provider: "xai",
      access,
      model: "grok-4.7",
      input: "multiply",
      thinkingLevel: "max",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => a * b,
        }),
      },
    });
    expect(result.text).toBe("6");
    expect(result.steps).toHaveLength(2);
    expect(state.requests.every((request) => request.reasoning_effort === "xhigh")).toBe(true);
    expect(
      result.steps.every(
        (step) =>
          step.thinking?.requestedLevel === "max" && step.thinking.effectiveLevel === "xhigh",
      ),
    ).toBe(true);
    expect(state.calls).toEqual([
      { model: "grok-4.7", access },
      { model: "grok-4.7", access },
    ]);
    expect(state.requests[1]?.messages.find((message: any) => message.tool_calls)).toMatchObject({
      reasoning_content: "Think carefully.",
    });
    if (access === "subscription") {
      expect(result.totalCostUsd).toBeNull();
      expect(
        result.steps.every(
          (step) => step.costSource === "subscription" && step.apiEquivalentCostUsd !== null,
        ),
      ).toBe(true);
    } else {
      expect(result.totalCostUsd).toBeGreaterThan(0);
    }
  });

  it("rejects unsupported provider-native tools before invoking credentials", async () => {
    const { generateText } = await import("../src/llm.js");
    await expect(
      generateText({
        provider: "xai",
        access: "subscription",
        model: "grok-4.7",
        input: "hello",
        tools: [{ type: "web-search" }],
      }),
    ).rejects.toThrow("xAI provider does not support provider-native tools");
    expect(state.calls).toHaveLength(0);
  });
});
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
