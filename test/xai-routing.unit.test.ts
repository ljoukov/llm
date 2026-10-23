import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; access: string }>,
  requests: [] as Array<Record<string, any>>,
  toolLoop: false,
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
                model: request.model,
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
});

describe("xAI shared inference routes", () => {
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
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => a * b,
        }),
      },
    });
    expect(result.text).toBe("6");
    expect(result.steps).toHaveLength(2);
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
