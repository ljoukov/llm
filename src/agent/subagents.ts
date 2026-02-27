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

const DEFAULT_SUBAGENT_MAX_AGENTS = 6;
const DEFAULT_SUBAGENT_MAX_DEPTH = 1;
const DEFAULT_SUBAGENT_MIN_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SUBAGENT_MAX_WAIT_TIMEOUT_MS = 3_600_000;
const MAX_SUBAGENT_MAX_AGENTS = 64;
const MAX_SUBAGENT_MAX_DEPTH = 12;
const MAX_SUBAGENT_MAX_STEPS = 64;
const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 3_600_000;

const SUBAGENT_CONTROL_TOOL_NAMES = ["send_input", "resume_agent", "wait", "close_agent"] as const;
const DEFAULT_AGENT_TYPE = "default";
const BUILT_IN_AGENT_TYPES = ["default", "researcher", "worker", "reviewer"] as const;

const RESEARCHER_ROLE_DESCRIPTION = `Use \`researcher\` for focused discovery and fact-finding work.
Researchers are fast and authoritative.
They should be used for specific, well-scoped research questions.
Rules:
- Do not repeat searches they have already completed.
- Trust researcher findings unless there is a clear contradiction.
- Run researchers in parallel when useful.
- Reuse existing researchers for related follow-up questions.`;

const WORKER_ROLE_DESCRIPTION = `Use for execution and production work across domains.
Typical tasks:
- Build part of a deliverable
- Implement requested changes
- Produce concrete outputs (documents, plans, analyses, artifacts)
Rules:
- Explicitly assign **ownership** of the task (scope / responsibility).
- Always tell workers they are **not alone in the workspace**, and they should ignore edits made by others without touching them unless asked.`;

const REVIEWER_ROLE_DESCRIPTION = `Use \`reviewer\` to evaluate completed work and provide feedback.
Reviewers focus on quality, correctness, risk, and clarity.
Rules:
- Review critically and prioritize issues by severity.
- Call out gaps, assumptions, and edge cases explicitly.
- Provide actionable, concrete feedback to improve the result.
- Do not redo the entire task unless explicitly requested; evaluate first.`;

const BUILT_IN_AGENT_TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  default: "Default agent.",
  researcher: RESEARCHER_ROLE_DESCRIPTION,
  worker: WORKER_ROLE_DESCRIPTION,
  reviewer: REVIEWER_ROLE_DESCRIPTION,
};

const BUILT_IN_AGENT_TYPE_INSTRUCTIONS: Readonly<Record<string, string | undefined>> = {
  default: undefined,
  researcher: RESEARCHER_ROLE_DESCRIPTION,
  worker: WORKER_ROLE_DESCRIPTION,
  reviewer: REVIEWER_ROLE_DESCRIPTION,
};

export type AgentSubagentToolPromptPattern = "codex" | "none";

export type AgentSubagentToolConfig = {
  readonly enabled?: boolean;
  readonly maxAgents?: number;
  readonly maxDepth?: number;
  readonly minWaitTimeoutMs?: number;
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
  readonly minWaitTimeoutMs: number;
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
  readonly forkContextMessages?: readonly LlmInputMessage[];
  readonly runSubagent: (request: SubagentRunRequest) => Promise<LlmToolLoopResult>;
  readonly onBackgroundMessage?: (message: string) => void;
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
  | "resumed"
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
  nickname?: string;
  agentRole: string;
  status: SubagentStatus;
  createdAtMs: number;
  updatedAtMs: number;
  pendingInputs: string[];
  history: LlmInputMessage[];
  instructions?: string;
  maxSteps?: number;
  turns: number;
  firstRunStartedAtMs?: number;
  lastRunStartedAtMs?: number;
  lastRunCompletedAtMs?: number;
  lastRunDurationMs?: number;
  lastResult?: LlmToolLoopResult;
  lastError?: string;
  abortController?: AbortController;
  runningPromise?: Promise<void>;
  notification: SubagentNotification;
  notificationMessage: string;
  version: number;
  waiters: Set<() => void>;
};

const SUBAGENT_NOTIFICATION_OPEN_TAG = "<subagent_notification>";
const SUBAGENT_NOTIFICATION_CLOSE_TAG = "</subagent_notification>";

const SPAWN_AGENT_TYPE_DESCRIPTION = buildSpawnAgentTypeDescription();

const subagentInputItemSchema = z
  .object({
    text: z.string().nullish(),
    image_url: z.string().nullish(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();

const spawnAgentInputSchema = z.object({
  prompt: z
    .string()
    .nullish()
    .describe("Alias for message. Initial plain-text task for the new agent."),
  message: z
    .string()
    .nullish()
    .describe("Initial plain-text task for the new agent. Use either message or items."),
  items: z
    .array(subagentInputItemSchema)
    .nullish()
    .describe(
      "Structured input items. Use this to pass explicit mentions (for example app:// connector paths).",
    ),
  agent_type: z.string().nullish().describe(SPAWN_AGENT_TYPE_DESCRIPTION),
  fork_context: z
    .boolean()
    .nullish()
    .describe(
      "When true, fork the current thread history into the new agent before sending the initial prompt. This must be used when you want the new agent to have exactly the same context as you.",
    ),
  instructions: z
    .string()
    .nullish()
    .describe("Optional extra instructions for this subagent instance."),
  model: z
    .string()
    .nullish()
    .describe("Optional model override. Must be one of this package's supported text model ids."),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(MAX_SUBAGENT_MAX_STEPS)
    .nullish()
    .describe("Optional max step budget for each subagent run."),
});

const sendInputSchema = z
  .object({
    agent_id: z.string().nullish().describe("Target subagent id."),
    id: z.string().nullish().describe("Agent id to message (from spawn_agent)."),
    input: z.string().nullish().describe("New user input queued for the subagent."),
    message: z
      .string()
      .nullish()
      .describe("Legacy plain-text message to send to the agent. Use either message or items."),
    items: z
      .array(subagentInputItemSchema)
      .nullish()
      .describe(
        "Structured input items. Use this to pass explicit mentions (for example app:// connector paths).",
      ),
    interrupt: z
      .boolean()
      .nullish()
      .describe("If true and currently running, aborts active run before queuing input."),
  })
  .refine((value) => Boolean(resolveAgentIdValue(value.agent_id, value.id)), {
    message: "agent_id (or id) is required.",
  });

const resumeAgentSchema = z
  .object({
    agent_id: z.string().nullish().describe("Target subagent id."),
    id: z.string().nullish().describe("Agent id to resume."),
  })
  .refine((value) => Boolean(resolveAgentIdValue(value.agent_id, value.id)), {
    message: "agent_id (or id) is required.",
  });

const waitSchema = z.object({
  agent_id: z.string().nullish().describe("Target subagent id."),
  id: z.string().nullish().describe("Codex-style alias for agent_id."),
  ids: z
    .array(z.string().min(1))
    .nullish()
    .describe("Agent ids to wait on. Pass multiple ids to wait for whichever finishes first."),
  timeout_ms: z
    .number()
    .int()
    .nullish()
    .describe(
      "Optional timeout in milliseconds. Defaults to 30000, min 10000, max 3600000. Prefer longer waits (minutes) to avoid busy polling.",
    ),
});

const closeSchema = z
  .object({
    agent_id: z.string().nullish().describe("Target subagent id."),
    id: z.string().nullish().describe("Agent id to close (from spawn_agent)."),
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
    minWaitTimeoutMs: DEFAULT_SUBAGENT_MIN_WAIT_TIMEOUT_MS,
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
  const minWaitTimeoutMs = normalizeInteger(
    config.minWaitTimeoutMs,
    defaults.minWaitTimeoutMs,
    1,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
  );
  const defaultWaitTimeoutMs = normalizeInteger(
    config.defaultWaitTimeoutMs,
    defaults.defaultWaitTimeoutMs,
    minWaitTimeoutMs,
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
    minWaitTimeoutMs,
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
    "Background updates may appear as <subagent_notification>{...}</subagent_notification>; treat them as status updates, not new user intent.",
    "Available spawn_agent agent_type values: default, researcher, worker, reviewer.",
    "Use this control pattern:",
    "1. spawn_agent with a focused prompt.",
    "2. wait with ids=[agent_id] until the agent reaches a non-running state. Prefer long waits (minutes).",
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
  const roleNicknameCounts = new Map<string, number>();

  const tools: LlmToolSet = {
    spawn_agent: tool({
      description:
        "Spawn a sub-agent for a well-scoped task. Returns the agent id (and user-facing nickname when available) to use to communicate with this agent.",
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
        const { roleName, roleInstructions } = resolveAgentType(input.agent_type);
        const nickname = reserveAgentNickname(roleName, roleNicknameCounts);
        const perSpawnInstructions = joinInstructionBlocks(
          roleInstructions,
          trimToUndefined(input.instructions),
        );
        const initialPrompt = resolveCollabInputText({
          textCandidates: [{ value: input.prompt }, { value: input.message }],
          items: input.items,
          bothError: "Provide either prompt/message or items, but not both.",
          missingError: "Provide one of: prompt/message or items.",
          emptyTextError: "Empty message can't be sent to an agent.",
          emptyItemsError: "Items can't be empty.",
        });
        const agent: ManagedSubagent = {
          id,
          depth: childDepth,
          model,
          ...(nickname ? { nickname } : {}),
          agentRole: roleName,
          status: "idle",
          createdAtMs: now,
          updatedAtMs: now,
          pendingInputs: [initialPrompt],
          history:
            input.fork_context && options.forkContextMessages
              ? [...options.forkContextMessages]
              : [],
          ...(options.buildChildInstructions
            ? {
                instructions: trimToUndefined(
                  options.buildChildInstructions(perSpawnInstructions, childDepth),
                ),
              }
            : perSpawnInstructions
              ? { instructions: perSpawnInstructions }
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
        return buildToolResponse(
          agent,
          {
            notification: "spawned",
            message: `Spawned subagent ${id}.`,
          },
          { nickname: agent.nickname },
        );
      },
    }),
    send_input: tool({
      description:
        "Send a message to an existing agent. Use interrupt=true to redirect work immediately.",
      inputSchema: sendInputSchema,
      execute: async (input) => {
        const submissionId = randomSubmissionId();
        const agentId = resolveAgentIdValue(input.agent_id, input.id);
        if (!agentId) {
          throw new Error("send_input requires agent_id or id.");
        }
        const agent = requireAgent(agents, agentId);
        const nextInput = resolveCollabInputText({
          textCandidates: [{ value: input.input }, { value: input.message }],
          items: input.items,
          bothError: "Provide either input/message or items, but not both.",
          missingError: "Provide one of: input/message or items.",
          emptyTextError: "Empty message can't be sent to an agent.",
          emptyItemsError: "Items can't be empty.",
        });
        if (agent.status === "closed") {
          throw new Error(`agent with id ${agent.id} is closed`);
        }
        if (input.interrupt && agent.abortController) {
          agent.abortController.abort("send_input_interrupt");
          agent.pendingInputs.unshift(nextInput);
          setNotification(agent, "input_queued", `Interrupted ${agent.id} and queued new input.`);
          return buildToolResponse(agent, undefined, { submission_id: submissionId });
        }
        agent.pendingInputs.push(nextInput);
        setNotification(agent, "input_queued", `Queued input for ${agent.id}.`);
        return buildToolResponse(agent, undefined, { submission_id: submissionId });
      },
    }),
    resume_agent: tool({
      description:
        "Resume a previously closed agent by id so it can receive send_input and wait calls.",
      inputSchema: resumeAgentSchema,
      execute: async (input) => {
        const agentId = resolveAgentIdValue(input.agent_id, input.id);
        if (!agentId) {
          throw new Error("resume_agent requires agent_id or id.");
        }
        const agent = requireAgent(agents, agentId);
        if (agent.status === "closed") {
          agent.status = "idle";
          setNotification(agent, "resumed", `Resumed subagent ${agent.id}.`);
          return buildToolResponse(agent, {
            notification: "resumed",
            message: `Resumed subagent ${agent.id}.`,
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
        "Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. Once the agent reaches a final status, a notification message will be received containing the same completed status.",
      inputSchema: waitSchema,
      execute: async (input) => {
        const ids = resolveAgentIdList(input.agent_id, input.id, input.ids);
        if (ids.length === 0) {
          throw new Error("ids must be non-empty");
        }
        if (typeof input.timeout_ms === "number" && input.timeout_ms <= 0) {
          throw new Error("timeout_ms must be greater than zero");
        }
        const timeoutMs = normalizeInteger(
          input.timeout_ms,
          options.config.defaultWaitTimeoutMs,
          options.config.minWaitTimeoutMs,
          options.config.maxWaitTimeoutMs,
        );
        const status = await waitForAnyAgentStatus(agents, ids, timeoutMs);
        const timedOut = Object.keys(status).length === 0;
        if (timedOut && ids.length === 1) {
          const agent = requireAgent(agents, ids[0] as string);
          setNotification(
            agent,
            "timeout",
            `Timed out after ${timeoutMs}ms while waiting for ${agent.id}.`,
          );
        }
        return {
          status,
          status_summary: summarizeAgentStatuses(status),
          timed_out: timedOut,
          timeout_ms: timeoutMs,
        };
      },
    }),
    close_agent: tool({
      description: "Close an agent when it is no longer needed and return its last known status.",
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
        const cancelled = closeSubagent(agent, `Closed ${agent.id}.`, options);
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
          closeSubagent(agent, `Parent agent loop closed ${agent.id}.`, options);
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
    throw new Error(`agent with id ${id} not found`);
  }
  return agent;
}

function resolveAgentIdValue(
  agentId: string | null | undefined,
  idAlias: string | null | undefined,
): string {
  const preferred = agentId?.trim();
  if (preferred) {
    return preferred;
  }
  const alias = idAlias?.trim();
  return alias ?? "";
}

function resolveAgentIdList(
  agentId: string | null | undefined,
  idAlias: string | null | undefined,
  ids: readonly string[] | null | undefined,
): string[] {
  if (Array.isArray(ids) && ids.length > 0) {
    return [...new Set(ids.map((value) => value.trim()).filter(Boolean))];
  }
  const single = resolveAgentIdValue(agentId, idAlias);
  return single ? [single] : [];
}

function resolveCollabInputText(params: {
  readonly textCandidates: readonly {
    readonly value: string | null | undefined;
  }[];
  readonly items: readonly z.infer<typeof subagentInputItemSchema>[] | null | undefined;
  readonly bothError: string;
  readonly missingError: string;
  readonly emptyTextError: string;
  readonly emptyItemsError: string;
}): string {
  const textCandidate = params.textCandidates.find(
    (candidate) => candidate.value !== undefined && candidate.value !== null,
  );
  const hasText = Boolean(textCandidate);
  const hasItems = params.items !== undefined && params.items !== null;

  if (hasText && hasItems) {
    throw new Error(params.bothError);
  }
  if (!hasText && !hasItems) {
    throw new Error(params.missingError);
  }

  if (hasText) {
    const value = textCandidate?.value?.trim();
    if (!value) {
      throw new Error(params.emptyTextError);
    }
    return value;
  }

  if (!params.items || params.items.length === 0) {
    throw new Error(params.emptyItemsError);
  }
  const itemText = resolveInputItemsText(params.items);
  if (!itemText) {
    throw new Error(params.emptyItemsError);
  }
  return itemText;
}

function resolveInputItemsText(
  items: readonly z.infer<typeof subagentInputItemSchema>[] | null | undefined,
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
    if (itemType === "image") {
      lines.push("[image]");
      continue;
    }
    if (itemType === "local_image" && path) {
      lines.push(`[local_image:${path}]`);
      continue;
    }
    if (itemType === "skill" && name && path) {
      lines.push(`[skill:$${name}](${path})`);
      continue;
    }
    if (itemType === "mention" && name && path) {
      lines.push(`[mention:$${name}](${path})`);
      continue;
    }
    if (path || imageUrl) {
      lines.push(`[${itemType || "input"}:${path || imageUrl}]`);
      continue;
    }
    if (name) {
      lines.push(`[${itemType || "input"}:${name}]`);
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
  const runStartedAtMs = Date.now();
  agent.abortController = abortController;
  if (agent.firstRunStartedAtMs === undefined) {
    agent.firstRunStartedAtMs = runStartedAtMs;
  }
  agent.lastRunStartedAtMs = runStartedAtMs;
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
      emitBackgroundNotification(agent, options);
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
      emitBackgroundNotification(agent, options);
    } finally {
      const runCompletedAtMs = Date.now();
      agent.lastRunCompletedAtMs = runCompletedAtMs;
      agent.lastRunDurationMs = Math.max(0, runCompletedAtMs - runStartedAtMs);
      agent.runningPromise = undefined;
      agent.abortController = undefined;
    }
  })();

  agent.runningPromise = runPromise;
  return "started";
}

function closeSubagent(
  agent: ManagedSubagent,
  message: string,
  options?: Pick<CreateSubagentToolControllerOptions, "onBackgroundMessage">,
): boolean {
  const cancelled = Boolean(agent.runningPromise);
  agent.pendingInputs = [];
  if (agent.abortController) {
    agent.abortController.abort("close_agent");
  }
  setLifecycle(agent, "closed", "closed", message);
  emitBackgroundNotification(agent, options);
  return cancelled;
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
    ...(agent.nickname ? { nickname: agent.nickname } : {}),
    agent_role: agent.agentRole,
    status: agent.status,
    depth: agent.depth,
    model: agent.model,
    pending_inputs: agent.pendingInputs.length,
    turns: agent.turns,
    created_at: new Date(agent.createdAtMs).toISOString(),
    updated_at: new Date(agent.updatedAtMs).toISOString(),
    ...(agent.firstRunStartedAtMs
      ? {
          first_run_started_at: new Date(agent.firstRunStartedAtMs).toISOString(),
          spawn_startup_latency_ms: Math.max(0, agent.firstRunStartedAtMs - agent.createdAtMs),
        }
      : {}),
    ...(agent.lastRunStartedAtMs
      ? { last_run_started_at: new Date(agent.lastRunStartedAtMs).toISOString() }
      : {}),
    ...(agent.lastRunCompletedAtMs
      ? { last_run_completed_at: new Date(agent.lastRunCompletedAtMs).toISOString() }
      : {}),
    ...(typeof agent.lastRunDurationMs === "number"
      ? { last_run_duration_ms: Math.max(0, agent.lastRunDurationMs) }
      : {}),
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

function emitBackgroundNotification(
  agent: ManagedSubagent,
  options: Pick<CreateSubagentToolControllerOptions, "onBackgroundMessage"> | undefined,
): void {
  if (!options?.onBackgroundMessage) {
    return;
  }
  if (!isBackgroundNotification(agent.notification)) {
    return;
  }
  const payload = {
    agent_id: agent.id,
    status: buildSnapshot(agent),
  };
  const body = JSON.stringify(payload);
  try {
    options.onBackgroundMessage(
      `${SUBAGENT_NOTIFICATION_OPEN_TAG}${body}${SUBAGENT_NOTIFICATION_CLOSE_TAG}`,
    );
  } catch {
    // Background notification delivery should never break tool execution.
  }
}

function isBackgroundNotification(notification: SubagentNotification): boolean {
  return (
    notification === "run_completed" || notification === "run_failed" || notification === "closed"
  );
}

function summarizeAgentStatuses(
  status: Record<string, Record<string, unknown>>,
): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [agentId, snapshot] of Object.entries(status)) {
    const value = snapshot.status;
    summary[agentId] = typeof value === "string" ? value : "unknown";
  }
  return summary;
}

function buildSpawnAgentTypeDescription(): string {
  const sections = BUILT_IN_AGENT_TYPES.map((name) => {
    const description = BUILT_IN_AGENT_TYPE_DESCRIPTIONS[name];
    return `${name}: {\n${description}\n}`;
  });
  return [
    `Optional type name for the new agent. If omitted, \`${DEFAULT_AGENT_TYPE}\` is used.`,
    "Available roles:",
    ...sections,
  ].join("\n");
}

function resolveAgentType(agentType: string | null | undefined): {
  readonly roleName: string;
  readonly roleInstructions: string | undefined;
} {
  const requestedRoleName = trimToUndefined(agentType) ?? DEFAULT_AGENT_TYPE;
  const roleName = requestedRoleName;
  const description = BUILT_IN_AGENT_TYPE_DESCRIPTIONS[roleName];
  if (!description) {
    throw new Error(`unknown agent_type '${requestedRoleName}'`);
  }
  return {
    roleName,
    roleInstructions: BUILT_IN_AGENT_TYPE_INSTRUCTIONS[roleName],
  };
}

function reserveAgentNickname(roleName: string, counts: Map<string, number>): string {
  const prefixByRole: Readonly<Record<string, string>> = {
    default: "Agent",
    researcher: "Researcher",
    worker: "Worker",
    reviewer: "Reviewer",
  };
  const prefix = prefixByRole[roleName] ?? "Agent";
  const next = (counts.get(prefix) ?? 0) + 1;
  counts.set(prefix, next);
  return `${prefix}_${next}`;
}

function joinInstructionBlocks(...blocks: Array<string | undefined>): string | undefined {
  const parts = blocks.map(trimToUndefined).filter((value): value is string => Boolean(value));
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

function randomSubmissionId(): string {
  return `sub_${randomBytes(6).toString("hex")}`;
}

function normalizeInteger(
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeOptionalInteger(
  value: number | null | undefined,
  min: number,
  max: number,
): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function trimToUndefined(value: string | null | undefined): string | undefined {
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
