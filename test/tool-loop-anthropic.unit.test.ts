import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installMockStorageEnv, resetMockStorageState } from "./helpers/mock-storage.js";

vi.mock("@google-cloud/storage", async () => await import("./helpers/mock-storage.js"));

let requests: any[] = [];
let toolInput: unknown = { a: 2, b: 3 };
let toolName = "multiply";
let finishReason = "tool_use";

vi.mock("../src/anthropic/calls.js", () => ({
  runAnthropicCall: async (fn: (client: any) => Promise<unknown>) =>
    fn({
      streamMessage: async (request: any, options: any) => {
        requests.push(structuredClone(request));
        const first = requests.length === 1;
        options.onDelta?.("thought", first ? "Use the tool." : "The tool returned six.");
        if (!first) options.onDelta?.("response", "6");
        return {
          model: request.model,
          stop_reason: first ? finishReason : "end_turn",
          content: first
            ? [
                {
                  type: "thinking",
                  thinking: "Use the tool.",
                  signature: "opaque-signed-thinking",
                },
                { type: "redacted_thinking", data: "opaque-redaction" },
                ...(finishReason === "tool_use"
                  ? [{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }]
                  : []),
              ]
            : [
                {
                  type: "thinking",
                  thinking: "The tool returned six.",
                  signature: "another-signature",
                },
                { type: "text", text: "6" },
              ],
          usage: { input_tokens: 10, output_tokens: 6 },
        };
      },
    }),
}));

describe("Anthropic tool loops", () => {
  beforeEach(() => {
    requests = [];
    toolInput = { a: 2, b: 3 };
    toolName = "multiply";
    finishReason = "tool_use";
    installMockStorageEnv();
    resetMockStorageState();
  });

  it.each([
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
  ] as const)("executes and preserves signed thinking for %s", async (model) => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    const events: any[] = [];
    const result = await runToolLoop({
      provider: "anthropic",
      model,
      input: "Multiply",
      thinkingLevel: "low",
      maxOutputTokens: 1000,
      onEvent: (event) => events.push(event),
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });
    expect(result.text).toBe("6");
    expect(result.thoughts).toBe("The tool returned six.");
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((step) => step.modelVersion === model)).toBe(true);
    expect(result.steps[0]?.toolCalls[0]?.output).toEqual({ value: 6 });
    expect(result.steps[0]?.finishReason).toBe("tool_use");
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(requests[1].messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Use the tool.", signature: "opaque-signed-thinking" },
          { type: "redacted_thinking", data: "opaque-redaction" },
          { type: "tool_use", id: "toolu_1", name: "multiply", input: { a: 2, b: 3 } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"value":6}' }],
      },
    ]);
    expect(requests.every((request) => request.max_tokens === 1000)).toBe(true);
    expect(requests.every((request) => request.model === model)).toBe(true);
    expect(requests[0].output_config.effort).toBe("low");
    expect(
      events.filter((event) => event.type === "tool_call").map((event) => event.phase),
    ).toEqual(["started", "completed"]);
  });

  it("returns validation errors to Claude without executing the function", async () => {
    toolInput = { a: "bad", b: 3 };
    const execute = vi.fn();
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      input: "Multiply",
      tools: {
        multiply: tool({ inputSchema: z.object({ a: z.number(), b: z.number() }), execute }),
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.steps[0]?.toolCalls[0]?.error).toBeTruthy();
    expect(requests[1].messages.at(-1).content[0].is_error).toBe(true);
  });

  it("supports terminal tools", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      input: "Multiply",
      tools: {
        multiply: tool({
          terminal: true,
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: () => "Done",
        }),
      },
    });
    expect(result.text).toBe("Done");
    expect(requests).toHaveLength(1);
  });

  it("roundtrips oversized tool output through canonical text files", async () => {
    const text = "A large tool result.\n".repeat(60_000);
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      input: "Multiply",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: () => text,
        }),
      },
    });
    const content = requests[1].messages.at(-1).content[0].content;
    expect(
      content.some(
        (block: any) =>
          block.type === "document" && block.source.type === "text" && block.source.data === text,
      ),
    ).toBe(true);
  });

  it("passes image tool outputs through native content blocks", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      input: "Multiply",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: () => [{ type: "input_image", image_url: "data:image/png;base64,AQID" }],
        }),
      },
    });
    expect(requests[1].messages.at(-1).content[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ]);
  });

  it("preserves output-limit finish reasons without rerunning a turn", async () => {
    finishReason = "max_tokens";
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      provider: "anthropic",
      model: "claude-opus-5-5",
      input: "Multiply",
      tools: { multiply: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(result.steps[0]?.finishReason).toBe("max_tokens");
    expect(result.thoughts).toBe("Use the tool.");
    expect(requests).toHaveLength(1);
  });

  it("rejects native and custom tools explicitly", async () => {
    const { runToolLoop, tool, customTool } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        input: "Hi",
        tools: { custom: customTool({ execute: (input) => input }) },
      }),
    ).rejects.toThrow("does not support custom/freeform");
    await expect(
      runToolLoop({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        input: "Hi",
        modelTools: [{ type: "web-search" }],
        tools: { multiply: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    ).rejects.toThrow("does not support provider-native");
    expect(requests).toHaveLength(0);
  });
});
