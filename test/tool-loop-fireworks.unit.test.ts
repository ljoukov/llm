import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let callCount = 0;
let responseOverride: any = null;

vi.mock("../src/fireworks/calls.js", () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(structuredClone(request));
          const current = callCount++;
          if (responseOverride) return structuredClone(responseOverride);
          if (current === 0) {
            return {
              model: "kimi-k3",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    reasoning_content: "  Use the multiply tool.\n",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "multiply",
                          arguments: JSON.stringify({ a: 2, b: 3 }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                completion_tokens_details: { reasoning_tokens: 2 },
                total_tokens: 15,
              },
            };
          }

          return {
            model: "kimi-k3",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "6",
                  reasoning_content: "The tool returned six.",
                },
              },
            ],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 4,
              total_tokens: 12,
            },
          };
        },
      },
    },
  };

  return {
    runFireworksCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("runToolLoop (Fireworks)", () => {
  beforeEach(() => {
    requests = [];
    callCount = 0;
    responseOverride = null;
  });
  it.each([
    "deepseek-v4.1-flash-1017",
    "glm-5.3",
    "kimi-k3",
  ] as const)("executes reasoning function tools for %s", async (model) => {
    requests = [];
    callCount = 0;
    const { runToolLoop, tool } = await import("../src/llm.js");

    const result = await runToolLoop({
      model,
      thinkingLevel: "high",
      input: "Use multiply then return result",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });

    expect(result.text).toBe("6");
    expect(result.thoughts).toBe("The tool returned six.");
    expect(result.steps[0]?.thoughts).toBe("  Use the multiply tool.\n");
    expect(result.steps[0]?.usage?.thinkingTokens).toBe(2);
    expect(result.steps[0]?.usage?.responseTokens).toBe(3);
    expect(requests[0]?.reasoning_effort).toBe("high");
    expect(requests[0]).not.toHaveProperty("max_tokens");
    expect(result.steps.map((step) => step.finishReason)).toEqual(["tool_calls", "stop"]);
    expect(result.steps).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.[0]?.function?.name).toBe("multiply");
    const secondMessages = requests[1]?.messages ?? [];
    expect(secondMessages.some((m: any) => m?.role === "tool")).toBe(true);
    expect(secondMessages.find((m: any) => m?.tool_calls)?.reasoning_content).toBe(
      "  Use the multiply tool.\n",
    );
  });

  it.each([
    ["deepseek-v4.1-flash-1017", "ultra", "max"],
    ["glm-5.3", "xhigh", "xhigh"],
    ["kimi-k3", "max", "max"],
  ] as const)("maps %s thinking %s to %s", async (model, thinkingLevel, expectedEffort) => {
    requests = [];
    callCount = 0;
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      model,
      thinkingLevel,
      input: "Use multiply",
      tools: {
        multiply: tool({
          terminal: true,
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });
    expect(requests[0]?.reasoning_effort).toBe(expectedEffort);
  });

  it("forwards maxOutputTokens on each Fireworks completion", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      model: "deepseek-v4.1-flash-1017",
      input: "Use multiply then return result",
      maxOutputTokens: 131_072,
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.max_tokens).toBe(131_072);
      expect(request).not.toHaveProperty("max_completion_tokens");
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid maxOutputTokens %s before inference", async (maxOutputTokens) => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        model: "kimi-k3",
        input: "test",
        maxOutputTokens,
        tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    ).rejects.toThrow("maxOutputTokens must be a positive safe integer");
    expect(requests).toHaveLength(0);
  });

  it.each([
    "gpt-6-luna",
    "chatgpt-gpt-6-luna",
    "gemini-3.1-pro-preview",
  ] as const)("rejects maxOutputTokens for unsupported route %s before inference", async (model) => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        model,
        input: "test",
        maxOutputTokens: 1024,
        tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    ).rejects.toThrow("maxOutputTokens is only supported for Fireworks tool loops");
    expect(requests).toHaveLength(0);
  });

  it("retains a reasoning-only length stop in steps and events without retrying", async () => {
    responseOverride = {
      model: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
      choices: [
        {
          finish_reason: "length",
          message: { content: null, reasoning_content: "unfinished work" },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 13,
      },
    };
    const events: unknown[] = [];
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "deepseek-v4.1-flash-1017",
      input: "test",
      maxOutputTokens: 3,
      onEvent: (event) => events.push(event),
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(requests).toHaveLength(1);
    expect(result.text).toBe("");
    expect(result.thoughts).toBe("unfinished work");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.finishReason).toBe("length");
    expect(result.steps[0]?.usage?.thinkingTokens).toBe(3);
    expect(result.steps[0]?.usage?.responseTokens).toBe(0);
    expect(events).toContainEqual({
      type: "model",
      modelVersion: responseOverride.model,
      finishReason: "length",
    });
  });

  it("preserves unknown provider finish reasons without reclassifying them", async () => {
    responseOverride = {
      model: "kimi-k3",
      choices: [{ finish_reason: "vendor_future_stop", message: { content: "6" } }],
    };
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "kimi-k3",
      input: "test",
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(result.steps[0]?.finishReason).toBe("vendor_future_stop");
    expect(result.text).toBe("6");
  });

  it("rejects custom/freeform tools for Fireworks provider", async () => {
    const { customTool, runToolLoop } = await import("../src/llm.js");

    await expect(
      runToolLoop({
        model: "glm-5.3",
        input: "test",
        tools: {
          custom_only: customTool({
            execute: async (input) => input,
          }),
        },
      }),
    ).rejects.toThrow("Fireworks provider does not support custom/freeform tools");
  });
});
