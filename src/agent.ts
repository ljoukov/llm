import {
  runToolLoop,
  type LlmToolLoopRequest,
  type LlmToolLoopResult,
  type LlmToolSet,
} from "./llm.js";
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

export type RunAgentLoopRequest = Omit<LlmToolLoopRequest, "tools"> & {
  readonly tools?: LlmToolSet;
  readonly filesystemTool?: AgentFilesystemToolSelection;
  readonly filesystem_tool?: AgentFilesystemToolSelection;
};

export async function runAgentLoop(request: RunAgentLoopRequest): Promise<LlmToolLoopResult> {
  const { tools: customTools, filesystemTool, filesystem_tool, ...toolLoopRequest } = request;

  const filesystemSelection = filesystemTool ?? filesystem_tool;
  const filesystemTools = resolveFilesystemTools(request.model, filesystemSelection);
  const mergedTools = mergeToolSets(filesystemTools, customTools ?? {});

  if (Object.keys(mergedTools).length === 0) {
    throw new Error(
      "runAgentLoop requires at least one tool. Provide `tools` or enable `filesystemTool`.",
    );
  }

  return runToolLoop({
    ...toolLoopRequest,
    tools: mergedTools,
  });
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
        `Duplicate tool name "${toolName}" in runAgentLoop. Rename the custom tool or disable that filesystem tool.`,
      );
    }
    merged[toolName] = toolSpec;
  }
  return merged;
}
