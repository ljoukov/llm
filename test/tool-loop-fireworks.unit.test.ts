import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let callCount = 0;

vi.mock("../src/fireworks/calls.js", () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          const current = callCount++;
          if (current === 0) {
            return {
              model: "kimi-k2.5",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
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
                total_tokens: 15,
              },
            };
          }

          return {
            model: "kimi-k2.5",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "6",
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
  it("executes function tools for kimi-k2.5", async () => {
    requests = [];
    callCount = 0;
    const { runToolLoop, tool } = await import("../src/llm.js");

    const result = await runToolLoop({
      model: "kimi-k2.5",
      input: "Use multiply then return result",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });

    expect(result.text).toBe("6");
    expect(result.steps).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.[0]?.function?.name).toBe("multiply");
    const secondMessages = requests[1]?.messages ?? [];
    expect(secondMessages.some((m: any) => m?.role === "tool")).toBe(true);
  });

  it("rejects custom/freeform tools for Fireworks provider", async () => {
    const { customTool, runToolLoop } = await import("../src/llm.js");

    await expect(
      runToolLoop({
        model: "glm-5",
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
