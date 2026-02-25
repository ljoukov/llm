import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

const runToolLoopMock = vi.fn(async (_request: unknown): Promise<any> => {
  return {
    text: "done",
    thoughts: "",
    steps: [],
    totalCostUsd: 0,
  };
});

vi.mock("../src/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm.js")>("../src/llm.js");
  return {
    ...actual,
    runToolLoop: runToolLoopMock,
  };
});

describe("runAgentLoop", () => {
  it("auto-selects codex filesystem tools and merges custom tools", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    const customTools = {
      ping: {
        inputSchema: z.object({}),
        execute: async () => "pong",
      },
    };

    const result = await runAgentLoop({
      model: "chatgpt-gpt-5.3-codex-spark",
      input: "test",
      filesystemTool: true,
      tools: customTools,
    });

    expect(result.text).toBe("done");
    expect(runToolLoopMock).toHaveBeenCalledTimes(1);

    const call = runToolLoopMock.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(call.tools).sort()).toEqual([
      "apply_patch",
      "grep_files",
      "list_dir",
      "ping",
      "read_file",
    ]);
  });

  it("accepts filesystem_tool alias and uses gemini tool profile for gemini models", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await runAgentLoop({
      model: "gemini-2.5-pro",
      input: "test",
      filesystem_tool: true,
    });

    const call = runToolLoopMock.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(call.tools).sort()).toEqual([
      "glob",
      "grep_search",
      "list_directory",
      "read_file",
      "replace",
      "write_file",
    ]);
  });

  it("uses model-agnostic filesystem profile for fireworks models", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await runAgentLoop({
      model: "kimi-k2.5",
      input: "test",
      filesystemTool: true,
    });

    const call = runToolLoopMock.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(call.tools).sort()).toEqual([
      "glob",
      "grep_search",
      "list_directory",
      "read_file",
      "replace",
      "write_file",
    ]);
  });

  it("adds codex-style subagent tools when enabled", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await runAgentLoop({
      model: "gpt-5.2",
      input: "delegate",
      subagentTool: true,
    });

    const call = runToolLoopMock.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
      instructions?: string;
    };
    expect(Object.keys(call.tools).sort()).toEqual([
      "close_agent",
      "resume_agent",
      "send_input",
      "spawn_agent",
      "wait",
    ]);
    expect(call.instructions).toContain("spawn_agent");
    expect(call.instructions).toContain("wait");
  });

  it("accepts subagent_tool alias and supports disabling codex prompt pattern", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await runAgentLoop({
      model: "gpt-5.2",
      input: "delegate",
      subagent_tool: {
        promptPattern: "none",
      },
    });

    const call = runToolLoopMock.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
      instructions?: string;
    };
    expect(Object.keys(call.tools).sort()).toEqual([
      "close_agent",
      "resume_agent",
      "send_input",
      "spawn_agent",
      "wait",
    ]);
    expect(call.instructions).toBeUndefined();
  });

  it("rejects duplicate tool names", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await expect(
      runAgentLoop({
        model: "chatgpt-gpt-5.3-codex-spark",
        input: "test",
        filesystemTool: true,
        tools: {
          read_file: {
            inputSchema: z.object({}),
            execute: async () => "shadowed",
          },
        },
      }),
    ).rejects.toThrow('Duplicate tool name "read_file"');
  });

  it("rejects duplicate subagent tool names", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await expect(
      runAgentLoop({
        model: "gpt-5.2",
        input: "test",
        subagentTool: true,
        tools: {
          wait: {
            inputSchema: z.object({}),
            execute: async () => "shadowed",
          },
        },
      }),
    ).rejects.toThrow('Duplicate tool name "wait"');
  });

  it("requires at least one tool when filesystem tools are disabled", async () => {
    runToolLoopMock.mockClear();
    const { runAgentLoop } = await import("../src/agent.js");

    await expect(
      runAgentLoop({
        model: "gpt-5.2",
        input: "test",
      }),
    ).rejects.toThrow("runAgentLoop requires at least one tool");
  });

  it("emits telemetry lifecycle events and forwards stream events to both sinks", async () => {
    runToolLoopMock.mockClear();
    runToolLoopMock.mockImplementationOnce(async (request: unknown) => {
      const typed = request as {
        onEvent?: (event: { type: "delta"; channel: "response"; text: string }) => void;
      };
      typed.onEvent?.({ type: "delta", channel: "response", text: "hello" });
      return {
        text: "done",
        thoughts: "",
        steps: [
          {
            step: 1,
            modelVersion: "chatgpt-gpt-5.3-codex",
            toolCalls: [{ toolName: "list_dir", input: {}, output: {} }],
            usage: { promptTokens: 10, responseTokens: 3, totalTokens: 13 },
            costUsd: 0.01,
          },
        ],
        totalCostUsd: 0.01,
      };
    });

    const events: unknown[] = [];
    const onEvent = vi.fn();
    const { runAgentLoop } = await import("../src/agent.js");

    await runAgentLoop({
      model: "chatgpt-gpt-5.3-codex",
      input: "test",
      filesystemTool: true,
      onEvent,
      telemetry: {
        includeLlmStreamEvents: true,
        sink: {
          emit: (event) => {
            events.push(event);
          },
        },
      },
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(3);
    const [started, streamed, completed] = events as Array<{
      type: string;
      runId: string;
      depth: number;
      parentRunId?: string;
      success?: boolean;
      stepCount?: number;
      toolCallCount?: number;
      totalCostUsd?: number;
    }>;
    expect(started).toBeDefined();
    expect(streamed).toBeDefined();
    expect(completed).toBeDefined();
    if (!started || !streamed || !completed) {
      throw new Error("Expected started/stream/completed telemetry events.");
    }
    expect(started.type).toBe("agent.run.started");
    expect(streamed.type).toBe("agent.run.stream");
    expect(completed.type).toBe("agent.run.completed");
    expect(completed.success).toBe(true);
    expect(completed.stepCount).toBe(1);
    expect(completed.toolCallCount).toBe(1);
    expect(completed.totalCostUsd).toBe(0.01);
    expect(started.depth).toBe(0);
    expect(started.parentRunId).toBeUndefined();
    expect(started.runId).toBe(streamed.runId);
    expect(started.runId).toBe(completed.runId);
  });

  it("propagates telemetry context across subagent runs", async () => {
    runToolLoopMock.mockClear();
    let callIndex = 0;
    runToolLoopMock.mockImplementation(async (request: unknown) => {
      callIndex += 1;
      if (callIndex === 1) {
        const typed = request as {
          tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>;
        };
        const spawn = typed.tools.spawn_agent;
        const wait = typed.tools.wait;
        const close = typed.tools.close_agent;
        if (!spawn || !wait || !close) {
          throw new Error("Missing expected subagent control tools in parent run.");
        }
        const spawnResult = (await spawn.execute({
          prompt: "Child task",
        })) as { agent_id: string };
        await wait.execute({ agent_id: spawnResult.agent_id, timeout_ms: 10_000 });
        await close.execute({ agent_id: spawnResult.agent_id });
        return {
          text: "parent",
          thoughts: "",
          steps: [
            {
              step: 1,
              modelVersion: "gpt-5.2",
              toolCalls: [{ toolName: "spawn_agent", input: {}, output: { agent_id: spawnResult.agent_id } }],
              costUsd: 0,
            },
          ],
          totalCostUsd: 0,
        };
      }
      return {
        text: "child",
        thoughts: "",
        steps: [
          {
            step: 1,
            modelVersion: "gpt-5.2",
            toolCalls: [],
            costUsd: 0,
          },
        ],
        totalCostUsd: 0,
      };
    });

    const events: Array<{ type: string; runId: string; depth: number; parentRunId?: string }> = [];
    const { runAgentLoop } = await import("../src/agent.js");

    await runAgentLoop({
      model: "gpt-5.2",
      input: "delegate",
      subagentTool: {
        enabled: true,
        maxAgents: 2,
        maxDepth: 2,
      },
      telemetry: {
        sink: {
          emit: (event) => {
            events.push(event as { type: string; runId: string; depth: number; parentRunId?: string });
          },
        },
      },
    });

    expect(runToolLoopMock).toHaveBeenCalledTimes(2);
    const started = events.filter((event) => event.type === "agent.run.started");
    const completed = events.filter((event) => event.type === "agent.run.completed");
    expect(started).toHaveLength(2);
    expect(completed).toHaveLength(2);

    const parentStarted = started.find((event) => event.depth === 0);
    const childStarted = started.find((event) => event.depth === 1);
    const childCompleted = completed.find((event) => event.depth === 1);
    expect(parentStarted).toBeDefined();
    expect(childStarted).toBeDefined();
    expect(childCompleted).toBeDefined();
    expect(childStarted?.parentRunId).toBe(parentStarted?.runId);
    expect(childCompleted?.parentRunId).toBe(parentStarted?.runId);
  });

  it("flushes telemetry sink after all emits settle", async () => {
    runToolLoopMock.mockClear();
    runToolLoopMock.mockImplementationOnce(async () => {
      return {
        text: "done",
        thoughts: "",
        steps: [],
        totalCostUsd: 0,
      };
    });

    const order: string[] = [];
    const { runAgentLoop } = await import("../src/agent.js");
    await runAgentLoop({
      model: "gpt-5.2",
      input: "test",
      subagentTool: true,
      telemetry: {
        sink: {
          emit: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            order.push("emit");
          },
          flush: async () => {
            order.push("flush");
          },
        },
      },
    });

    expect(order.includes("emit")).toBe(true);
    expect(order[order.length - 1]).toBe("flush");
  });
});
