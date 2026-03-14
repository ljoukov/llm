import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type AgentSubagentToolSelection,
  buildCodexSubagentOrchestratorInstructions,
  buildCodexSubagentWorkerInstructions,
  createSubagentToolController,
  type ResolvedAgentSubagentToolConfig,
  resolveSubagentToolConfig,
} from "./agent/subagents.js";
import {
  type AgentLoggingConfig,
  type AgentLoggingSelection,
  type AgentLoggingSession,
  createAgentLoggingSession,
  createAgentStreamEventLogger,
  runWithAgentLoggingSession,
} from "./agentLogging.js";
import {
  createToolLoopSteeringChannel,
  type LlmInputMessage,
  type LlmStreamEvent,
  type LlmToolLoopRequest,
  type LlmToolLoopResult,
  type LlmToolLoopSteeringAppendResult,
  type LlmToolLoopSteeringInput,
  type LlmToolSet,
  type LlmUsageTokens,
  runToolLoop,
} from "./llm.js";
import {
  collectFileUploadMetrics,
  emptyFileUploadMetrics,
  getCurrentFileUploadMetrics,
} from "./files.js";
import {
  type AgentFilesystemToolProfile,
  type AgentFilesystemToolsOptions,
  createFilesystemToolSetForModel,
} from "./tools/filesystemTools.js";
import {
  createTelemetrySession,
  type AgentRunCompletedTelemetryEvent,
  type AgentRunStartedTelemetryEvent,
  type AgentRunStreamTelemetryEvent,
  type TelemetrySelection,
  type TelemetrySession,
} from "./telemetry.js";
import { createAsyncQueue } from "./utils/asyncQueue.js";

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
export type {
  AgentLoggingConfig,
  AgentLoggingSelection,
  AgentLogLineSink,
} from "./agentLogging.js";

export type RunAgentLoopRequest = Omit<LlmToolLoopRequest, "tools"> & {
  readonly tools?: LlmToolSet;
  readonly filesystemTool?: AgentFilesystemToolSelection;
  readonly filesystem_tool?: AgentFilesystemToolSelection;
  readonly subagentTool?: AgentSubagentToolSelection;
  readonly subagent_tool?: AgentSubagentToolSelection;
  readonly subagents?: AgentSubagentToolSelection;
  readonly telemetry?: TelemetrySelection;
  readonly logging?: AgentLoggingSelection;
};

export type AgentLoopStream = {
  readonly events: AsyncIterable<LlmStreamEvent>;
  readonly result: Promise<LlmToolLoopResult>;
  readonly append: (input: LlmToolLoopSteeringInput) => LlmToolLoopSteeringAppendResult;
  readonly steer: (input: LlmToolLoopSteeringInput) => LlmToolLoopSteeringAppendResult;
  readonly pendingSteeringCount: () => number;
  readonly abort: () => void;
};

export async function runAgentLoop(request: RunAgentLoopRequest): Promise<LlmToolLoopResult> {
  const telemetry = createTelemetrySession(request.telemetry);
  const logging = createRootAgentLoggingSession(request);
  try {
    return await runWithAgentLoggingSession(logging, async () => {
      return await runAgentLoopInternal(request, {
        depth: 0,
        telemetry,
        logging,
      });
    });
  } finally {
    await telemetry?.flush();
    await logging?.flush();
  }
}

function mergeAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  if (first.aborted) {
    abortFrom(first);
  } else {
    first.addEventListener("abort", () => abortFrom(first), { once: true });
  }
  if (second.aborted) {
    abortFrom(second);
  } else {
    second.addEventListener("abort", () => abortFrom(second), { once: true });
  }
  return controller.signal;
}

export function streamAgentLoop(request: RunAgentLoopRequest): AgentLoopStream {
  const queue = createAsyncQueue<LlmStreamEvent>();
  const abortController = new AbortController();
  const steering = request.steering ?? createToolLoopSteeringChannel();
  const signal = mergeAbortSignals(request.signal, abortController.signal);
  const sourceOnEvent = request.onEvent;

  const result = (async () => {
    try {
      const output = await runAgentLoop({
        ...request,
        steering,
        ...(signal ? { signal } : {}),
        onEvent: (event) => {
          sourceOnEvent?.(event);
          queue.push(event);
        },
      });
      queue.close();
      return output;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      queue.fail(err);
      throw err;
    }
  })();

  return {
    events: queue.iterable,
    result,
    append: steering.append,
    steer: steering.steer,
    pendingSteeringCount: steering.pendingCount,
    abort: () => abortController.abort(),
  };
}

type RunAgentLoopInternalContext = {
  readonly depth: number;
  readonly parentRunId?: string;
  readonly telemetry?: TelemetrySession;
  readonly logging?: AgentLoggingSession;
};

type AgentTelemetryEventPayload =
  | Omit<AgentRunStartedTelemetryEvent, "timestamp" | "runId" | "parentRunId" | "depth" | "model">
  | Omit<AgentRunStreamTelemetryEvent, "timestamp" | "runId" | "parentRunId" | "depth" | "model">
  | Omit<
      AgentRunCompletedTelemetryEvent,
      "timestamp" | "runId" | "parentRunId" | "depth" | "model"
    >;

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
    logging: _logging,
    ...toolLoopRequest
  } = request;

  const telemetrySession = context.telemetry ?? createTelemetrySession(telemetry);
  const loggingSession = context.logging;
  const runId = randomRunId();
  const startedAtMs = Date.now();
  const steeringChannel = toolLoopRequest.steering ?? createToolLoopSteeringChannel();
  const toolLoopRequestWithSteering =
    toolLoopRequest.steering === steeringChannel
      ? toolLoopRequest
      : { ...toolLoopRequest, steering: steeringChannel };
  const filesystemSelection = filesystemTool ?? filesystem_tool;
  const subagentSelection = subagentTool ?? subagent_tool ?? subagents;
  const filesystemTools = resolveFilesystemTools(request.model, filesystemSelection);
  const resolvedSubagentConfig = resolveSubagentToolConfig(subagentSelection, context.depth);
  const subagentController = createSubagentController({
    runId,
    model: request.model,
    depth: context.depth,
    telemetry: telemetrySession,
    logging: loggingSession,
    customTools: customTools ?? {},
    filesystemSelection,
    subagentSelection,
    toolLoopRequest: toolLoopRequestWithSteering,
    steering: steeringChannel,
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
    toolLoopRequestWithSteering.instructions,
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
  loggingSession?.logLine(
    [
      `[agent:${runId}] run_started`,
      `depth=${context.depth.toString()}`,
      `model=${request.model}`,
      `tools=${Object.keys(mergedTools).length.toString()}`,
      `filesystemTools=${Object.keys(filesystemTools).length > 0 ? "true" : "false"}`,
      `subagentTools=${resolvedSubagentConfig.enabled ? "true" : "false"}`,
    ].join(" "),
  );

  const sourceOnEvent = toolLoopRequestWithSteering.onEvent;
  const includeStreamEvents = telemetrySession?.includeStreamEvents === true;
  const streamEventLogger = loggingSession
    ? createAgentStreamEventLogger({
        append: (line) => {
          loggingSession.logLine(`[agent:${runId}] ${line}`);
        },
      })
    : undefined;
  const wrappedOnEvent =
    sourceOnEvent || includeStreamEvents
      ? (event: LlmStreamEvent) => {
          sourceOnEvent?.(event);
          if (includeStreamEvents) {
            emitTelemetry({ type: "agent.run.stream", event });
          }
          streamEventLogger?.appendEvent(event);
        }
      : undefined;
  let uploadMetrics = emptyFileUploadMetrics();

  try {
    let result: LlmToolLoopResult | undefined;
    await collectFileUploadMetrics(async () => {
      try {
        result = await runToolLoop({
          ...toolLoopRequestWithSteering,
          ...(instructions ? { instructions } : {}),
          ...(wrappedOnEvent ? { onEvent: wrappedOnEvent } : {}),
          tools: mergedTools,
        });
      } finally {
        uploadMetrics = getCurrentFileUploadMetrics();
      }
    });
    if (!result) {
      throw new Error("runToolLoop returned no result.");
    }
    streamEventLogger?.flush();
    emitTelemetry({
      type: "agent.run.completed",
      success: true,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      stepCount: result.steps.length,
      toolCallCount: countToolCalls(result),
      totalCostUsd: result.totalCostUsd,
      usage: summarizeResultUsage(result),
      uploadCount: uploadMetrics.count,
      uploadBytes: uploadMetrics.totalBytes,
      uploadLatencyMs: uploadMetrics.totalLatencyMs,
    });
    loggingSession?.logLine(
      [
        `[agent:${runId}] run_completed`,
        `status=ok`,
        `durationMs=${Math.max(0, Date.now() - startedAtMs).toString()}`,
        `steps=${result.steps.length.toString()}`,
        `toolCalls=${countToolCalls(result).toString()}`,
        `totalCostUsd=${(result.totalCostUsd ?? 0).toFixed(6)}`,
        `uploadCount=${uploadMetrics.count.toString()}`,
        `uploadBytes=${uploadMetrics.totalBytes.toString()}`,
        `uploadLatencyMs=${uploadMetrics.totalLatencyMs.toString()}`,
      ].join(" "),
    );
    for (const step of result.steps) {
      loggingSession?.logLine(
        [
          `[agent:${runId}] step_completed`,
          `step=${step.step.toString()}`,
          `modelVersion=${step.modelVersion}`,
          `toolCalls=${step.toolCalls.length.toString()}`,
          `costUsd=${(step.costUsd ?? 0).toFixed(6)}`,
        ].join(" "),
      );
    }
    return result;
  } catch (error) {
    streamEventLogger?.flush();
    emitTelemetry({
      type: "agent.run.completed",
      success: false,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      uploadCount: uploadMetrics.count,
      uploadBytes: uploadMetrics.totalBytes,
      uploadLatencyMs: uploadMetrics.totalLatencyMs,
      error: toErrorMessage(error),
    });
    loggingSession?.logLine(
      [
        `[agent:${runId}] run_completed`,
        `status=error`,
        `durationMs=${Math.max(0, Date.now() - startedAtMs).toString()}`,
        `uploadCount=${uploadMetrics.count.toString()}`,
        `uploadBytes=${uploadMetrics.totalBytes.toString()}`,
        `uploadLatencyMs=${uploadMetrics.totalLatencyMs.toString()}`,
        `error=${toErrorMessage(error)}`,
      ].join(" "),
    );
    throw error;
  } finally {
    streamEventLogger?.flush();
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
  readonly telemetry: TelemetrySession | undefined;
  readonly logging: AgentLoggingSession | undefined;
  readonly customTools: LlmToolSet;
  readonly filesystemSelection: AgentFilesystemToolSelection | undefined;
  readonly subagentSelection: AgentSubagentToolSelection | undefined;
  readonly steering: LlmToolLoopRequest["steering"];
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
    forkContextMessages: normalizeForkContextMessages(params.toolLoopRequest.input),
    onBackgroundMessage: (message) => {
      params.steering?.append({ role: "user", content: message });
    },
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
          thinkingLevel: params.toolLoopRequest.thinkingLevel,
          signal: subagentRequest.signal,
        },
        {
          depth: params.depth + 1,
          parentRunId: params.runId,
          telemetry: params.telemetry,
          logging: params.logging,
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

function normalizeForkContextMessages(input: RunAgentLoopRequest["input"]): LlmInputMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  return input.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
  }));
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

function resolveAgentLoggingSelection(
  value: AgentLoggingSelection | undefined,
): AgentLoggingConfig | undefined {
  if (value === false) {
    return undefined;
  }
  if (value === undefined || value === true) {
    return {
      mirrorToConsole: true,
    };
  }
  return value;
}

function resolveWorkspaceDirForLogging(request: RunAgentLoopRequest): string {
  const explicitSelection = request.filesystemTool ?? request.filesystem_tool;
  if (
    explicitSelection &&
    typeof explicitSelection === "object" &&
    !Array.isArray(explicitSelection)
  ) {
    const cwd = explicitSelection.options?.cwd;
    if (typeof cwd === "string" && cwd.trim().length > 0) {
      return path.resolve(cwd);
    }
  }
  return process.cwd();
}

function createRootAgentLoggingSession(
  request: RunAgentLoopRequest,
): AgentLoggingSession | undefined {
  const selected = resolveAgentLoggingSelection(request.logging);
  if (!selected) {
    return undefined;
  }
  const workspaceDir =
    typeof selected.workspaceDir === "string" && selected.workspaceDir.trim().length > 0
      ? path.resolve(selected.workspaceDir)
      : resolveWorkspaceDirForLogging(request);
  return createAgentLoggingSession({
    ...selected,
    workspaceDir,
    mirrorToConsole: selected.mirrorToConsole !== false,
  });
}

function createAgentTelemetryEmitter(params: {
  session: TelemetrySession | undefined;
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
    });
  };
}
