import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let callCount = 0;

vi.mock("../src/fireworks/calls.js", () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(structuredClone(request));
          const current = callCount++;
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
