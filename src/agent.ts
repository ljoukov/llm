import {
  runToolLoop,
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
};

export async function runAgentLoop(request: RunAgentLoopRequest): Promise<LlmToolLoopResult> {
  return await runAgentLoopInternal(request, { depth: 0 });
}

type RunAgentLoopInternalContext = {
  readonly depth: number;
};

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
    ...toolLoopRequest
  } = request;

  const filesystemSelection = filesystemTool ?? filesystem_tool;
  const subagentSelection = subagentTool ?? subagent_tool ?? subagents;
  const filesystemTools = resolveFilesystemTools(request.model, filesystemSelection);
  const resolvedSubagentConfig = resolveSubagentToolConfig(subagentSelection, context.depth);
  const subagentController = createSubagentController({
    model: request.model,
    depth: context.depth,
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

  try {
    return await runToolLoop({
      ...toolLoopRequest,
      ...(instructions ? { instructions } : {}),
      tools: mergedTools,
    });
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
  readonly model: LlmToolLoopRequest["model"];
  readonly depth: number;
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
        { depth: params.depth + 1 },
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
