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
      config: resolveSubagentToolConfig(
        { minWaitTimeoutMs: 1, defaultWaitTimeoutMs: 30, maxWaitTimeoutMs: 5_000 },
        0,
      ),
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
    expect(timedOut.status).toEqual({});

    const completed = await wait.execute({ agent_id: agentId, timeout_ms: 400 });
    expect(completed.timed_out).toBe(false);
    expect(completed.status?.[agentId]?.status).toBe("idle");
    expect(completed.status?.[agentId]?.last_result?.text).toBe("done:first");

    const queued = await sendInput.execute({ agent_id: agentId, input: "second" });
    expect(queued.notification).toBe("input_queued");
    expect(queued.agent?.pending_inputs).toBe(1);

    const resumed = await resume.execute({ agent_id: agentId });
    expect(resumed.notification).toBe("run_started");
    expect(resumed.status).toBe("running");

    const completedAgain = await wait.execute({ agent_id: agentId, timeout_ms: 400 });
    expect(completedAgain.status?.[agentId]?.status).toBe("idle");
    expect(completedAgain.status?.[agentId]?.last_result?.text).toBe("done:second");

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
      config: resolveSubagentToolConfig({ minWaitTimeoutMs: 1 }, 0),
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
    expect(status.status?.[agentId]?.status).toBe("closed");
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
      config: resolveSubagentToolConfig({ minWaitTimeoutMs: 1 }, 0),
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
    expect(waitOne.status?.[agentId]?.status).toBe("idle");

    const waitMany = await wait.execute({ ids: [agentId], timeout_ms: 200 });
    expect(waitMany.timed_out).toBe(false);
    expect(waitMany.status?.[agentId]?.status).toBe("idle");

    const closed = await close.execute({ id: agentId });
    expect(closed.status).toBe("closed");
  });

  it("treats null optional spawn_agent fields as omitted", async () => {
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
      config: resolveSubagentToolConfig({ minWaitTimeoutMs: 1 }, 0),
      parentDepth: 0,
      parentModel: "gpt-5.2",
      runSubagent,
    });

    const spawn = getExecutableTool(controller.tools, "spawn_agent");
    const wait = getExecutableTool(controller.tools, "wait");

    const spawned = await spawn.execute({
      prompt: null,
      message: null,
      items: [{ type: "text", text: "from-items", image_url: null, path: null }],
      model: null,
      instructions: null,
      max_steps: null,
      agent_type: null,
    });
    const agentId = spawned.agent_id as string;
    expect(agentId).toBeTypeOf("string");
    expect(spawned.agent?.model).toBe("gpt-5.2");

    const completed = await wait.execute({ agent_id: agentId, timeout_ms: 200 });
    expect(completed.timed_out).toBe(false);
    expect(completed.status?.[agentId]?.status).toBe("idle");
    expect(completed.status?.[agentId]?.last_result?.text).toBe("done:from-items");
  });

  it("injects codex-style background notifications when subagent completes", async () => {
    const runSubagent = vi.fn(async (request: SubagentRunRequest) => {
      const last = request.input[request.input.length - 1];
      const text = asSingleLineText(last?.content);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        text: `done:${text}`,
        thoughts: "",
        steps: [],
        totalCostUsd: 0,
      };
    });
    const background = vi.fn();

    const controller = createSubagentToolController({
      config: resolveSubagentToolConfig({ minWaitTimeoutMs: 1 }, 0),
      parentDepth: 0,
      parentModel: "gpt-5.2",
      runSubagent,
      onBackgroundMessage: background,
    });

    const spawn = getExecutableTool(controller.tools, "spawn_agent");
    const wait = getExecutableTool(controller.tools, "wait");

    const spawned = await spawn.execute({ message: "notify me" });
    const agentId = spawned.agent_id as string;
    await wait.execute({ ids: [agentId], timeout_ms: 500 });

    expect(background).toHaveBeenCalled();
    const payload = String(background.mock.calls[0]?.[0] ?? "");
    expect(payload.startsWith("<subagent_notification>")).toBe(true);
    expect(payload.endsWith("</subagent_notification>")).toBe(true);
    expect(payload).toContain(agentId);
  });

  it("rejects message+items combinations like codex collab tools", async () => {
    const runSubagent = vi.fn(async () => ({
      text: "done",
      thoughts: "",
      steps: [],
      totalCostUsd: 0,
    }));

    const controller = createSubagentToolController({
      config: resolveSubagentToolConfig({ minWaitTimeoutMs: 1 }, 0),
      parentDepth: 0,
      parentModel: "gpt-5.2",
      runSubagent,
    });

    const spawn = getExecutableTool(controller.tools, "spawn_agent");
    const sendInput = getExecutableTool(controller.tools, "send_input");

    await expect(
      spawn.execute({
        message: "hi",
        items: [{ type: "text", text: "also hi" }],
      }),
    ).rejects.toThrow("Provide either prompt/message or items, but not both.");

    const spawned = await spawn.execute({ message: "first" });
    const agentId = spawned.agent_id as string;
    await expect(
      sendInput.execute({
        id: agentId,
        message: "next",
        items: [{ type: "text", text: "also next" }],
      }),
    ).rejects.toThrow("Provide either input/message or items, but not both.");
  });
});
