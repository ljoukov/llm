import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  isLlmTextModelId,
  tool,
  type LlmInputMessage,
  type LlmTextModelId,
  type LlmToolLoopResult,
  type LlmToolSet,
} from "../llm.js";

const DEFAULT_SUBAGENT_MAX_AGENTS = 4;
const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 1_500;
const DEFAULT_SUBAGENT_MAX_WAIT_TIMEOUT_MS = 90_000;
const MAX_SUBAGENT_MAX_AGENTS = 64;
const MAX_SUBAGENT_MAX_DEPTH = 12;
const MAX_SUBAGENT_MAX_STEPS = 64;
const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 600_000;

const SUBAGENT_CONTROL_TOOL_NAMES = ["send_input", "resume_agent", "wait", "close_agent"] as const;

export type AgentSubagentToolPromptPattern = "codex" | "none";

export type AgentSubagentToolConfig = {
  readonly enabled?: boolean;
  readonly maxAgents?: number;
  readonly maxDepth?: number;
  readonly defaultWaitTimeoutMs?: number;
  readonly maxWaitTimeoutMs?: number;
  readonly promptPattern?: AgentSubagentToolPromptPattern;
  readonly instructions?: string;
  readonly model?: LlmTextModelId;
  readonly maxSteps?: number;
  readonly inheritTools?: boolean;
  readonly inheritFilesystemTool?: boolean;
};

export type AgentSubagentToolSelection = boolean | AgentSubagentToolConfig;

export type ResolvedAgentSubagentToolConfig = {
  readonly enabled: boolean;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly defaultWaitTimeoutMs: number;
  readonly maxWaitTimeoutMs: number;
  readonly promptPattern: AgentSubagentToolPromptPattern;
  readonly instructions?: string;
  readonly model?: LlmTextModelId;
  readonly maxSteps?: number;
  readonly inheritTools: boolean;
  readonly inheritFilesystemTool: boolean;
};

export type SubagentRunRequest = {
  readonly agentId: string;
  readonly depth: number;
  readonly model: LlmTextModelId;
  readonly input: readonly LlmInputMessage[];
  readonly instructions?: string;
  readonly maxSteps?: number;
  readonly signal: AbortSignal;
};

export type CreateSubagentToolControllerOptions = {
  readonly config: ResolvedAgentSubagentToolConfig;
  readonly parentDepth: number;
  readonly parentModel: LlmTextModelId;
  readonly runSubagent: (request: SubagentRunRequest) => Promise<LlmToolLoopResult>;
  readonly buildChildInstructions?: (
    spawnInstructions: string | undefined,
    childDepth: number,
  ) => string | undefined;
};

export type SubagentToolController = {
  readonly tools: LlmToolSet;
  closeAll: () => Promise<void>;
};

type SubagentStatus = "running" | "idle" | "failed" | "closed";

type SubagentNotification =
  | "spawned"
  | "input_queued"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "already_running"
  | "no_pending_input"
  | "closed"
  | "already_closed"
  | "timeout";

type ManagedSubagent = {
  id: string;
  depth: number;
  model: LlmTextModelId;
  status: SubagentStatus;
  createdAtMs: number;
  updatedAtMs: number;
  pendingInputs: string[];
  history: LlmInputMessage[];
  instructions?: string;
  maxSteps?: number;
  turns: number;
  lastResult?: LlmToolLoopResult;
  lastError?: string;
  abortController?: AbortController;
  runningPromise?: Promise<void>;
  notification: SubagentNotification;
  notificationMessage: string;
  version: number;
  waiters: Set<() => void>;
};

const subagentInputItemSchema = z
  .object({
    text: z.string().optional(),
    image_url: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const spawnAgentInputSchema = z
  .object({
    prompt: z.string().optional().describe("Initial prompt for the subagent."),
    message: z.string().optional().describe("Codex-style alias for prompt."),
    items: z
      .array(subagentInputItemSchema)
      .optional()
      .describe("Optional Codex-style input items."),
    agent_type: z.string().optional().describe("Codex-style agent type hint."),
    instructions: z
      .string()
      .optional()
      .describe("Optional extra instructions for this subagent instance."),
    model: z
      .string()
      .optional()
      .describe("Optional model override. Must be one of this package's supported text model ids."),
    max_steps: z
      .number()
      .int()
      .min(1)
      .max(MAX_SUBAGENT_MAX_STEPS)
      .optional()
      .describe("Optional max step budget for each subagent run."),
  })
  .refine((value) => Boolean(resolvePromptValue(value.prompt, value.message, value.items)), {
    message: "Either prompt, message, or items must contain non-empty input.",
  });

const sendInputSchema = z
  .object({
    agent_id: z.string().optional().describe("Target subagent id."),
    id: z.string().optional().describe("Codex-style alias for agent_id."),
    input: z.string().optional().describe("New user input queued for the subagent."),
    message: z.string().optional().describe("Codex-style alias for input."),
    items: z
      .array(subagentInputItemSchema)
      .optional()
      .describe("Optional Codex-style input items."),
    interrupt: z
      .boolean()
      .optional()
      .describe("If true and currently running, aborts active run before queuing input."),
  })
  .refine((value) => Boolean(resolveAgentIdValue(value.agent_id, value.id)), {
    message: "agent_id (or id) is required.",
  })
  .refine((value) => Boolean(resolvePromptValue(value.input, value.message, value.items)), {
    message: "input (or message/items) is required.",
  });

const resumeAgentSchema = z
  .object({
    agent_id: z.string().optional().describe("Target subagent id."),
    id: z.string().optional().describe("Codex-style alias for agent_id."),
  })
  .refine((value) => Boolean(resolveAgentIdValue(value.agent_id, value.id)), {
    message: "agent_id (or id) is required.",
  });

const waitSchema = z
  .object({
    agent_id: z.string().optional().describe("Target subagent id."),
    id: z.string().optional().describe("Codex-style alias for agent_id."),
    ids: z.array(z.string().min(1)).optional().describe("Codex-style list of agent ids."),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Optional wait timeout in milliseconds."),
  })
  .refine(
    (value) =>
      Boolean(resolveAgentIdValue(value.agent_id, value.id)) ||
      (Array.isArray(value.ids) && value.ids.length > 0),
    {
      message: "agent_id/id or ids is required.",
    },
  );

const closeSchema = z
  .object({
    agent_id: z.string().optional().describe("Target subagent id."),
    id: z.string().optional().describe("Codex-style alias for agent_id."),
  })
  .refine((value) => Boolean(resolveAgentIdValue(value.agent_id, value.id)), {
    message: "agent_id (or id) is required.",
  });

export function resolveSubagentToolConfig(
  selection: AgentSubagentToolSelection | undefined,
  currentDepth: number,
): ResolvedAgentSubagentToolConfig {
  const defaults = {
    maxAgents: DEFAULT_SUBAGENT_MAX_AGENTS,
    maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
    defaultWaitTimeoutMs: DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    maxWaitTimeoutMs: DEFAULT_SUBAGENT_MAX_WAIT_TIMEOUT_MS,
    promptPattern: "codex" as const,
    inheritTools: true,
    inheritFilesystemTool: true,
  };

  if (selection === undefined || selection === false) {
    return {
      enabled: false,
      ...defaults,
    };
  }

  const config = selection === true ? {} : selection;
  const maxAgents = normalizeInteger(
    config.maxAgents,
    defaults.maxAgents,
    1,
    MAX_SUBAGENT_MAX_AGENTS,
  );
  const maxDepth = normalizeInteger(config.maxDepth, defaults.maxDepth, 1, MAX_SUBAGENT_MAX_DEPTH);
  const defaultWaitTimeoutMs = normalizeInteger(
    config.defaultWaitTimeoutMs,
    defaults.defaultWaitTimeoutMs,
    1,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
  );
  const maxWaitTimeoutMs = normalizeInteger(
    config.maxWaitTimeoutMs,
    defaults.maxWaitTimeoutMs,
    defaultWaitTimeoutMs,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
  );
  const promptPattern = config.promptPattern ?? defaults.promptPattern;
  const instructions = trimToUndefined(config.instructions);
  const maxSteps = normalizeOptionalInteger(config.maxSteps, 1, MAX_SUBAGENT_MAX_STEPS);
  const enabled = config.enabled !== false && currentDepth < maxDepth;

  return {
    enabled,
    maxAgents,
    maxDepth,
    defaultWaitTimeoutMs,
    maxWaitTimeoutMs,
    promptPattern,
    ...(instructions ? { instructions } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(maxSteps ? { maxSteps } : {}),
    inheritTools: config.inheritTools !== false,
    inheritFilesystemTool: config.inheritFilesystemTool !== false,
  };
}

export function buildCodexSubagentOrchestratorInstructions(params: {
  readonly currentDepth: number;
  readonly maxDepth: number;
  readonly maxAgents: number;
}): string {
  return [
    "Subagent orchestration tools are available: spawn_agent, send_input, resume_agent, wait, close_agent.",
    "Use this control pattern:",
    "1. spawn_agent with a focused prompt.",
    "2. wait on that agent_id until it is no longer running.",
    "3. For follow-up turns, send_input then resume_agent.",
    "4. close_agent when delegation is complete.",
    `Limits: max active subagents ${params.maxAgents}, max depth ${params.maxDepth}, current depth ${params.currentDepth}.`,
  ].join("\n");
}

export function buildCodexSubagentWorkerInstructions(params: {
  readonly depth: number;
  readonly maxDepth: number;
}): string {
  return [
    `You are a delegated subagent at depth ${params.depth}/${params.maxDepth}.`,
    "Focus on the delegated task, use available tools when needed, and return concise actionable output.",
    "If blocked, report the blocker explicitly.",
  ].join("\n");
}

export function createSubagentToolController(
  options: CreateSubagentToolControllerOptions,
): SubagentToolController {
  if (!options.config.enabled) {
    return {
      tools: {},
      closeAll: async () => {},
    };
  }

  const agents = new Map<string, ManagedSubagent>();

  const tools: LlmToolSet = {
    spawn_agent: tool({
      description:
        "Spawns a subagent asynchronously. Returns immediately with agent status and id.",
      inputSchema: spawnAgentInputSchema,
      execute: async (input) => {
        if (countActiveAgents(agents) >= options.config.maxAgents) {
          throw new Error(
            `Subagent limit reached (${options.config.maxAgents}). Close existing agents before spawning new ones.`,
          );
        }

        const childDepth = options.parentDepth + 1;
        if (childDepth > options.config.maxDepth) {
          throw new Error(
            `Subagent depth limit reached (${options.config.maxDepth}). Cannot spawn at depth ${childDepth}.`,
          );
        }

        let model: LlmTextModelId = options.config.model ?? options.parentModel;
        if (input.model) {
          if (!isLlmTextModelId(input.model)) {
            throw new Error(`Unsupported subagent model id: ${input.model}`);
          }
          model = input.model;
        }

        const id = `agent_${randomBytes(6).toString("hex")}`;
        const now = Date.now();
        const initialPrompt = resolvePromptValue(input.prompt, input.message, input.items);
        if (!initialPrompt) {
          throw new Error("spawn_agent requires prompt/message/items with non-empty text.");
        }
        const agent: ManagedSubagent = {
          id,
          depth: childDepth,
          model,
          status: "idle",
          createdAtMs: now,
          updatedAtMs: now,
          pendingInputs: [initialPrompt],
          history: [],
          ...(options.buildChildInstructions
            ? {
                instructions: trimToUndefined(
                  options.buildChildInstructions(input.instructions, childDepth),
                ),
              }
            : input.instructions
              ? { instructions: trimToUndefined(input.instructions) }
              : {}),
          ...(input.max_steps
            ? { maxSteps: input.max_steps }
            : options.config.maxSteps
              ? { maxSteps: options.config.maxSteps }
              : {}),
          turns: 0,
          notification: "spawned",
          notificationMessage: `Spawned subagent ${id}.`,
          version: 1,
          waiters: new Set(),
        };
        agents.set(id, agent);

        startRun(agent, options);
        return buildToolResponse(agent, {
          notification: "spawned",
          message: `Spawned subagent ${id}.`,
        });
      },
    }),
    send_input: tool({
      description: "Queues new input for an existing subagent.",
      inputSchema: sendInputSchema,
      execute: async (input) => {
        const agentId = resolveAgentIdValue(input.agent_id, input.id);
        if (!agentId) {
          throw new Error("send_input requires agent_id or id.");
        }
        const agent = requireAgent(agents, agentId);
        const nextInput = resolvePromptValue(input.input, input.message, input.items);
        if (!nextInput) {
          throw new Error("send_input requires input/message/items with non-empty text.");
        }
        if (agent.status === "closed") {
          throw new Error(`Subagent ${agent.id} is closed.`);
        }
        if (input.interrupt && agent.abortController) {
          agent.abortController.abort("send_input_interrupt");
          agent.pendingInputs.unshift(nextInput);
          setNotification(agent, "input_queued", `Interrupted ${agent.id} and queued new input.`);
          return buildToolResponse(agent);
        }
        agent.pendingInputs.push(nextInput);
        setNotification(agent, "input_queued", `Queued input for ${agent.id}.`);
        return buildToolResponse(agent);
      },
    }),
    resume_agent: tool({
      description: "Resumes a subagent run when queued input is available.",
      inputSchema: resumeAgentSchema,
      execute: async (input) => {
        const agentId = resolveAgentIdValue(input.agent_id, input.id);
        if (!agentId) {
          throw new Error("resume_agent requires agent_id or id.");
        }
        const agent = requireAgent(agents, agentId);
        if (agent.status === "closed") {
          setNotification(agent, "already_closed", `Subagent ${agent.id} is already closed.`);
          return buildToolResponse(agent, {
            notification: "already_closed",
            message: `Subagent ${agent.id} is already closed.`,
          });
        }
        const outcome = startRun(agent, options);
        if (outcome === "started") {
          return buildToolResponse(agent, {
            notification: "run_started",
            message: `Started subagent ${agent.id}.`,
          });
        }
        if (outcome === "already_running") {
          setNotification(agent, "already_running", `Subagent ${agent.id} is already running.`);
          return buildToolResponse(agent);
        }
        setNotification(agent, "no_pending_input", `Subagent ${agent.id} has no queued input.`);
        return buildToolResponse(agent);
      },
    }),
    wait: tool({
      description:
        "Waits for a running subagent to change state or until timeout. Returns current status.",
      inputSchema: waitSchema,
      execute: async (input) => {
        const usesIdsArray = Array.isArray(input.ids) && input.ids.length > 0;
        const ids = resolveAgentIdList(input.agent_id, input.id, input.ids);
        if (ids.length === 0) {
          throw new Error("wait requires agent_id/id or ids.");
        }
        const timeoutMs = normalizeInteger(
          input.timeout_ms,
          options.config.defaultWaitTimeoutMs,
          1,
          options.config.maxWaitTimeoutMs,
        );

        if (usesIdsArray) {
          const status = await waitForAnyAgentStatus(agents, ids, timeoutMs);
          return { status, timed_out: Object.keys(status).length === 0, timeout_ms: timeoutMs };
        }

        const agent = requireAgent(agents, ids[0] as string);
        if (agent.status === "running") {
          const completed = await waitUntilNotRunning(agent, timeoutMs);
          if (!completed) {
            setNotification(
              agent,
              "timeout",
              `Timed out after ${timeoutMs}ms while waiting for ${agent.id}.`,
            );
            return buildToolResponse(agent, undefined, { timed_out: true, timeout_ms: timeoutMs });
          }
        }

        return buildToolResponse(agent, undefined, { timed_out: false, timeout_ms: timeoutMs });
      },
    }),
    close_agent: tool({
      description: "Closes a subagent and aborts its current run if it is still running.",
      inputSchema: closeSchema,
      execute: async (input) => {
        const agentId = resolveAgentIdValue(input.agent_id, input.id);
        if (!agentId) {
          throw new Error("close_agent requires agent_id or id.");
        }
        const agent = requireAgent(agents, agentId);
        if (agent.status === "closed") {
          setNotification(agent, "already_closed", `Subagent ${agent.id} is already closed.`);
          return buildToolResponse(agent, undefined, { cancelled: false });
        }
        const cancelled = closeSubagent(agent, `Closed ${agent.id}.`);
        return buildToolResponse(
          agent,
          { notification: "closed", message: `Closed ${agent.id}.` },
          { cancelled },
        );
      },
    }),
  };

  return {
    tools,
    closeAll: async () => {
      const running: Promise<void>[] = [];
      for (const agent of agents.values()) {
        if (agent.status !== "closed") {
          closeSubagent(agent, `Parent agent loop closed ${agent.id}.`);
        }
        if (agent.runningPromise) {
          running.push(agent.runningPromise);
        }
      }
      if (running.length > 0) {
        await Promise.race([Promise.allSettled(running), sleep(2_000)]);
      }
    },
  };
}

function requireAgent(agents: Map<string, ManagedSubagent>, id: string): ManagedSubagent {
  const agent = agents.get(id);
  if (!agent) {
    throw new Error(`Unknown subagent id: ${id}`);
  }
  return agent;
}

function resolveAgentIdValue(agentId: string | undefined, idAlias: string | undefined): string {
  const preferred = agentId?.trim();
  if (preferred) {
    return preferred;
  }
  const alias = idAlias?.trim();
  return alias ?? "";
}

function resolveAgentIdList(
  agentId: string | undefined,
  idAlias: string | undefined,
  ids: readonly string[] | undefined,
): string[] {
  if (Array.isArray(ids) && ids.length > 0) {
    return [...new Set(ids.map((value) => value.trim()).filter(Boolean))];
  }
  const single = resolveAgentIdValue(agentId, idAlias);
  return single ? [single] : [];
}

function resolvePromptValue(
  prompt: string | undefined,
  message: string | undefined,
  items: readonly z.infer<typeof subagentInputItemSchema>[] | undefined,
): string {
  const promptValue = prompt?.trim();
  if (promptValue) {
    return promptValue;
  }
  const messageValue = message?.trim();
  if (messageValue) {
    return messageValue;
  }
  const itemText = resolveInputItemsText(items);
  return itemText ?? "";
}

function resolveInputItemsText(
  items: readonly z.infer<typeof subagentInputItemSchema>[] | undefined,
): string | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  for (const item of items) {
    if (typeof item.text === "string" && item.text.trim().length > 0) {
      lines.push(item.text.trim());
      continue;
    }
    const itemType = typeof item.type === "string" ? item.type.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const imageUrl = typeof item.image_url === "string" ? item.image_url.trim() : "";
    const compact = [itemType, name, path || imageUrl].filter(Boolean).join(" ");
    if (compact) {
      lines.push(compact);
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

function countActiveAgents(agents: Map<string, ManagedSubagent>): number {
  let count = 0;
  for (const agent of agents.values()) {
    if (agent.status !== "closed") {
      count += 1;
    }
  }
  return count;
}

async function waitForAnyAgentStatus(
  agents: Map<string, ManagedSubagent>,
  ids: readonly string[],
  timeoutMs: number,
): Promise<Record<string, Record<string, unknown>>> {
  const requested = ids.map((id) => requireAgent(agents, id));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const status: Record<string, Record<string, unknown>> = {};
    for (const agent of requested) {
      if (agent.status !== "running") {
        status[agent.id] = buildSnapshot(agent);
      }
    }
    if (Object.keys(status).length > 0) {
      return status;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {};
    }

    await Promise.race(
      requested.map(async (agent) => {
        const changed = await waitForVersionChange(agent, agent.version, remaining);
        if (!changed) {
          return;
        }
      }),
    );
  }
}

function setNotification(
  agent: ManagedSubagent,
  notification: SubagentNotification,
  message: string,
): void {
  agent.notification = notification;
  agent.notificationMessage = message;
  agent.updatedAtMs = Date.now();
  agent.version += 1;
  notifyWaiters(agent);
}

function setLifecycle(
  agent: ManagedSubagent,
  status: SubagentStatus,
  notification: SubagentNotification,
  message: string,
): void {
  agent.status = status;
  setNotification(agent, notification, message);
}

function notifyWaiters(agent: ManagedSubagent): void {
  if (agent.waiters.size === 0) {
    return;
  }
  const waiters = [...agent.waiters];
  agent.waiters.clear();
  for (const notify of waiters) {
    notify();
  }
}

function startRun(
  agent: ManagedSubagent,
  options: CreateSubagentToolControllerOptions,
): "started" | "already_running" | "no_pending_input" {
  if (agent.runningPromise) {
    return "already_running";
  }
  const nextInput = agent.pendingInputs.shift();
  if (!nextInput) {
    return "no_pending_input";
  }

  const input: LlmInputMessage[] = [...agent.history, { role: "user", content: nextInput }];
  const abortController = new AbortController();
  agent.abortController = abortController;
  agent.lastError = undefined;
  setLifecycle(
    agent,
    "running",
    "run_started",
    `Subagent ${agent.id} started run ${agent.turns + 1}.`,
  );

  const runPromise = (async () => {
    try {
      const result = await options.runSubagent({
        agentId: agent.id,
        depth: agent.depth,
        model: agent.model,
        input,
        instructions: agent.instructions,
        maxSteps: agent.maxSteps,
        signal: abortController.signal,
      });
      if (agent.status === "closed") {
        return;
      }
      agent.lastResult = result;
      agent.lastError = undefined;
      agent.turns += 1;
      agent.history = [...input, { role: "assistant", content: result.text }];
      setLifecycle(
        agent,
        "idle",
        "run_completed",
        `Subagent ${agent.id} completed run ${agent.turns}.`,
      );
    } catch (error) {
      if (agent.status === "closed") {
        return;
      }
      if (abortController.signal.aborted) {
        setLifecycle(agent, "idle", "input_queued", `Subagent ${agent.id} run interrupted.`);
        return;
      }
      const message = toErrorMessage(error);
      agent.lastError = message;
      setLifecycle(agent, "failed", "run_failed", `Subagent ${agent.id} failed: ${message}`);
    } finally {
      agent.runningPromise = undefined;
      agent.abortController = undefined;
    }
  })();

  agent.runningPromise = runPromise;
  return "started";
}

function closeSubagent(agent: ManagedSubagent, message: string): boolean {
  const cancelled = Boolean(agent.runningPromise);
  agent.pendingInputs = [];
  if (agent.abortController) {
    agent.abortController.abort("close_agent");
  }
  setLifecycle(agent, "closed", "closed", message);
  return cancelled;
}

async function waitUntilNotRunning(agent: ManagedSubagent, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (agent.status === "running") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    const currentVersion = agent.version;
    const changed = await waitForVersionChange(agent, currentVersion, remaining);
    if (!changed) {
      return false;
    }
  }
  return true;
}

async function waitForVersionChange(
  agent: ManagedSubagent,
  version: number,
  timeoutMs: number,
): Promise<boolean> {
  if (agent.version !== version) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const waiter = () => {
      cleanup();
      resolve(true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      agent.waiters.delete(waiter);
    };
    agent.waiters.add(waiter);
  });
}

function buildToolResponse(
  agent: ManagedSubagent,
  override?: { readonly notification: SubagentNotification; readonly message: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const notification = override?.notification ?? agent.notification;
  const message = override?.message ?? agent.notificationMessage;
  const snapshot = buildSnapshot(agent);
  return {
    agent_id: snapshot.agent_id,
    notification,
    message,
    status: snapshot.status,
    agent: snapshot,
    tool_availability: snapshot.status === "closed" ? [] : [...SUBAGENT_CONTROL_TOOL_NAMES],
    ...extra,
  };
}

function buildSnapshot(agent: ManagedSubagent): Record<string, unknown> {
  return {
    agent_id: agent.id,
    status: agent.status,
    depth: agent.depth,
    model: agent.model,
    pending_inputs: agent.pendingInputs.length,
    turns: agent.turns,
    created_at: new Date(agent.createdAtMs).toISOString(),
    updated_at: new Date(agent.updatedAtMs).toISOString(),
    ...(agent.lastError ? { last_error: agent.lastError } : {}),
    ...(agent.lastResult
      ? {
          last_result: {
            text: agent.lastResult.text,
            thoughts: agent.lastResult.thoughts,
            step_count: agent.lastResult.steps.length,
            total_cost_usd: agent.lastResult.totalCostUsd,
          },
        }
      : {}),
  };
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeOptionalInteger(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
