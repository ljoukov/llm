import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installMockStorageEnv, resetMockStorageState } from "./helpers/mock-storage.js";

vi.mock("@google-cloud/storage", async () => await import("./helpers/mock-storage.js"));

let requests: any[] = [];
let toolInput: unknown = { a: 2, b: 3 };
let toolName = "multiply";
let finishReason = "tool_use";
let toolResults: any[] = [];

vi.mock("../src/claude/calls.js", () => ({
  runClaudeQuery: async (request: any) => {
    requests.push(request);
    const usage = { input_tokens: 10, output_tokens: 6 };
    const assistant = (turn: number, content: any[], stopReason: string) => {
      request.onAssistantMessage?.(
        {
          id: `msg_${turn}`,
          type: "message",
          role: "assistant",
          model: request.model,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        },
        { turn },
      );
    };
    request.onDelta?.("thought", "Use the tool.");
    assistant(
      1,
      [
        { type: "thinking", thinking: "Use the tool.", signature: "opaque-signed-thinking" },
        ...(finishReason === "tool_use"
          ? [{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }]
          : []),
      ],
      finishReason,
    );
    if (finishReason !== "tool_use") {
      return {
        model: request.model,
        text: "",
        thoughts: "Use the tool.",
        finishReason,
        usage,
      };
    }
    const definition = request.tools.find((entry: any) => entry.name === toolName);
    const output = await definition.execute(toolInput, {
      callId: "toolu_1",
      turn: 1,
      toolIndex: 1,
    });
    toolResults.push(output);
    if (output.terminal) {
      return {
        model: request.model,
        text: "",
        thoughts: "Use the tool.",
        finishReason: "tool_use",
        usage,
      };
    }
    request.onDelta?.("thought", "The tool returned six.");
    request.onDelta?.("response", "6");
    assistant(
      2,
      [
        { type: "thinking", thinking: "The tool returned six.", signature: "another-signature" },
        { type: "text", text: "6" },
      ],
      "end_turn",
    );
    return {
      model: request.model,
      text: "6",
      thoughts: "The tool returned six.",
      finishReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 12 },
    };
  },
}));

describe("Claude subscription tool loops", () => {
  beforeEach(() => {
    requests = [];
    toolInput = { a: 2, b: 3 };
    toolName = "multiply";
    finishReason = "tool_use";
    toolResults = [];
    installMockStorageEnv();
    resetMockStorageState();
  });

  it.each([
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
  ] as const)("executes %s tools with public events and per-turn usage", async (model) => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    const events: any[] = [];
    const result = await runToolLoop({
      model,
      input: "Multiply",
      thinkingLevel: "low",
      maxSteps: 3,
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
    expect(result.steps.every((step) => step.modelVersion === model)).toBe(true);
    expect(result.thoughts).toBe("The tool returned six.");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.toolCalls[0]).toMatchObject({
      toolName: "multiply",
      callId: "toolu_1",
      input: { a: 2, b: 3 },
      output: { value: 6 },
    });
    expect(result.steps[0]?.finishReason).toBe("tool_use");
    expect(result.steps[1]?.usage).toMatchObject({ promptTokens: 10, responseTokens: 6 });
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model, maxSteps: 3, maxOutputTokens: 1000, effort: "low" });
    expect(toolResults[0].content).toBe('{"value":6}');
    expect(
      events.filter((event) => event.type === "tool_call").map((event) => event.phase),
    ).toEqual(["started", "completed"]);
  });

  it("returns invalid tool arguments to the runtime without executing the function", async () => {
    toolInput = { a: "bad", b: 3 };
    const execute = vi.fn();
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "claude-haiku-5-5",
      input: "Multiply",
      tools: {
        multiply: tool({ inputSchema: z.object({ a: z.number(), b: z.number() }), execute }),
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.steps[0]?.toolCalls[0]?.error).toBeTruthy();
    expect(toolResults[0].isError).toBe(true);
  });

  it("stops at terminal tools and returns the terminal output", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
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
    expect(result.steps).toHaveLength(1);
    expect(toolResults[0].terminal).toBe(true);
  });

  it("returns native image blocks from function tools", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      model: "claude-haiku-5-5",
      input: "Multiply",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: () => [{ type: "input_image", image_url: "data:image/png;base64,AQID" }],
        }),
      },
    });
    expect(toolResults[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ]);
  });

  it("preserves output-limit finish reasons without querying again", async () => {
    finishReason = "max_tokens";
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "claude-opus-5-5",
      input: "Multiply",
      tools: { multiply: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(result.steps[0]?.finishReason).toBe("max_tokens");
    expect(result.thoughts).toBe("Use the tool.");
    expect(requests).toHaveLength(1);
    expect(toolResults).toHaveLength(0);
  });

  it("rejects unsupported native and freeform tools before launching the runtime", async () => {
    const { runToolLoop, tool, customTool } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        model: "claude-haiku-5-5",
        input: "Hi",
        tools: { custom: customTool({ execute: (input) => input }) },
      }),
    ).rejects.toThrow("do not support custom/freeform");
    await expect(
      runToolLoop({
        model: "claude-haiku-5-5",
        input: "Hi",
        modelTools: [{ type: "web-search" }],
        tools: { multiply: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    ).rejects.toThrow("do not support provider-native");
    expect(requests).toHaveLength(0);
  });

  it("inherits the subscription model for subagents without exposing a model override", async () => {
    const { createSubagentToolController, resolveSubagentToolConfig } = await import(
      "../src/agent/subagents.js"
    );
    const runSubagent = vi.fn(async () => ({
      text: "done",
      thoughts: "",
      steps: [],
      totalCostUsd: 0,
    }));
    const controller = createSubagentToolController({
      config: resolveSubagentToolConfig({ minWaitTimeoutMs: 1 }, 0),
      parentDepth: 0,
      parentModel: "claude-sonnet-5-5",
      runSubagent,
    });
    const spawn = controller.tools.spawn_agent as any;
    const wait = controller.tools.wait as any;
    const parsed = spawn.inputSchema.parse({ message: "task", model: "sonnet-5-5" });
    expect(parsed).not.toHaveProperty("model");
    const spawned = await spawn.execute(parsed);
    expect(spawned.agent.model).toBe("claude-sonnet-5-5");
    await wait.execute({ agent_id: spawned.agent_id, timeout_ms: 200 });
    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5-5" }),
    );
    await controller.closeAll();
  });
});
