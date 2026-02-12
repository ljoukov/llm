import { describe, expect, it, vi } from "vitest";

let openAiRequests: any[] = [];
let openAiCallCount = 0;
let chatGptRequests: any[] = [];
let chatGptCallCount = 0;

vi.mock("../src/openai/calls.js", () => {
  const fakeClient = {
    responses: {
      stream: (request: any) => {
        openAiRequests.push(request);
        const callIndex = openAiCallCount++;
        const firstResponse = {
          id: "resp_1",
          model: "gpt-5.2",
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
          model: "gpt-5.2",
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
        return {
          text: "",
          reasoningText: "",
          reasoningSummaryText: "",
          toolCalls: [
            {
              kind: "custom",
              id: "ctc_1",
              callId: "call_custom_1",
              name: "apply_patch",
              input: "*** Begin Patch\n*** End Patch\n",
            },
          ],
          webSearchCalls: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          model: "gpt-5.3-codex",
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
        model: "gpt-5.3-codex",
        status: "completed",
        blocked: false,
      };
    },
  };
});

describe("runToolLoop custom tools", () => {
  it("supports OpenAI custom/freeform tools", async () => {
    openAiRequests = [];
    openAiCallCount = 0;

    const { customTool, runToolLoop } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "gpt-5.2",
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
    chatGptRequests = [];
    chatGptCallCount = 0;

    const { customTool, runToolLoop } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "chatgpt-gpt-5.3-codex",
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

  it("rejects custom/freeform tools for gemini provider", async () => {
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
