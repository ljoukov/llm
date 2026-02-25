import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

const runToolLoopMock = vi.fn(async (request: unknown) => {
  return {
    text: "done",
    thoughts: "",
    steps: [],
    totalCostUsd: 0,
    request,
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
});
