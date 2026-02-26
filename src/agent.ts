import { randomBytes } from "node:crypto";

import {
  runToolLoop,
  type LlmStreamEvent,
  type LlmUsageTokens,
  type LlmToolLoopRequest,
  type LlmToolLoopResult,
  type LlmToolSet,
} from "./llm.js";
import {
  buildCodexSubagentOrchestratorInstructions,
  buildCodexSubagentWorkerInstructions,
  createSubagentToolController,
  resolveSubagentToolConfig,
  type AgentSubagentToolSelection,
  type ResolvedAgentSubagentToolConfig,
} from "./agent/subagents.js";
import {
  createFilesystemToolSetForModel,
  type AgentFilesystemToolProfile,
  type AgentFilesystemToolsOptions,
} from "./tools/filesystemTools.js";

export type AgentFilesystemToolConfig = {
  readonly enabled?: boolean;
  readonly profile?: AgentFilesystemToolProfile;
  readonly options?: AgentFilesystemToolsOptions;
};

export type AgentFilesystemToolSelection =
  | boolean
  | AgentFilesystemToolProfile
  | AgentFilesystemToolConfig;

export type {
  AgentSubagentToolConfig,
  AgentSubagentToolPromptPattern,
  AgentSubagentToolSelection,
} from "./agent/subagents.js";

export type RunAgentLoopRequest = Omit<LlmToolLoopRequest, "tools"> & {
  readonly tools?: LlmToolSet;
  readonly filesystemTool?: AgentFilesystemToolSelection;
  readonly filesystem_tool?: AgentFilesystemToolSelection;
  readonly subagentTool?: AgentSubagentToolSelection;
  readonly subagent_tool?: AgentSubagentToolSelection;
  readonly subagents?: AgentSubagentToolSelection;
  readonly telemetry?: AgentTelemetrySelection;
};

export async function runAgentLoop(request: RunAgentLoopRequest): Promise<LlmToolLoopResult> {
  const telemetry = createAgentTelemetrySession(request.telemetry);
  try {
    return await runAgentLoopInternal(request, { depth: 0, telemetry });
  } finally {
    await telemetry?.flush();
  }
}

type RunAgentLoopInternalContext = {
  readonly depth: number;
  readonly parentRunId?: string;
  readonly telemetry?: AgentTelemetrySession;
};

type AgentTelemetryBaseEvent = {
  readonly timestamp: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly model: LlmToolLoopRequest["model"];
};

export type AgentRunStartedTelemetryEvent = AgentTelemetryBaseEvent & {
  readonly type: "agent.run.started";
  readonly inputMode: "string" | "messages";
  readonly customToolCount: number;
  readonly mergedToolCount: number;
  readonly filesystemToolsEnabled: boolean;
  readonly subagentToolsEnabled: boolean;
};

export type AgentRunStreamTelemetryEvent = AgentTelemetryBaseEvent & {
  readonly type: "agent.run.stream";
  readonly event: LlmStreamEvent;
};

export type AgentRunCompletedTelemetryEvent = AgentTelemetryBaseEvent & {
  readonly type: "agent.run.completed";
  readonly success: boolean;
  readonly durationMs: number;
  readonly stepCount?: number;
  readonly toolCallCount?: number;
  readonly totalCostUsd?: number;
  readonly usage?: LlmUsageTokens;
  readonly error?: string;
};

export type AgentTelemetryEvent =
  | AgentRunStartedTelemetryEvent
  | AgentRunStreamTelemetryEvent
  | AgentRunCompletedTelemetryEvent;

export type AgentTelemetrySink = {
  readonly emit: (event: AgentTelemetryEvent) => void | Promise<void>;
  readonly flush?: () => void | Promise<void>;
};

export type AgentTelemetryConfig = {
  readonly sink: AgentTelemetrySink;
  readonly includeLlmStreamEvents?: boolean;
};

export type AgentTelemetrySelection = AgentTelemetrySink | AgentTelemetryConfig;

type AgentTelemetrySession = {
  readonly includeLlmStreamEvents: boolean;
  readonly emit: (event: AgentTelemetryEvent) => void;
  readonly flush: () => Promise<void>;
};

type AgentTelemetryEventPayload =
  | Omit<AgentRunStartedTelemetryEvent, keyof AgentTelemetryBaseEvent>
  | Omit<AgentRunStreamTelemetryEvent, keyof AgentTelemetryBaseEvent>
  | Omit<AgentRunCompletedTelemetryEvent, keyof AgentTelemetryBaseEvent>;

async function runAgentLoopInternal(
  request: RunAgentLoopRequest,
  context: RunAgentLoopInternalContext,
): Promise<LlmToolLoopResult> {
  const {
    tools: customTools,
    filesystemTool,
    filesystem_tool,
    subagentTool,
    subagent_tool,
    subagents,
    telemetry,
    ...toolLoopRequest
  } = request;

  const telemetrySession = context.telemetry ?? createAgentTelemetrySession(telemetry);
  const runId = randomRunId();
  const startedAtMs = Date.now();
  const filesystemSelection = filesystemTool ?? filesystem_tool;
  const subagentSelection = subagentTool ?? subagent_tool ?? subagents;
  const filesystemTools = resolveFilesystemTools(request.model, filesystemSelection);
  const resolvedSubagentConfig = resolveSubagentToolConfig(subagentSelection, context.depth);
  const subagentController = createSubagentController({
    runId,
    model: request.model,
    depth: context.depth,
    telemetry: telemetrySession,
    customTools: customTools ?? {},
    filesystemSelection,
    subagentSelection,
    toolLoopRequest,
    resolvedSubagentConfig,
  });
  const mergedTools = mergeToolSets(
    mergeToolSets(filesystemTools, subagentController?.tools ?? {}),
    customTools ?? {},
  );

  if (Object.keys(mergedTools).length === 0) {
    throw new Error(
      "runAgentLoop requires at least one tool. Provide `tools`, enable `filesystemTool`, or enable `subagentTool`.",
    );
  }

  const instructions = buildLoopInstructions(
    toolLoopRequest.instructions,
    resolvedSubagentConfig,
    context.depth,
  );
  const emitTelemetry = createAgentTelemetryEmitter({
    session: telemetrySession,
    runId,
    parentRunId: context.parentRunId,
    depth: context.depth,
    model: request.model,
  });

  emitTelemetry({
    type: "agent.run.started",
    inputMode: typeof request.input === "string" ? "string" : "messages",
    customToolCount: Object.keys(customTools ?? {}).length,
    mergedToolCount: Object.keys(mergedTools).length,
    filesystemToolsEnabled: Object.keys(filesystemTools).length > 0,
    subagentToolsEnabled: resolvedSubagentConfig.enabled,
  });

  const sourceOnEvent = toolLoopRequest.onEvent;
  const includeLlmStreamEvents = telemetrySession?.includeLlmStreamEvents === true;
  const wrappedOnEvent =
    sourceOnEvent || includeLlmStreamEvents
      ? (event: LlmStreamEvent) => {
          sourceOnEvent?.(event);
          if (includeLlmStreamEvents) {
            emitTelemetry({ type: "agent.run.stream", event });
          }
        }
      : undefined;

  try {
    const result = await runToolLoop({
      ...toolLoopRequest,
      ...(instructions ? { instructions } : {}),
      ...(wrappedOnEvent ? { onEvent: wrappedOnEvent } : {}),
      tools: mergedTools,
    });
    emitTelemetry({
      type: "agent.run.completed",
      success: true,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      stepCount: result.steps.length,
      toolCallCount: countToolCalls(result),
      totalCostUsd: result.totalCostUsd,
      usage: summarizeResultUsage(result),
    });
    return result;
  } catch (error) {
    emitTelemetry({
      type: "agent.run.completed",
      success: false,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      error: toErrorMessage(error),
    });
    throw error;
  } finally {
    await subagentController?.closeAll();
  }
}

function resolveFilesystemTools(
  model: string,
  selection: AgentFilesystemToolSelection | undefined,
): LlmToolSet {
  if (selection === undefined || selection === false) {
    return {};
  }
  if (selection === true) {
    return createFilesystemToolSetForModel(model, "auto");
  }
  if (typeof selection === "string") {
    return createFilesystemToolSetForModel(model, selection);
  }
  if (selection.enabled === false) {
    return {};
  }
  if (selection.options && selection.profile !== undefined) {
    return createFilesystemToolSetForModel(model, selection.profile, selection.options);
  }
  if (selection.options) {
    return createFilesystemToolSetForModel(model, selection.options);
  }
  return createFilesystemToolSetForModel(model, selection.profile ?? "auto");
}

function mergeToolSets(base: LlmToolSet, extra: LlmToolSet): LlmToolSet {
  const merged: LlmToolSet = { ...base };
  for (const [toolName, toolSpec] of Object.entries(extra)) {
    if (Object.hasOwn(merged, toolName)) {
      throw new Error(
        `Duplicate tool name "${toolName}" in runAgentLoop. Rename one of the conflicting tools or disable an overlapping built-in tool.`,
      );
    }
    merged[toolName] = toolSpec;
  }
  return merged;
}

function createSubagentController(params: {
  readonly runId: string;
  readonly model: LlmToolLoopRequest["model"];
  readonly depth: number;
  readonly telemetry: AgentTelemetrySession | undefined;
  readonly customTools: LlmToolSet;
  readonly filesystemSelection: AgentFilesystemToolSelection | undefined;
  readonly subagentSelection: AgentSubagentToolSelection | undefined;
  readonly toolLoopRequest: Omit<
    RunAgentLoopRequest,
    "tools" | "filesystemTool" | "filesystem_tool"
  >;
  readonly resolvedSubagentConfig: ResolvedAgentSubagentToolConfig;
}) {
  if (!params.resolvedSubagentConfig.enabled) {
    return null;
  }
  return createSubagentToolController({
    config: params.resolvedSubagentConfig,
    parentDepth: params.depth,
    parentModel: params.resolvedSubagentConfig.model ?? params.model,
    buildChildInstructions: (spawnInstructions, childDepth) =>
      buildChildInstructions(spawnInstructions, params.resolvedSubagentConfig, childDepth),
    runSubagent: async (subagentRequest) => {
      const childCustomTools = params.resolvedSubagentConfig.inheritTools ? params.customTools : {};
      const childFilesystemSelection = params.resolvedSubagentConfig.inheritFilesystemTool
        ? params.filesystemSelection
        : false;
      return await runAgentLoopInternal(
        {
          model: subagentRequest.model,
          input: subagentRequest.input,
          instructions: subagentRequest.instructions,
          tools: childCustomTools,
          filesystemTool: childFilesystemSelection,
          subagentTool: params.subagentSelection,
          modelTools: params.toolLoopRequest.modelTools,
          maxSteps: subagentRequest.maxSteps,
          openAiReasoningEffort: params.toolLoopRequest.openAiReasoningEffort,
          signal: subagentRequest.signal,
        },
        {
          depth: params.depth + 1,
          parentRunId: params.runId,
          telemetry: params.telemetry,
        },
      );
    },
  });
}

function buildLoopInstructions(
  baseInstructions: string | undefined,
  config: ResolvedAgentSubagentToolConfig,
  depth: number,
): string | undefined {
  if (!config.enabled) {
    return trimToUndefined(baseInstructions);
  }
  const blocks: string[] = [];
  const base = trimToUndefined(baseInstructions);
  if (base) {
    blocks.push(base);
  }
  if (config.promptPattern === "codex") {
    blocks.push(
      buildCodexSubagentOrchestratorInstructions({
        currentDepth: depth,
        maxDepth: config.maxDepth,
        maxAgents: config.maxAgents,
      }),
    );
  }
  if (config.instructions) {
    blocks.push(config.instructions);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function buildChildInstructions(
  spawnInstructions: string | undefined,
  config: ResolvedAgentSubagentToolConfig,
  childDepth: number,
): string | undefined {
  const blocks: string[] = [];
  if (config.promptPattern === "codex") {
    blocks.push(
      buildCodexSubagentWorkerInstructions({
        depth: childDepth,
        maxDepth: config.maxDepth,
      }),
    );
  }
  if (config.instructions) {
    blocks.push(config.instructions);
  }
  const perSpawn = trimToUndefined(spawnInstructions);
  if (perSpawn) {
    blocks.push(perSpawn);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function randomRunId(): string {
  return randomBytes(8).toString("hex");
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function countToolCalls(result: LlmToolLoopResult): number {
  let count = 0;
  for (const step of result.steps) {
    count += step.toolCalls.length;
  }
  return count;
}

function sumUsageValue(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return current;
  }
  const normalizedNext = Math.max(0, next);
  if (typeof current !== "number" || !Number.isFinite(current)) {
    return normalizedNext;
  }
  return Math.max(0, current) + normalizedNext;
}

function summarizeResultUsage(result: LlmToolLoopResult): LlmUsageTokens | undefined {
  let summary: LlmUsageTokens | undefined;
  for (const step of result.steps) {
    const usage = step.usage;
    if (!usage) {
      continue;
    }
    summary = {
      promptTokens: sumUsageValue(summary?.promptTokens, usage.promptTokens),
      cachedTokens: sumUsageValue(summary?.cachedTokens, usage.cachedTokens),
      responseTokens: sumUsageValue(summary?.responseTokens, usage.responseTokens),
      responseImageTokens: sumUsageValue(summary?.responseImageTokens, usage.responseImageTokens),
      thinkingTokens: sumUsageValue(summary?.thinkingTokens, usage.thinkingTokens),
      totalTokens: sumUsageValue(summary?.totalTokens, usage.totalTokens),
      toolUsePromptTokens: sumUsageValue(summary?.toolUsePromptTokens, usage.toolUsePromptTokens),
    };
  }
  return summary;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAgentTelemetrySink(value: unknown): value is AgentTelemetrySink {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { emit?: unknown }).emit === "function"
  );
}

function resolveTelemetrySelection(
  telemetry: AgentTelemetrySelection | undefined,
): AgentTelemetryConfig | undefined {
  if (!telemetry) {
    return undefined;
  }
  if (isAgentTelemetrySink(telemetry)) {
    return { sink: telemetry };
  }
  if (isAgentTelemetrySink(telemetry.sink)) {
    return telemetry;
  }
  throw new Error("Invalid runAgentLoop telemetry config: expected a sink with emit(event).");
}

function createAgentTelemetrySession(
  telemetry: AgentTelemetrySelection | undefined,
): AgentTelemetrySession | undefined {
  const config = resolveTelemetrySelection(telemetry);
  if (!config) {
    return undefined;
  }

  const pending = new Set<Promise<void>>();
  const trackPromise = (promise: Promise<void>): void => {
    pending.add(promise);
    promise.finally(() => {
      pending.delete(promise);
    });
  };
  const emit = (event: AgentTelemetryEvent): void => {
    try {
      const output = config.sink.emit(event);
      if (isPromiseLike(output)) {
        const task = Promise.resolve(output)
          .then(() => undefined)
          .catch(() => undefined);
        trackPromise(task);
      }
    } catch {
      // Telemetry failures must never break agent execution.
    }
  };
  const flush = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    if (typeof config.sink.flush === "function") {
      try {
        await config.sink.flush();
      } catch {
        // Telemetry failures must never break agent execution.
      }
    }
  };

  return {
    includeLlmStreamEvents: config.includeLlmStreamEvents === true,
    emit,
    flush,
  };
}

function createAgentTelemetryEmitter(params: {
  session: AgentTelemetrySession | undefined;
  runId: string;
  parentRunId?: string;
  depth: number;
  model: LlmToolLoopRequest["model"];
}): (event: AgentTelemetryEventPayload) => void {
  return (event) => {
    if (!params.session) {
      return;
    }
    params.session.emit({
      ...event,
      timestamp: toIsoNow(),
      runId: params.runId,
      ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
      depth: params.depth,
      model: params.model,
    } as AgentTelemetryEvent);
  };
}
