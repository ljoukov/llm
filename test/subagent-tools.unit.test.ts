import { describe, expect, it, vi } from "vitest";

import {
  createSubagentToolController,
  resolveSubagentToolConfig,
  type SubagentRunRequest,
} from "../src/agent/subagents.js";

function getExecutableTool(
  tools: Record<string, unknown>,
  name: string,
): { execute: (input: any) => Promise<any> } {
  const value = tools[name] as { execute?: unknown } | undefined;
  if (!value || typeof value.execute !== "function") {
    throw new Error(`Expected function tool "${name}" to exist.`);
  }
  return value as { execute: (input: any) => Promise<any> };
}

function asSingleLineText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return "";
}

describe("subagent tools", () => {
  it("supports spawn + wait timeout + completion + send/resume lifecycle", async () => {
    const runSubagent = vi.fn(async (request: SubagentRunRequest) => {
      const last = request.input[request.input.length - 1];
      const text = asSingleLineText(last?.content);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        text: `done:${text}`,
        thoughts: "",
        steps: [],
        totalCostUsd: 0,
      };
    });

    const controller = createSubagentToolController({
      config: resolveSubagentToolConfig(true, 0),
      parentDepth: 0,
      parentModel: "gpt-5.2",
      runSubagent,
    });

    const spawn = getExecutableTool(controller.tools, "spawn_agent");
    const sendInput = getExecutableTool(controller.tools, "send_input");
    const resume = getExecutableTool(controller.tools, "resume_agent");
    const wait = getExecutableTool(controller.tools, "wait");

    const spawned = await spawn.execute({ prompt: "first" });
    expect(spawned.notification).toBe("spawned");
    expect(spawned.status).toBe("running");
    expect(spawned.tool_availability).toEqual([
      "send_input",
      "resume_agent",
      "wait",
      "close_agent",
    ]);

    const agentId = spawned.agent?.agent_id as string;
    expect(agentId).toBeTypeOf("string");

    const timedOut = await wait.execute({ agent_id: agentId, timeout_ms: 5 });
    expect(timedOut.timed_out).toBe(true);
    expect(timedOut.status).toBe("running");
    expect(timedOut.notification).toBe("timeout");

    const completed = await wait.execute({ agent_id: agentId, timeout_ms: 400 });
    expect(completed.timed_out).toBe(false);
    expect(completed.status).toBe("idle");
    expect(completed.notification).toBe("run_completed");
    expect(completed.agent?.last_result?.text).toBe("done:first");

    const queued = await sendInput.execute({ agent_id: agentId, input: "second" });
    expect(queued.notification).toBe("input_queued");
    expect(queued.agent?.pending_inputs).toBe(1);

    const resumed = await resume.execute({ agent_id: agentId });
    expect(resumed.notification).toBe("run_started");
    expect(resumed.status).toBe("running");

    const completedAgain = await wait.execute({ agent_id: agentId, timeout_ms: 400 });
    expect(completedAgain.status).toBe("idle");
    expect(completedAgain.agent?.last_result?.text).toBe("done:second");

    expect(runSubagent).toHaveBeenCalledTimes(2);
    const secondInput = runSubagent.mock.calls[1]?.[0]?.input as
      | readonly { role: string; content: string }[]
      | undefined;
    expect(secondInput?.map((entry) => entry.role)).toEqual(["user", "assistant", "user"]);
  });

  it("supports close_agent cancellation while running", async () => {
    const runSubagent = vi.fn(async (request: SubagentRunRequest) => {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve();
          return;
        }
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        text: "aborted",
        thoughts: "",
        steps: [],
        totalCostUsd: 0,
      };
    });

    const controller = createSubagentToolController({
      config: resolveSubagentToolConfig(true, 0),
      parentDepth: 0,
      parentModel: "gpt-5.2",
      runSubagent,
    });

    const spawn = getExecutableTool(controller.tools, "spawn_agent");
    const close = getExecutableTool(controller.tools, "close_agent");
    const wait = getExecutableTool(controller.tools, "wait");

    const spawned = await spawn.execute({ prompt: "long task" });
    const agentId = spawned.agent?.agent_id as string;

    const closed = await close.execute({ agent_id: agentId });
    expect(closed.notification).toBe("closed");
    expect(closed.status).toBe("closed");
    expect(closed.cancelled).toBe(true);
    expect(closed.tool_availability).toEqual([]);

    const status = await wait.execute({ agent_id: agentId, timeout_ms: 50 });
    expect(status.timed_out).toBe(false);
    expect(status.status).toBe("closed");
  });

  it("accepts codex-style argument aliases (message/id/ids)", async () => {
    const runSubagent = vi.fn(async (request: SubagentRunRequest) => {
      const last = request.input[request.input.length - 1];
      const text = asSingleLineText(last?.content);
      return {
        text: `done:${text}`,
        thoughts: "",
        steps: [],
        totalCostUsd: 0,
      };
    });

    const controller = createSubagentToolController({
      config: resolveSubagentToolConfig(true, 0),
      parentDepth: 0,
      parentModel: "gpt-5.2",
      runSubagent,
    });

    const spawn = getExecutableTool(controller.tools, "spawn_agent");
    const wait = getExecutableTool(controller.tools, "wait");
    const close = getExecutableTool(controller.tools, "close_agent");

    const spawned = await spawn.execute({ message: "alias prompt" });
    const agentId = spawned.agent_id as string;
    expect(agentId).toBeTypeOf("string");

    const waitOne = await wait.execute({ id: agentId, timeout_ms: 200 });
    expect(waitOne.timed_out).toBe(false);
    expect(waitOne.status).toBe("idle");

    const waitMany = await wait.execute({ ids: [agentId], timeout_ms: 200 });
    expect(waitMany.timed_out).toBe(false);
    expect(waitMany.status?.[agentId]?.status).toBe("idle");

    const closed = await close.execute({ id: agentId });
    expect(closed.status).toBe("closed");
  });
});
