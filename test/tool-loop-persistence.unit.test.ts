import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  runAgentLoop,
  runToolLoop,
  tool,
  type ToolLoopCheckpoint,
  type ToolLoopPersistence,
} from "../src/index.js";

const mock = vi.hoisted(() => ({ requests: [] as any[], calls: 0 }));
vi.mock("../src/openai/calls.js", () => ({
  DEFAULT_OPENAI_REASONING_EFFORT: "medium",
  runOpenAiCall: async (call: any) =>
    call({
      responses: {
        stream(request: any) {
          mock.requests.push(request);
          const index = mock.calls++;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "response.reasoning_summary_text.delta", delta: "Exposed summary" };
            },
            async finalResponse() {
              return {
                id: `response-${index}`,
                model: "gpt-6-luna",
                output:
                  index === 0
                    ? [
                        {
                          type: "reasoning",
                          id: "reasoning-1",
                          summary: [{ type: "summary_text", text: "Exposed summary" }],
                          encrypted_content: "opaque-state",
                        },
                        {
                          type: "function_call",
                          id: "fc1",
                          call_id: "call1",
                          name: "compute",
                          arguments: '{"x":7}',
                        },
                      ]
                    : [
                        {
                          type: "message",
                          role: "assistant",
                          content: [{ type: "output_text", text: "done" }],
                        },
                      ],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              };
            },
          };
        },
      },
    }),
}));
vi.mock("../src/openai/chatgpt-codex.js", () => ({
  collectChatGptCodexResponse: async (options: any) => {
    mock.requests.push(options.request);
    const index = mock.calls++;
    options.onDelta?.({ thoughtDelta: "Exposed summary" });
    return {
      text: index ? "done" : "",
      replayItems: [
        {
          type: "reasoning",
          id: "r1",
          summary: [{ type: "summary_text", text: "Exposed summary" }],
          encrypted_content: "opaque-state",
        },
      ],
      reasoningSummaryText: "Exposed summary",
      reasoningText: "",
      model: "gpt-6-luna",
      status: "completed",
      blocked: false,
      toolCalls: index
        ? []
        : [{ kind: "function", id: "fc1", callId: "call1", name: "compute", arguments: '{"x":7}' }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
  },
}));

function memory() {
  let saved: ToolLoopCheckpoint | null = null;
  let fail = false;
  const persistence: ToolLoopPersistence = {
    identity: "test-environment-v1",
    load: async () => saved,
    save: async (checkpoint) => {
      if (fail) throw new Error("disk unavailable");
      saved = structuredClone(checkpoint);
    },
  };
  return {
    persistence,
    saved: () => saved,
    fail: () => {
      fail = true;
    },
  };
}

describe("persistent tool loops", () => {
  beforeEach(() => {
    mock.calls = 0;
    mock.requests = [];
  });
  for (const access of ["api", "subscription"] as const) {
    it(`restores ${access} native history and never executes a completed tool twice`, async () => {
      const store = memory();
      let executions = 0;
      const tools = {
        compute: tool({
          description: "Compute",
          inputSchema: z.object({ x: z.number() }),
          execute: ({ x }) => {
            executions++;
            return x * 2;
          },
        }),
      };
      const request = {
        provider: "openai" as const,
        access,
        model: "gpt-6-luna" as const,
        input: "compute",
        tools,
        maxSteps: 3,
        persistence: store.persistence,
      };
      await expect(
        runAgentLoop({
          ...request,
          filesystemTool: false,
          subagentTool: false,
          logging: false,
          onEvent: (event) => {
            if (event.type === "tool_call" && event.phase === "completed")
              throw new Error("worker killed");
          },
        }),
      ).rejects.toThrow("worker killed");
      expect(executions).toBe(1);
      expect(mock.calls).toBe(1);
      const result = await runAgentLoop({
        ...request,
        filesystemTool: false,
        subagentTool: false,
        logging: false,
      });
      expect(result.text).toBe("done");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]?.thoughts).toBe("Exposed summary");
      expect(JSON.stringify(mock.requests.at(-1).input)).toContain("opaque-state");
      expect(executions).toBe(1);
      expect(mock.calls).toBe(2);
      expect(JSON.stringify(mock.requests.at(-1).input)).toContain("function_call_output");
      if (access === "api") {
        expect(mock.requests.at(-1).previous_response_id).toBeUndefined();
        expect(JSON.stringify(mock.requests.at(-1).input)).toContain("opaque-state");
      }
      expect(await runToolLoop(request)).toEqual(result);
      expect(mock.calls).toBe(2);
      expect(executions).toBe(1);
    });
  }
  it("saves the model response before executing tools, and stops on a failed checkpoint", async () => {
    const store = memory();
    let executions = 0;
    const request = {
      provider: "openai" as const,
      model: "gpt-6-luna" as const,
      input: "compute",
      maxSteps: 3,
      persistence: store.persistence,
      tools: {
        compute: tool({
          description: "Compute",
          inputSchema: z.object({ x: z.number() }),
          execute: () => {
            executions++;
            expect(Object.keys(store.saved()!.models)).toEqual(["1"]);
            store.fail();
            return "ok";
          },
        }),
      },
    };
    await expect(runToolLoop(request)).rejects.toThrow("disk unavailable");
    expect(mock.calls).toBe(1);
    expect(executions).toBe(1);
    await expect(runToolLoop(request)).rejects.toThrow("reconcile its effects");
    expect(executions).toBe(1);
  });
  it("rejects changed inputs before making another request", async () => {
    const store = memory();
    const tools = {
      compute: tool({
        description: "Compute",
        inputSchema: z.object({ x: z.number() }),
        execute: () => "ok",
      }),
    };
    const request = {
      provider: "openai" as const,
      model: "gpt-6-luna" as const,
      input: "compute",
      tools,
      maxSteps: 3,
      persistence: store.persistence,
    };
    await runToolLoop(request);
    await expect(runToolLoop({ ...request, input: "different task" })).rejects.toThrow("differ");
    expect(mock.calls).toBe(2);
  });

  it("does not let a nested custom-tool loop inherit the parent journal", async () => {
    const store = memory();
    const result = await runToolLoop({
      provider: "openai",
      model: "gpt-6-luna",
      input: "outer",
      maxSteps: 3,
      persistence: store.persistence,
      tools: {
        compute: tool({
          inputSchema: z.object({ x: z.number() }),
          execute: async () => {
            return (
              await runToolLoop({
                provider: "openai",
                model: "gpt-6-luna",
                input: "inner",
                tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
              })
            ).text;
          },
        }),
      },
    });
    expect(result.steps[0]?.toolCalls[0]?.error).toBeUndefined();
    expect(result.steps[0]?.toolCalls[0]?.output).toBe("done");
    expect(mock.calls).toBe(3);
    expect(Object.keys(store.saved()!.models)).toEqual(["1", "2"]);
  });
});
