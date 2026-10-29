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
  type LlmChatGptImageBackground,
  type LlmOpenAiImageQuality,
  type LlmOpenAiImageResolution,
  type LlmOpenAiImageSize,
  type LlmStreamEvent,
  type LlmToolConfig,
  type LlmToolLoopRequest,
  type LlmToolLoopResult,
  type LlmToolLoopSteeringAppendResult,
  type LlmToolLoopSteeringInput,
  type LlmToolSet,
  type LlmUsageTokens,
  runToolLoop,
} from "./llm.js";
import type { OpenAiImageModelId } from "./openai/models.js";
import { type ResolvedModelRef, resolveModelRef } from "./model-selection.js";
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
import { createImageGenerationTool } from "./tools/imageGeneration.js";
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

type AgentImageGenerationToolConfigBase = {
  readonly enabled?: boolean;
  readonly background?: LlmChatGptImageBackground;
};

export type AgentOpenAiImageGenerationToolConfig = AgentImageGenerationToolConfigBase & {
  /** Select the public Images API and enable its structured image controls. */
  readonly provider?: "openai";
  readonly access?: "api";
  readonly model: OpenAiImageModelId;
  readonly imageResolution?: LlmOpenAiImageResolution;
  readonly imageSize?: LlmOpenAiImageSize;
  readonly imageQuality?: LlmOpenAiImageQuality;
};

export type AgentSubscriptionImageGenerationToolConfig = AgentImageGenerationToolConfigBase & {
  /** Select image rendering through the OpenAI subscription. */
  readonly provider?: "openai";
  readonly access: "subscription";
  readonly model?: OpenAiImageModelId;
};

export type AgentImageGenerationToolConfig =
  | AgentOpenAiImageGenerationToolConfig
  | AgentSubscriptionImageGenerationToolConfig;

export type AgentImageGenerationToolSelection = boolean | AgentImageGenerationToolConfig;

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

type WithoutTools<T> = T extends unknown ? Omit<T, "tools"> : never;

export type RunAgentLoopRequest = WithoutTools<LlmToolLoopRequest> & {
  readonly tools?: LlmToolSet;
  readonly filesystemTool?: AgentFilesystemToolSelection;
  readonly filesystem_tool?: AgentFilesystemToolSelection;
  readonly subagentTool?: AgentSubagentToolSelection;
  readonly subagent_tool?: AgentSubagentToolSelection;
  readonly subagents?: AgentSubagentToolSelection;
  readonly imageGenerationTool?: AgentImageGenerationToolSelection;
  readonly image_generation_tool?: AgentImageGenerationToolSelection;
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
  // Resolve environment-dependent defaults once. Children inherit this complete route,
  // so later credential or environment changes cannot redirect part of an agent run.
  const route = Object.freeze(resolveModelRef(request));
  const resolvedRequest = { ...request, ...route } as RunAgentLoopRequest;
  const telemetry = createTelemetrySession(request.telemetry);
  const logging = createRootAgentLoggingSession(request);
  try {
    return await runWithAgentLoggingSession(logging, async () => {
      return await runAgentLoopInternal(resolvedRequest, {
        depth: 0,
        route,
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
  readonly route: ResolvedModelRef;
  readonly parentRunId?: string;
  readonly telemetry?: TelemetrySession;
  readonly logging?: AgentLoggingSession;
};

type AgentTelemetryEventPayload =
  | Omit<
      AgentRunStartedTelemetryEvent,
      "timestamp" | "runId" | "parentRunId" | "depth" | "provider" | "access" | "model"
    >
  | Omit<
      AgentRunStreamTelemetryEvent,
      "timestamp" | "runId" | "parentRunId" | "depth" | "provider" | "access" | "model"
    >
  | Omit<
      AgentRunCompletedTelemetryEvent,
      "timestamp" | "runId" | "parentRunId" | "depth" | "provider" | "access" | "model"
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
    imageGenerationTool,
    image_generation_tool,
    telemetry,
    logging: _logging,
    ...baseToolLoopRequest
  } = request;

  const imageToolSelection = imageGenerationTool ?? image_generation_tool;
  const resolvedImageTools = resolveAgentImageGenerationTools(
    context.route,
    imageToolSelection,
    request.signal,
  );
  const toolLoopRequest = {
    ...baseToolLoopRequest,
    ...(resolvedImageTools.modelTools.length > 0
      ? {
          modelTools: [...(baseToolLoopRequest.modelTools ?? []), ...resolvedImageTools.modelTools],
        }
      : {}),
  };

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
  const requestedSubagentSelection = subagentTool ?? subagent_tool ?? subagents;
  const subagentSelection =
    requestedSubagentSelection === undefined && toolLoopRequest.thinkingLevel === "ultra"
      ? true
      : requestedSubagentSelection;
  const filesystemTools = resolveFilesystemTools(
    request.model,
    filesystemSelection,
    request.mediaResolution,
  );
  const resolvedSubagentConfig = resolveSubagentToolConfig(subagentSelection, context.depth);
  const subagentController = createSubagentController({
    runId,
    route: context.route,
    depth: context.depth,
    telemetry: telemetrySession,
    logging: loggingSession,
    customTools: customTools ?? {},
    imageGenerationSelection: imageToolSelection,
    baseModelTools: baseToolLoopRequest.modelTools,
    filesystemSelection,
    subagentSelection,
    toolLoopRequest: toolLoopRequestWithSteering,
    steering: steeringChannel,
    resolvedSubagentConfig,
  });
  const mergedTools = mergeToolSets(
    mergeToolSets(
      mergeToolSets(filesystemTools, subagentController?.tools ?? {}),
      resolvedImageTools.runtimeTools,
    ),
    customTools ?? {},
  );

  if (
    Object.keys(mergedTools).length === 0 &&
    (!toolLoopRequest.modelTools || toolLoopRequest.modelTools.length === 0)
  ) {
    throw new Error(
      "runAgentLoop requires at least one tool. Provide `tools` or `modelTools`, enable `filesystemTool`, or enable `subagentTool`.",
    );
  }

  const instructions = buildLoopInstructions(
    toolLoopRequestWithSteering.instructions,
    resolvedSubagentConfig,
    context.depth,
    toolLoopRequestWithSteering.thinkingLevel === "ultra" ? "proactive" : "explicit-request-only",
  );
  const emitTelemetry = createAgentTelemetryEmitter({
    session: telemetrySession,
    runId,
    parentRunId: context.parentRunId,
    depth: context.depth,
    route: context.route,
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
      `provider=${context.route.provider}`,
      `access=${context.route.access}`,
      `model=${request.model}`,
      ...(context.route.speed ? [`requestedSpeed=${context.route.speed}`] : []),
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
    const lastStep = result.steps.at(-1);
    streamEventLogger?.flush();
    emitTelemetry({
      type: "agent.run.completed",
      success: true,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      stepCount: result.steps.length,
      toolCallCount: countToolCalls(result),
      totalCostUsd: result.totalCostUsd,
      ...(lastStep?.effectiveSpeed ? { effectiveSpeed: lastStep.effectiveSpeed } : {}),
      ...(lastStep?.serviceTier ? { serviceTier: lastStep.serviceTier } : {}),
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
        `totalCostUsd=${formatCostUsd(result.totalCostUsd)}`,
        ...(context.route.speed ? [`requestedSpeed=${context.route.speed}`] : []),
        ...(lastStep?.effectiveSpeed ? [`effectiveSpeed=${lastStep.effectiveSpeed}`] : []),
        ...(lastStep?.serviceTier ? [`serviceTier=${lastStep.serviceTier}`] : []),
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
          ...(step.requestedSpeed ? [`requestedSpeed=${step.requestedSpeed}`] : []),
          ...(step.effectiveSpeed ? [`effectiveSpeed=${step.effectiveSpeed}`] : []),
          ...(step.serviceTier ? [`serviceTier=${step.serviceTier}`] : []),
          `toolCalls=${step.toolCalls.length.toString()}`,
          `costUsd=${formatCostUsd(step.costUsd)}`,
          ...(step.costSource ? [`costSource=${step.costSource}`] : []),
          ...(step.apiEquivalentCostUsd !== undefined
            ? [`apiEquivalentCostUsd=${formatCostUsd(step.apiEquivalentCostUsd)}`]
            : []),
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
        ...(context.route.speed ? [`requestedSpeed=${context.route.speed}`] : []),
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
  defaultMediaResolution: RunAgentLoopRequest["mediaResolution"],
): LlmToolSet {
  const withDefaultMediaResolution = (
    options: AgentFilesystemToolsOptions | undefined,
  ): AgentFilesystemToolsOptions | undefined => {
    if (defaultMediaResolution === undefined) {
      return options;
    }
    return {
      mediaResolution: defaultMediaResolution,
      ...(options ?? {}),
    };
  };

  if (selection === undefined || selection === false) {
    return {};
  }
  if (selection === true) {
    return createFilesystemToolSetForModel(model, withDefaultMediaResolution(undefined) ?? {});
  }
  if (typeof selection === "string") {
    return createFilesystemToolSetForModel(model, selection, withDefaultMediaResolution(undefined));
  }
  if (selection.enabled === false) {
    return {};
  }
  if (selection.options && selection.profile !== undefined) {
    return createFilesystemToolSetForModel(
      model,
      selection.profile,
      withDefaultMediaResolution(selection.options),
    );
  }
  if (selection.options) {
    return createFilesystemToolSetForModel(
      model,
      withDefaultMediaResolution(selection.options) ?? {},
    );
  }
  if (defaultMediaResolution !== undefined) {
    return createFilesystemToolSetForModel(
      model,
      selection.profile ?? "auto",
      withDefaultMediaResolution(undefined),
    );
  }
  return createFilesystemToolSetForModel(model, selection.profile ?? "auto");
}

function resolveAgentImageGenerationTools(
  outerRoute: ResolvedModelRef,
  selection: AgentImageGenerationToolSelection | undefined,
  signal: AbortSignal | undefined,
): {
  readonly runtimeTools: LlmToolSet;
  readonly modelTools: LlmToolConfig[];
} {
  if (selection === undefined || selection === false) {
    return { runtimeTools: {}, modelTools: [] };
  }
  const config:
    | Partial<AgentOpenAiImageGenerationToolConfig>
    | Partial<AgentSubscriptionImageGenerationToolConfig> =
    typeof selection === "object" ? selection : {};
  if (config.enabled === false) {
    return { runtimeTools: {}, modelTools: [] };
  }

  const defaultImageModel =
    outerRoute.provider === "openai" || config.access === "subscription"
      ? ("gpt-image-2" as const)
      : undefined;
  const imageModel = config.model ?? defaultImageModel;
  if (!imageModel) {
    throw new Error(
      "imageGenerationTool requires an explicit image model when the outer provider is not OpenAI.",
    );
  }

  const imageResolution = "imageResolution" in config ? config.imageResolution : undefined;
  const imageSize = "imageSize" in config ? config.imageSize : undefined;
  const imageQuality = "imageQuality" in config ? config.imageQuality : undefined;
  const imageAccess = config.access ?? (config.model ? "api" : outerRoute.access);
  resolveModelRef({
    provider: config.provider ?? "openai",
    access: imageAccess,
    model: imageModel,
  });

  if (outerRoute.provider === "openai" && outerRoute.access === "api" && imageAccess === "api") {
    return {
      runtimeTools: {},
      modelTools: [
        {
          type: "image-generation",
          model: imageModel,
          ...(imageResolution ? { imageResolution } : {}),
          ...(imageSize ? { imageSize } : {}),
          ...(imageQuality ? { imageQuality } : {}),
          ...(config.background ? { background: config.background } : {}),
        },
      ],
    };
  }

  if (
    imageAccess === "subscription" &&
    (imageResolution !== undefined || imageSize !== undefined || imageQuality !== undefined)
  ) {
    throw new Error(
      "ChatGPT subscription image generation always uses automatic size and quality. Put the desired orientation or aspect ratio in the image prompt instead.",
    );
  }

  return {
    runtimeTools: {
      image_generation: createImageGenerationTool({
        provider: "openai",
        access: imageAccess,
        model: imageModel,
        ...(imageResolution ? { imageResolution } : {}),
        ...(imageSize ? { imageSize } : {}),
        ...(imageQuality ? { imageQuality } : {}),
        ...(config.background ? { background: config.background } : {}),
        ...(signal ? { signal } : {}),
      }),
    },
    modelTools: [],
  };
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
  readonly route: ResolvedModelRef;
  readonly depth: number;
  readonly telemetry: TelemetrySession | undefined;
  readonly logging: AgentLoggingSession | undefined;
  readonly customTools: LlmToolSet;
  readonly imageGenerationSelection: AgentImageGenerationToolSelection | undefined;
  readonly baseModelTools: LlmToolLoopRequest["modelTools"];
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
    parentRoute: params.route,
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
          ...params.route,
          input: subagentRequest.input,
          instructions: subagentRequest.instructions,
          tools: childCustomTools,
          filesystemTool: childFilesystemSelection,
          imageGenerationTool: params.resolvedSubagentConfig.inheritTools
            ? params.imageGenerationSelection
            : false,
          subagentTool: params.subagentSelection,
          modelTools: params.baseModelTools,
          maxSteps: subagentRequest.maxSteps,
          thinkingLevel: params.toolLoopRequest.thinkingLevel,
          mediaResolution: params.toolLoopRequest.mediaResolution,
          signal: subagentRequest.signal,
        } as RunAgentLoopRequest,
        {
          depth: params.depth + 1,
          route: params.route,
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
  multiAgentMode: "explicit-request-only" | "proactive",
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
        mode: multiAgentMode,
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

function formatCostUsd(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : "unknown";
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
      promptTextTokens: sumUsageValue(summary?.promptTextTokens, usage.promptTextTokens),
      promptImageTokens: sumUsageValue(summary?.promptImageTokens, usage.promptImageTokens),
      cachedTokens: sumUsageValue(summary?.cachedTokens, usage.cachedTokens),
      cacheWriteTokens: sumUsageValue(summary?.cacheWriteTokens, usage.cacheWriteTokens),
      anthropicCacheCreation5mInputTokens: sumUsageValue(
        summary?.anthropicCacheCreation5mInputTokens,
        usage.anthropicCacheCreation5mInputTokens,
      ),
      anthropicCacheCreation1hInputTokens: sumUsageValue(
        summary?.anthropicCacheCreation1hInputTokens,
        usage.anthropicCacheCreation1hInputTokens,
      ),
      responseTokens: sumUsageValue(summary?.responseTokens, usage.responseTokens),
      responseTextTokens: sumUsageValue(summary?.responseTextTokens, usage.responseTextTokens),
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
  route: ResolvedModelRef;
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
      provider: params.route.provider,
      access: params.route.access,
      model: params.route.model,
      ...(params.route.speed ? { requestedSpeed: params.route.speed } : {}),
    });
  };
}
