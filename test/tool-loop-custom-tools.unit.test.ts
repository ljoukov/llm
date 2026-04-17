import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

let openAiRequests: any[] = [];
let openAiCallCount = 0;
let chatGptRequests: any[] = [];
let chatGptCallCount = 0;
let geminiRequests: any[] = [];
let geminiCallCount = 0;
let openAiScenario: "custom" | "image_function" = "custom";
let chatGptScenario: "custom" | "image_function" = "custom";
let geminiScenario: "image_function" | "duplicate_function_calls" = "image_function";

vi.mock("../src/openai/calls.js", () => {
  const fakeClient = {
    responses: {
      stream: (request: any) => {
        openAiRequests.push(request);
        const callIndex = openAiCallCount++;
        const firstResponse =
          openAiScenario === "image_function"
            ? {
                id: "resp_1",
                model: "gpt-5.4-mini",
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                output: [
                  {
                    type: "function_call",
                    id: "fc_1",
                    call_id: "call_function_1",
                    name: "view_image",
                    arguments: '{"path":"image.png"}',
                  },
                ],
              }
            : {
                id: "resp_1",
                model: "gpt-5.4-mini",
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                output: [
                  {
                    type: "custom_tool_call",
                    id: "ctc_1",
                    call_id: "call_custom_1",
                    name: "apply_patch",
                    input: "*** Begin Patch\n*** End Patch\n",
                  },
                ],
              };
        const secondResponse = {
          id: "resp_2",
          model: "gpt-5.4-mini",
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
        };
        const finalResponse = callIndex === 0 ? firstResponse : secondResponse;
        return {
          async *[Symbol.asyncIterator]() {},
          async finalResponse() {
            return finalResponse;
          },
        };
      },
    },
  };
  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      chatGptRequests.push(options.request);
      const callIndex = chatGptCallCount++;
      if (callIndex === 0) {
        const toolCalls =
          chatGptScenario === "image_function"
            ? [
                {
                  kind: "function",
                  id: "fc_1",
                  callId: "call_function_1",
                  name: "view_image",
                  arguments: '{"path":"image.png"}',
                },
              ]
            : [
                {
                  kind: "custom",
                  id: "ctc_1",
                  callId: "call_custom_1",
                  name: "apply_patch",
                  input: "*** Begin Patch\n*** End Patch\n",
                },
              ];
        return {
          text: "",
          reasoningText: "",
          reasoningSummaryText: "",
          toolCalls,
          webSearchCalls: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          model: "gpt-5.3-codex-spark",
          status: "completed",
          blocked: false,
        };
      }
      return {
        text: "done",
        reasoningText: "",
        reasoningSummaryText: "",
        toolCalls: [],
        webSearchCalls: [],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        model: "gpt-5.3-codex-spark",
        status: "completed",
        blocked: false,
      };
    },
  };
});

vi.mock("../src/google/calls.js", () => {
  const fakeClient = {
    models: {
      generateContentStream: async (request: any) => {
        geminiRequests.push(request);
        const callIndex = geminiCallCount++;
        async function* stream() {
          if (callIndex === 0) {
            if (geminiScenario === "duplicate_function_calls") {
              yield {
                modelVersion: "gemini-3.1-pro-preview",
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  totalTokenCount: 15,
                },
                functionCalls: [
                  {
                    name: "echo_tool",
                    args: { value: "repeat" },
                  },
                  {
                    name: "echo_tool",
                    args: { value: "repeat" },
                  },
                ],
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        {
                          functionCall: {
                            name: "echo_tool",
                            args: { value: "repeat" },
                          },
                        },
                        {
                          functionCall: {
                            name: "echo_tool",
                            args: { value: "repeat" },
                          },
                        },
                      ],
                    },
                  },
                ],
              };
              return;
            }
            yield {
              modelVersion: "gemini-3.1-pro-preview",
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15,
              },
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        functionCall: {
                          id: "call_function_1",
                          name: "view_image",
                          args: { path: "image.png" },
                        },
                      },
                    ],
                  },
                },
              ],
            };
            return;
          }
          yield {
            modelVersion: "gemini-3.1-pro-preview",
            usageMetadata: {
              promptTokenCount: 8,
              candidatesTokenCount: 4,
              totalTokenCount: 12,
            },
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "done" }],
                },
              },
            ],
          };
        }
        return stream();
      },
    },
  };

  return {
    runGeminiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

async function importModuleCopy<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

describe("runToolLoop custom tools", () => {
  it("supports OpenAI custom/freeform tools", async () => {
    openAiScenario = "custom";
    openAiRequests = [];
    openAiCallCount = 0;

    const { customTool, runToolLoop } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gpt-5.4-mini",
      input: "apply a patch",
      tools: {
        apply_patch: customTool({
          description:
            "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: /[\\s\\S]*/",
          },
          execute: async (input) => `ok:${input.length}`,
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(openAiRequests).toHaveLength(2);
    expect(openAiRequests[0]?.tools?.[0]?.type).toBe("custom");
    expect(openAiRequests[0]?.tools?.[0]?.name).toBe("apply_patch");
    expect(openAiRequests[1]?.input?.[0]?.type).toBe("custom_tool_call_output");
  });

  it("supports ChatGPT custom/freeform tools", async () => {
    chatGptScenario = "custom";
    chatGptRequests = [];
    chatGptCallCount = 0;

    const { customTool, runToolLoop } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "chatgpt-gpt-5.4",
      input: "apply a patch",
      tools: {
        apply_patch: customTool({
          description:
            "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: /[\\s\\S]*/",
          },
          execute: async (input) => `ok:${input.length}`,
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(chatGptRequests).toHaveLength(2);
    expect(chatGptRequests[0]?.tools?.[0]?.type).toBe("custom");
    const appendedInput = chatGptRequests[1]?.input ?? [];
    expect(appendedInput.some((item: any) => item?.type === "custom_tool_call")).toBe(true);
    expect(appendedInput.some((item: any) => item?.type === "custom_tool_call_output")).toBe(true);
  });

  it("preserves OpenAI function_call_output content items for image tool outputs", async () => {
    openAiScenario = "image_function";
    openAiRequests = [];
    openAiCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gpt-5.4-mini",
      input: "inspect image",
      tools: {
        view_image: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => [
            {
              type: "input_image" as const,
              image_url: "data:image/png;base64,AAA",
            },
          ],
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(openAiRequests).toHaveLength(2);
    const outputItem = openAiRequests[1]?.input?.[0];
    expect(outputItem?.type).toBe("function_call_output");
    expect(Array.isArray(outputItem?.output)).toBe(true);
    expect(outputItem?.output?.[0]?.type).toBe("input_image");
    expect(outputItem?.output?.[0]?.image_url).toBe("data:image/png;base64,AAA");
  });

  it("stops OpenAI tool loops immediately after a successful terminal tool", async () => {
    openAiScenario = "image_function";
    openAiRequests = [];
    openAiCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gpt-5.4-mini",
      input: "finish",
      tools: {
        view_image: tool({
          terminal: true,
          inputSchema: z.object({ path: z.string() }),
          execute: async () => ({ status: "done", summary: "terminal ok" }),
        }),
      },
    });

    expect(result.text).toBe("terminal ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
    expect(openAiRequests).toHaveLength(1);
  });

  it("writes tool call artifacts and input media for logged OpenAI tool loops", async () => {
    openAiScenario = "image_function";
    openAiRequests = [];
    openAiCallCount = 0;

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-tool-loop-logging-"));
    try {
      const { createAgentLoggingSession, runWithAgentLoggingSession } = await import(
        "../src/agentLogging.js"
      );
      const { runToolLoop, tool } = await import("../src/llm.js");
      const session = createAgentLoggingSession({
        workspaceDir: tempRoot,
        mirrorToConsole: false,
      });

      await runWithAgentLoggingSession(session, async () => {
        await runToolLoop({
          model: "gpt-5.4-mini",
          input: "inspect image",
          tools: {
            view_image: tool({
              inputSchema: z.object({ path: z.string() }),
              execute: async () => [
                {
                  type: "input_image" as const,
                  image_url: "data:image/png;base64,AAA",
                },
              ],
            }),
          },
        });
      });
      await session.flush();

      const logsRoot = path.join(tempRoot, "llm_calls");
      const runDirs = (await fs.readdir(logsRoot)).sort();
      expect(runDirs).toHaveLength(2);

      const resolveCallDir = async (dirName: string): Promise<string> => {
        const runDir = path.join(logsRoot, dirName);
        const modelDirs = await fs.readdir(runDir);
        expect(modelDirs).toHaveLength(1);
        return path.join(runDir, modelDirs[0] ?? "");
      };

      const firstCallDir = await resolveCallDir(runDirs[0] ?? "");
      const secondCallDir = await resolveCallDir(runDirs[1] ?? "");

      expect(await fs.readFile(path.join(firstCallDir, "tool_call.txt"), "utf8")).toContain(
        "view_image",
      );
      expect(
        await fs.readFile(path.join(secondCallDir, "tool_call_response.txt"), "utf8"),
      ).toContain("function_call_output");
      expect(await fs.readFile(path.join(secondCallDir, "input-1.png"))).toEqual(
        Buffer.from("AAA", "base64"),
      );
      expect(await fs.readFile(path.join(secondCallDir, "response.txt"), "utf8")).toBe("done");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("shares tool call context across duplicate llm module instances", async () => {
    openAiScenario = "image_function";
    openAiRequests = [];
    openAiCallCount = 0;

    const [{ runToolLoop, tool }, { getCurrentToolCallContext }] = await Promise.all([
      importModuleCopy<typeof import("../src/llm.js")>("../src/llm.js?copy=tool-context-a"),
      importModuleCopy<typeof import("../src/llm.js")>("../src/llm.js?copy=tool-context-b"),
    ]);
    const observedContexts: unknown[] = [];

    const result = await runToolLoop({
      model: "gpt-5.4-mini",
      input: "inspect image",
      tools: {
        view_image: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => {
            observedContexts.push(getCurrentToolCallContext());
            return [
              {
                type: "input_image" as const,
                image_url: "data:image/png;base64,AAA",
              },
            ];
          },
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(observedContexts).toEqual([
      {
        toolName: "view_image",
        toolId: "turn1/tool1",
        turn: 1,
        toolIndex: 1,
      },
    ]);
  });

  it("preserves ChatGPT function_call_output content items for image tool outputs", async () => {
    chatGptScenario = "image_function";
    chatGptRequests = [];
    chatGptCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "chatgpt-gpt-5.4",
      input: "inspect image",
      tools: {
        view_image: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => [
            {
              type: "input_image" as const,
              image_url: "data:image/png;base64,AAA",
            },
          ],
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(chatGptRequests).toHaveLength(2);
    const appendedInput = chatGptRequests[1]?.input ?? [];
    const outputItem = appendedInput.find((item: any) => item?.type === "function_call_output");
    expect(Array.isArray(outputItem?.output)).toBe(true);
    expect(outputItem?.output?.[0]?.type).toBe("input_image");
    expect(outputItem?.output?.[0]?.image_url).toBe("data:image/png;base64,AAA");
  });

  it("stops ChatGPT tool loops immediately after a successful terminal tool", async () => {
    chatGptScenario = "image_function";
    chatGptRequests = [];
    chatGptCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "chatgpt-gpt-5.4",
      input: "finish",
      tools: {
        view_image: tool({
          terminal: true,
          inputSchema: z.object({ path: z.string() }),
          execute: async () => ({ status: "done", summary: "terminal ok" }),
        }),
      },
    });

    expect(result.text).toBe("terminal ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
    expect(chatGptRequests).toHaveLength(1);
  });

  it("omits filename on ChatGPT function_call_output image file references", async () => {
    chatGptScenario = "image_function";
    chatGptRequests = [];
    chatGptCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "chatgpt-gpt-5.4",
      input: "inspect image",
      tools: {
        view_image: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => [
            {
              type: "input_image" as const,
              file_id: "file_image_1",
              filename: "image.png",
            },
          ],
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(chatGptRequests).toHaveLength(2);
    const appendedInput = chatGptRequests[1]?.input ?? [];
    const outputItem = appendedInput.find((item: any) => item?.type === "function_call_output");
    expect(Array.isArray(outputItem?.output)).toBe(true);
    expect(outputItem?.output?.[0]).toMatchObject({
      type: "input_image",
      file_id: "file_image_1",
    });
    expect(outputItem?.output?.[0]?.filename).toBeUndefined();
  });

  it("encodes Gemini image tool outputs as functionResponse parts instead of data URLs in JSON", async () => {
    geminiScenario = "image_function";
    geminiRequests = [];
    geminiCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gemini-3.1-pro-preview",
      input: "inspect image",
      tools: {
        view_image: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async () => [
            {
              type: "input_image" as const,
              image_url: "data:image/png;base64,AAA",
            },
          ],
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(geminiRequests).toHaveLength(2);

    const responseContent = geminiRequests[1]?.contents?.at(-1);
    expect(responseContent?.role).toBe("user");
    expect(responseContent?.parts).toHaveLength(2);

    const responsePart = responseContent?.parts?.[0]?.functionResponse;
    expect(responsePart?.id).toBe("call_function_1");
    expect(responsePart?.name).toBe("view_image");
    expect(responsePart?.response?.output).toEqual([
      {
        type: "input_image",
        mimeType: "image/png",
        media: "attached-inline-data",
      },
    ]);
    expect(responsePart?.parts).toBeUndefined();
    expect(responseContent?.parts?.[1]).toEqual({
      inlineData: {
        data: "AAA=",
        mimeType: "image/png",
      },
    });
    expect(JSON.stringify(responsePart?.response)).not.toContain("data:image");
  });

  it("stops Gemini tool loops immediately after a successful terminal tool", async () => {
    geminiScenario = "image_function";
    geminiRequests = [];
    geminiCallCount = 0;

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gemini-3.1-pro-preview",
      input: "finish",
      tools: {
        view_image: tool({
          terminal: true,
          inputSchema: z.object({ path: z.string() }),
          execute: async () => ({ status: "done", summary: "terminal ok" }),
        }),
      },
    });

    expect(result.text).toBe("terminal ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
    expect(geminiRequests).toHaveLength(1);
  });

  it("preserves duplicate Gemini function calls with identical args", async () => {
    geminiScenario = "duplicate_function_calls";
    geminiRequests = [];
    geminiCallCount = 0;
    const executedValues: string[] = [];

    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gemini-3.1-pro-preview",
      input: "repeat twice",
      tools: {
        echo_tool: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => {
            executedValues.push(value);
            return { echoed: value };
          },
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(executedValues).toEqual(["repeat", "repeat"]);
    expect(geminiRequests).toHaveLength(2);
    const responseContent = geminiRequests[1]?.contents?.at(-1);
    expect(responseContent?.role).toBe("user");
    expect(
      responseContent?.parts?.filter((part: any) => part?.functionResponse?.name === "echo_tool"),
    ).toHaveLength(2);
  });

  it("rejects custom/freeform tools for gemini provider", async () => {
    openAiScenario = "custom";
    chatGptScenario = "custom";
    const { customTool, runToolLoop } = await import("../src/llm.js");

    await expect(
      runToolLoop({
        model: "gemini-2.5-pro",
        input: "test",
        tools: {
          custom_only: customTool({
            execute: async (input) => input,
          }),
        },
      }),
    ).rejects.toThrow("Gemini provider does not support custom/freeform tools");
  });
});
