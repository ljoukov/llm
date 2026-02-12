import path from "node:path";

import { z } from "zod";

import { type LlmExecutableTool, type LlmToolSet, tool } from "../llm.js";
import {
  applyPatch,
  CODEX_APPLY_PATCH_INPUT_DESCRIPTION,
  CODEX_APPLY_PATCH_JSON_TOOL_DESCRIPTION,
} from "./applyPatch.js";
import {
  createNodeAgentFilesystem,
  type AgentDirectoryEntry,
  type AgentFilesystem,
} from "./filesystem.js";

const DEFAULT_READ_FILE_LINE_LIMIT = 2000;
const DEFAULT_LIST_DIR_LIMIT = 25;
const DEFAULT_LIST_DIR_DEPTH = 2;
const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 2000;
const DEFAULT_MAX_LINE_LENGTH = 500;
const DEFAULT_GREP_MAX_SCANNED_FILES = 20_000;
const DEFAULT_TAB_WIDTH = 4;

type CodexReadMode = "slice" | "indentation";

type ReadLineRecord = {
  readonly number: number;
  readonly raw: string;
  readonly display: string;
  readonly indent: number;
};

type ListEntryRecord = {
  readonly name: string;
  readonly displayName: string;
  readonly depth: number;
  readonly kind: AgentDirectoryEntry["kind"];
};

type GrepMatchRecord = {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly lineNumber?: number;
  readonly line?: string;
};

export type AgentFilesystemToolProfile = "auto" | "model-agnostic" | "codex" | "gemini";

export type AgentFilesystemToolName =
  | "apply_patch"
  | "read_file"
  | "write_file"
  | "replace"
  | "list_dir"
  | "list_directory"
  | "grep_files"
  | "grep_search"
  | "glob";

export type AgentFilesystemToolAction = "read" | "write" | "delete" | "move" | "list" | "search";

export type AgentFilesystemToolAccessContext = {
  readonly cwd: string;
  readonly tool: AgentFilesystemToolName;
  readonly action: AgentFilesystemToolAction;
  readonly path: string;
  readonly fromPath?: string;
  readonly toPath?: string;
  readonly pattern?: string;
  readonly include?: string;
};

export type AgentFilesystemToolAccessHook = (
  context: AgentFilesystemToolAccessContext,
) => Promise<void> | void;

export type AgentFilesystemToolsOptions = {
  readonly cwd?: string;
  readonly fs?: AgentFilesystem;
  readonly allowOutsideCwd?: boolean;
  readonly checkAccess?: AgentFilesystemToolAccessHook;
  readonly maxLineLength?: number;
  readonly grepMaxScannedFiles?: number;
  readonly applyPatch?: {
    readonly maxPatchBytes?: number;
  };
};

const codexReadFileInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to the file"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The line number to start reading from. Must be 1 or greater."),
  limit: z.number().int().min(1).optional().describe("The maximum number of lines to return."),
  mode: z
    .enum(["slice", "indentation"])
    .optional()
    .describe('Optional mode selector: "slice" (default) or "indentation".'),
  indentation: z
    .object({
      anchor_line: z.number().int().min(1).optional(),
      max_levels: z.number().int().min(0).optional(),
      include_siblings: z.boolean().optional(),
      include_header: z.boolean().optional(),
      max_lines: z.number().int().min(1).optional(),
    })
    .optional(),
});

const codexListDirInputSchema = z.object({
  dir_path: z.string().min(1).describe("Absolute path to the directory to list."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The entry number to start listing from. Must be 1 or greater."),
  limit: z.number().int().min(1).optional().describe("The maximum number of entries to return."),
  depth: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The maximum directory depth to traverse. Must be 1 or greater."),
});

const codexGrepFilesInputSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression pattern to search for."),
  include: z
    .string()
    .optional()
    .describe('Optional glob limiting searched files (for example "*.rs").'),
  path: z.string().optional().describe("Directory or file path to search. Defaults to cwd."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum number of file paths to return (defaults to 100)."),
});

const applyPatchInputSchema = z.object({
  input: z.string().min(1).describe(CODEX_APPLY_PATCH_INPUT_DESCRIPTION),
});

const geminiReadFileInputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

const geminiWriteFileInputSchema = z.object({
  file_path: z.string().min(1),
  content: z.string(),
});

const geminiReplaceInputSchema = z.object({
  file_path: z.string().min(1),
  instruction: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  expected_replacements: z.number().int().min(1).optional(),
});

const geminiListDirectoryInputSchema = z.object({
  dir_path: z.string().min(1),
  ignore: z.array(z.string()).optional(),
  file_filtering_options: z
    .object({
      respect_git_ignore: z.boolean().optional(),
      respect_gemini_ignore: z.boolean().optional(),
    })
    .optional(),
});

const geminiGrepSearchInputSchema = z.object({
  pattern: z.string().min(1),
  dir_path: z.string().optional(),
  include: z.string().optional(),
  exclude_pattern: z.string().optional(),
  names_only: z.boolean().optional(),
  max_matches_per_file: z.number().int().min(1).optional(),
  total_max_matches: z.number().int().min(1).optional(),
});

const geminiGlobInputSchema = z.object({
  pattern: z.string().min(1),
  dir_path: z.string().optional(),
  case_sensitive: z.boolean().optional(),
  respect_git_ignore: z.boolean().optional(),
  respect_gemini_ignore: z.boolean().optional(),
});

export type CodexReadFileToolInput = z.output<typeof codexReadFileInputSchema>;
export type CodexListDirToolInput = z.output<typeof codexListDirInputSchema>;
export type CodexGrepFilesToolInput = z.output<typeof codexGrepFilesInputSchema>;
export type CodexApplyPatchToolInput = z.output<typeof applyPatchInputSchema>;
export type GeminiReadFileToolInput = z.output<typeof geminiReadFileInputSchema>;
export type GeminiWriteFileToolInput = z.output<typeof geminiWriteFileInputSchema>;
export type GeminiReplaceToolInput = z.output<typeof geminiReplaceInputSchema>;
export type GeminiListDirectoryToolInput = z.output<typeof geminiListDirectoryInputSchema>;
export type GeminiGrepSearchToolInput = z.output<typeof geminiGrepSearchInputSchema>;
export type GeminiGlobToolInput = z.output<typeof geminiGlobInputSchema>;

export function resolveFilesystemToolProfile(
  model: string,
  profile: AgentFilesystemToolProfile = "auto",
): Exclude<AgentFilesystemToolProfile, "auto"> {
  if (profile !== "auto") {
    return profile;
  }
  if (isCodexModel(model)) {
    return "codex";
  }
  if (isGeminiModel(model)) {
    return "gemini";
  }
  return "model-agnostic";
}

export function createFilesystemToolSetForModel(
  model: string,
  profileOrOptions: AgentFilesystemToolProfile | AgentFilesystemToolsOptions = "auto",
  maybeOptions?: AgentFilesystemToolsOptions,
): LlmToolSet {
  if (typeof profileOrOptions === "string") {
    const resolvedProfile = resolveFilesystemToolProfile(model, profileOrOptions);
    if (resolvedProfile === "codex") {
      return createCodexFilesystemToolSet(maybeOptions);
    }
    if (resolvedProfile === "gemini") {
      return createGeminiFilesystemToolSet(maybeOptions);
    }
    return createModelAgnosticFilesystemToolSet(maybeOptions);
  }

  const resolvedProfile = resolveFilesystemToolProfile(model, "auto");
  if (resolvedProfile === "codex") {
    return createCodexFilesystemToolSet(profileOrOptions);
  }
  if (resolvedProfile === "gemini") {
    return createGeminiFilesystemToolSet(profileOrOptions);
  }
  return createModelAgnosticFilesystemToolSet(profileOrOptions);
}

export function createCodexFilesystemToolSet(
  options: AgentFilesystemToolsOptions = {},
): LlmToolSet {
  return {
    apply_patch: createCodexApplyPatchTool(options),
    read_file: createCodexReadFileTool(options),
    list_dir: createListDirTool(options),
    grep_files: createGrepFilesTool(options),
  };
}

export function createGeminiFilesystemToolSet(
  options: AgentFilesystemToolsOptions = {},
): LlmToolSet {
  return {
    read_file: createReadFileTool(options),
    write_file: createWriteFileTool(options),
    replace: createReplaceTool(options),
    list_directory: createListDirectoryTool(options),
    grep_search: createGrepSearchTool(options),
    glob: createGlobTool(options),
  };
}

export function createModelAgnosticFilesystemToolSet(
  options: AgentFilesystemToolsOptions = {},
): LlmToolSet {
  return createGeminiFilesystemToolSet(options);
}

export function createCodexApplyPatchTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof applyPatchInputSchema, string> {
  return tool({
    description: CODEX_APPLY_PATCH_JSON_TOOL_DESCRIPTION,
    inputSchema: applyPatchInputSchema,
    execute: async ({ input }) => {
      const runtime = resolveRuntime(options);
      const result = await applyPatch({
        patch: input,
        cwd: runtime.cwd,
        fs: runtime.filesystem,
        allowOutsideCwd: runtime.allowOutsideCwd,
        checkAccess: runtime.checkAccess
          ? async (context) => {
              await runtime.checkAccess?.({
                cwd: runtime.cwd,
                tool: "apply_patch",
                action: mapApplyPatchAction(context.kind),
                path: context.path,
                fromPath: context.fromPath,
                toPath: context.toPath,
              });
            }
          : undefined,
        maxPatchBytes: options.applyPatch?.maxPatchBytes,
      });
      return result.summary;
    },
  });
}

export function createCodexReadFileTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof codexReadFileInputSchema, string> {
  return tool({
    description:
      "Reads a local file with 1-indexed line numbers, supporting slice and indentation-aware block modes.",
    inputSchema: codexReadFileInputSchema,
    execute: async (input) => readFileCodex(input, options),
  });
}

export function createListDirTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof codexListDirInputSchema, string> {
  return tool({
    description:
      "Lists entries in a local directory with 1-indexed entry numbers and simple type labels.",
    inputSchema: codexListDirInputSchema,
    execute: async (input) => listDirectoryCodex(input, options),
  });
}

export function createGrepFilesTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof codexGrepFilesInputSchema, string> {
  return tool({
    description:
      "Finds files whose contents match the pattern and lists them by modification time.",
    inputSchema: codexGrepFilesInputSchema,
    execute: async (input) => grepFilesCodex(input, options),
  });
}

export function createReadFileTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof geminiReadFileInputSchema, string> {
  return tool({
    description: "Reads and returns content of a specified file.",
    inputSchema: geminiReadFileInputSchema,
    execute: async (input) => readFileGemini(input, options),
  });
}

export function createWriteFileTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof geminiWriteFileInputSchema, string> {
  return tool({
    description: "Writes content to a specified file in the local filesystem.",
    inputSchema: geminiWriteFileInputSchema,
    execute: async (input) => writeFileGemini(input, options),
  });
}

export function createReplaceTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof geminiReplaceInputSchema, string> {
  return tool({
    description: "Replaces exact literal text within a file.",
    inputSchema: geminiReplaceInputSchema,
    execute: async (input) => replaceFileContentGemini(input, options),
  });
}

export function createListDirectoryTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof geminiListDirectoryInputSchema, string> {
  return tool({
    description: "Lists files and subdirectories directly within a specified directory path.",
    inputSchema: geminiListDirectoryInputSchema,
    execute: async (input) => listDirectoryGemini(input, options),
  });
}

export function createGrepSearchTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof geminiGrepSearchInputSchema, string> {
  return tool({
    description: "Searches for a regex pattern within file contents.",
    inputSchema: geminiGrepSearchInputSchema,
    execute: async (input) => grepSearchGemini(input, options),
  });
}

export function createGlobTool(
  options: AgentFilesystemToolsOptions = {},
): LlmExecutableTool<typeof geminiGlobInputSchema, string> {
  return tool({
    description: "Finds files matching glob patterns, sorted by modification time (newest first).",
    inputSchema: geminiGlobInputSchema,
    execute: async (input) => globFilesGemini(input, options),
  });
}

async function readFileCodex(
  input: CodexReadFileToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  if (!path.isAbsolute(input.file_path)) {
    throw new Error("file_path must be an absolute path");
  }
  const filePath = resolvePathWithPolicy(input.file_path, runtime.cwd, runtime.allowOutsideCwd);
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "read_file",
    action: "read",
    path: filePath,
  });

  const content = await runtime.filesystem.readTextFile(filePath);
  const lines = splitLines(content);
  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_READ_FILE_LINE_LIMIT;
  const mode: CodexReadMode = input.mode ?? "slice";
  if (offset > lines.length) {
    throw new Error("offset exceeds file length");
  }

  if (mode === "slice") {
    const output: string[] = [];
    const lastLine = Math.min(lines.length, offset + limit - 1);
    for (let lineNumber = offset; lineNumber <= lastLine; lineNumber += 1) {
      const line = lines[lineNumber - 1] ?? "";
      output.push(`L${lineNumber}: ${truncateAtCodePointBoundary(line, runtime.maxLineLength)}`);
    }
    return output.join("\n");
  }

  const indentation = input.indentation ?? {};
  const anchorLine = indentation.anchor_line ?? offset;
  if (anchorLine < 1 || anchorLine > lines.length) {
    throw new Error("anchor_line exceeds file length");
  }
  const records = lines.map((line, index) => ({
    number: index + 1,
    raw: line,
    display: truncateAtCodePointBoundary(line, runtime.maxLineLength),
    indent: measureIndent(line, DEFAULT_TAB_WIDTH),
  }));

  const selected = readWithIndentationMode({
    records,
    anchorLine,
    limit,
    maxLevels: indentation.max_levels ?? 0,
    includeSiblings: indentation.include_siblings ?? false,
    includeHeader: indentation.include_header ?? true,
    maxLines: indentation.max_lines,
  });

  return selected.map((record) => `L${record.number}: ${record.display}`).join("\n");
}

async function listDirectoryCodex(
  input: CodexListDirToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  if (!path.isAbsolute(input.dir_path)) {
    throw new Error("dir_path must be an absolute path");
  }
  const dirPath = resolvePathWithPolicy(input.dir_path, runtime.cwd, runtime.allowOutsideCwd);
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "list_dir",
    action: "list",
    path: dirPath,
  });

  const stats = await runtime.filesystem.stat(dirPath);
  if (stats.kind !== "directory") {
    throw new Error(`failed to read directory: "${dirPath}" is not a directory`);
  }

  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_LIST_DIR_LIMIT;
  const depth = input.depth ?? DEFAULT_LIST_DIR_DEPTH;
  const entries = await collectDirectoryEntries(
    runtime.filesystem,
    dirPath,
    depth,
    runtime.maxLineLength,
  );
  if (offset > entries.length) {
    throw new Error("offset exceeds directory entry count");
  }

  const startIndex = offset - 1;
  const remaining = entries.length - startIndex;
  const cappedLimit = Math.min(limit, remaining);
  const selected = entries.slice(startIndex, startIndex + cappedLimit);

  const output: string[] = [`Absolute path: ${dirPath}`];
  for (const entry of selected) {
    output.push(formatListEntry(entry));
  }
  if (startIndex + cappedLimit < entries.length) {
    output.push(`More than ${cappedLimit} entries found`);
  }

  return output.join("\n");
}

async function grepFilesCodex(
  input: CodexGrepFilesToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const pattern = input.pattern.trim();
  if (pattern.length === 0) {
    throw new Error("pattern must not be empty");
  }
  const regex = compileRegex(pattern);
  const searchPath = resolvePathWithPolicy(
    input.path ?? runtime.cwd,
    runtime.cwd,
    runtime.allowOutsideCwd,
  );
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "grep_files",
    action: "search",
    path: searchPath,
    pattern,
    include: input.include?.trim(),
  });

  const searchPathInfo = await runtime.filesystem.stat(searchPath);
  const filesToScan = await collectSearchFiles({
    filesystem: runtime.filesystem,
    searchPath,
    rootKind: searchPathInfo.kind,
    maxScannedFiles: runtime.grepMaxScannedFiles,
  });

  const includeMatcher = input.include ? createGlobMatcher(input.include) : null;
  const matches: GrepMatchRecord[] = [];
  for (const filePath of filesToScan) {
    const relativePath = toDisplayPath(filePath, runtime.cwd);
    if (includeMatcher && !includeMatcher(relativePath)) {
      continue;
    }
    const fileContent = await runtime.filesystem.readTextFile(filePath);
    if (!regex.test(fileContent)) {
      continue;
    }
    const stats = await runtime.filesystem.stat(filePath);
    matches.push({ filePath: normalizeSlashes(relativePath), mtimeMs: stats.mtimeMs });
  }

  if (matches.length === 0) {
    return "No matches found.";
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const limit = Math.min(input.limit ?? DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
  return matches
    .slice(0, limit)
    .map((match) => match.filePath)
    .join("\n");
}

async function readFileGemini(
  input: GeminiReadFileToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const filePath = resolvePathWithPolicy(input.file_path, runtime.cwd, runtime.allowOutsideCwd);
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "read_file",
    action: "read",
    path: filePath,
  });
  const content = await runtime.filesystem.readTextFile(filePath);

  if (input.offset === undefined && input.limit === undefined) {
    return content;
  }

  const lines = splitLines(content);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = input.limit ?? DEFAULT_READ_FILE_LINE_LIMIT;
  if (offset >= lines.length) {
    return "";
  }
  const end = Math.min(lines.length, offset + limit);
  return lines.slice(offset, end).join("\n");
}

async function writeFileGemini(
  input: GeminiWriteFileToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const filePath = resolvePathWithPolicy(input.file_path, runtime.cwd, runtime.allowOutsideCwd);
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "write_file",
    action: "write",
    path: filePath,
  });
  await runtime.filesystem.ensureDir(path.dirname(filePath));
  await runtime.filesystem.writeTextFile(filePath, input.content);
  return `Successfully wrote file: ${toDisplayPath(filePath, runtime.cwd)}`;
}

async function replaceFileContentGemini(
  input: GeminiReplaceToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const filePath = resolvePathWithPolicy(input.file_path, runtime.cwd, runtime.allowOutsideCwd);
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "replace",
    action: "write",
    path: filePath,
  });

  const expectedReplacements = input.expected_replacements ?? 1;
  const oldValue = input.old_string;
  const newValue = input.new_string;

  let originalContent = "";
  try {
    originalContent = await runtime.filesystem.readTextFile(filePath);
  } catch (error) {
    if (isNoEntError(error) && oldValue.length === 0) {
      await runtime.filesystem.ensureDir(path.dirname(filePath));
      await runtime.filesystem.writeTextFile(filePath, newValue);
      return `Successfully wrote new file: ${toDisplayPath(filePath, runtime.cwd)}`;
    }
    throw error;
  }

  if (oldValue === newValue) {
    throw new Error("No changes to apply. old_string and new_string are identical.");
  }

  const occurrences = countOccurrences(originalContent, oldValue);
  if (occurrences === 0) {
    throw new Error("Failed to edit, could not find old_string in file.");
  }
  if (occurrences !== expectedReplacements) {
    throw new Error(
      `Failed to edit, expected ${expectedReplacements} occurrence(s) but found ${occurrences}.`,
    );
  }
  const updatedContent = safeReplaceAll(originalContent, oldValue, newValue);
  await runtime.filesystem.writeTextFile(filePath, updatedContent);
  return `Successfully replaced ${occurrences} occurrence(s) in ${toDisplayPath(filePath, runtime.cwd)}.`;
}

async function listDirectoryGemini(
  input: GeminiListDirectoryToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const dirPath = resolvePathWithPolicy(input.dir_path, runtime.cwd, runtime.allowOutsideCwd);
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "list_directory",
    action: "list",
    path: dirPath,
  });

  const stats = await runtime.filesystem.stat(dirPath);
  if (stats.kind !== "directory") {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  const entries = await runtime.filesystem.readDir(dirPath);
  const ignoreMatchers = (input.ignore ?? []).map((pattern) => createGlobMatcher(pattern));
  const filtered = entries
    .filter((entry) => {
      if (ignoreMatchers.length === 0) {
        return true;
      }
      return !ignoreMatchers.some((matches) => matches(entry.name));
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  if (filtered.length === 0) {
    return `Directory ${toDisplayPath(dirPath, runtime.cwd)} is empty.`;
  }

  return filtered
    .map((entry) => {
      const label = entry.kind === "directory" ? `${entry.name}/` : entry.name;
      return label;
    })
    .join("\n");
}

async function grepSearchGemini(
  input: GeminiGrepSearchToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const pattern = input.pattern.trim();
  if (pattern.length === 0) {
    throw new Error("pattern must not be empty");
  }

  const include = input.include?.trim();
  const searchPath = resolvePathWithPolicy(
    input.dir_path ?? runtime.cwd,
    runtime.cwd,
    runtime.allowOutsideCwd,
  );
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "grep_search",
    action: "search",
    path: searchPath,
    pattern,
    include,
  });

  const searchPathInfo = await runtime.filesystem.stat(searchPath);
  const filesToScan = await collectSearchFiles({
    filesystem: runtime.filesystem,
    searchPath,
    rootKind: searchPathInfo.kind,
    maxScannedFiles: runtime.grepMaxScannedFiles,
  });

  const matcher = include ? createGlobMatcher(include) : null;
  const patternRegex = compileRegex(pattern);
  const excludeRegex = input.exclude_pattern ? compileRegex(input.exclude_pattern) : null;
  const totalMaxMatches = input.total_max_matches ?? DEFAULT_GREP_LIMIT;
  const perFileMaxMatches = input.max_matches_per_file ?? Number.POSITIVE_INFINITY;

  const matches: GrepMatchRecord[] = [];
  const fileMatches = new Set<string>();
  for (const filePath of filesToScan) {
    const relativePath = normalizeSlashes(toDisplayPath(filePath, runtime.cwd));
    if (matcher && !matcher(relativePath)) {
      continue;
    }

    const content = await runtime.filesystem.readTextFile(filePath);
    const lines = splitLines(content);
    let fileMatchCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!patternRegex.test(line)) {
        continue;
      }
      if (excludeRegex?.test(line)) {
        continue;
      }
      if (fileMatches.has(relativePath) === false) {
        fileMatches.add(relativePath);
      }
      if (input.names_only) {
        continue;
      }
      matches.push({
        filePath: relativePath,
        mtimeMs: 0,
        lineNumber: index + 1,
        line: line,
      });
      fileMatchCount += 1;
      if (fileMatchCount >= perFileMaxMatches || matches.length >= totalMaxMatches) {
        break;
      }
    }

    if (input.names_only && fileMatches.size >= totalMaxMatches) {
      break;
    }
    if (!input.names_only && matches.length >= totalMaxMatches) {
      break;
    }
  }

  if (input.names_only) {
    if (fileMatches.size === 0) {
      return "No matches found.";
    }
    return [...fileMatches].slice(0, totalMaxMatches).join("\n");
  }

  if (matches.length === 0) {
    return "No matches found.";
  }

  return matches
    .slice(0, totalMaxMatches)
    .map((match) => `${match.filePath}:${match.lineNumber}:${match.line ?? ""}`)
    .join("\n");
}

async function globFilesGemini(
  input: GeminiGlobToolInput,
  options: AgentFilesystemToolsOptions,
): Promise<string> {
  const runtime = resolveRuntime(options);
  const dirPath = resolvePathWithPolicy(
    input.dir_path ?? runtime.cwd,
    runtime.cwd,
    runtime.allowOutsideCwd,
  );
  await runAccessHook(runtime, {
    cwd: runtime.cwd,
    tool: "glob",
    action: "search",
    path: dirPath,
    pattern: input.pattern,
  });

  const dirStats = await runtime.filesystem.stat(dirPath);
  if (dirStats.kind !== "directory") {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  const matcher = createGlobMatcher(input.pattern, input.case_sensitive === true);
  const files = await collectSearchFiles({
    filesystem: runtime.filesystem,
    searchPath: dirPath,
    rootKind: "directory",
    maxScannedFiles: runtime.grepMaxScannedFiles,
  });

  const matched: GrepMatchRecord[] = [];
  for (const filePath of files) {
    const relativePath = normalizeSlashes(path.relative(dirPath, filePath));
    if (!matcher(relativePath)) {
      continue;
    }
    const fileStats = await runtime.filesystem.stat(filePath);
    matched.push({
      filePath,
      mtimeMs: fileStats.mtimeMs,
    });
  }

  if (matched.length === 0) {
    return "No files found.";
  }

  matched.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matched.map((entry) => normalizeSlashes(path.resolve(entry.filePath))).join("\n");
}

type RuntimeContext = {
  readonly cwd: string;
  readonly filesystem: AgentFilesystem;
  readonly allowOutsideCwd: boolean;
  readonly checkAccess?: AgentFilesystemToolAccessHook;
  readonly maxLineLength: number;
  readonly grepMaxScannedFiles: number;
};

function resolveRuntime(options: AgentFilesystemToolsOptions): RuntimeContext {
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    filesystem: options.fs ?? createNodeAgentFilesystem(),
    allowOutsideCwd: options.allowOutsideCwd === true,
    checkAccess: options.checkAccess,
    maxLineLength: options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH,
    grepMaxScannedFiles: options.grepMaxScannedFiles ?? DEFAULT_GREP_MAX_SCANNED_FILES,
  };
}

async function runAccessHook(
  runtime: RuntimeContext,
  context: AgentFilesystemToolAccessContext,
): Promise<void> {
  if (!runtime.checkAccess) {
    return;
  }
  await runtime.checkAccess(context);
}

function isCodexModel(model: string): boolean {
  const normalized = model.startsWith("chatgpt-") ? model.slice("chatgpt-".length) : model;
  return normalized.includes("codex");
}

function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini-");
}

function mapApplyPatchAction(
  action: "add" | "delete" | "update" | "move",
): AgentFilesystemToolAction {
  if (action === "add" || action === "update") {
    return "write";
  }
  if (action === "delete") {
    return "delete";
  }
  return "move";
}

function resolvePathWithPolicy(inputPath: string, cwd: string, allowOutsideCwd: boolean): string {
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(cwd, inputPath);
  if (!allowOutsideCwd && !isPathInsideCwd(absolutePath, cwd)) {
    throw new Error(`path "${inputPath}" resolves outside cwd "${cwd}"`);
  }
  return absolutePath;
}

function isPathInsideCwd(candidatePath: string, cwd: string): boolean {
  const relative = path.relative(cwd, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toDisplayPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (relative === "") {
    return ".";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return absolutePath;
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function truncateAtCodePointBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return Array.from(value).slice(0, maxLength).join("");
}

function measureIndent(line: string, tabWidth: number): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") {
      count += 1;
      continue;
    }
    if (char === "\t") {
      count += tabWidth;
      continue;
    }
    break;
  }
  return count;
}

function computeEffectiveIndents(records: readonly ReadLineRecord[]): number[] {
  const effective: number[] = [];
  let previous = 0;
  for (const record of records) {
    if (record.raw.trim().length === 0) {
      effective.push(previous);
    } else {
      previous = record.indent;
      effective.push(previous);
    }
  }
  return effective;
}

function trimBoundaryBlankLines(records: ReadLineRecord[]): void {
  while (records.length > 0 && records[0]?.raw.trim().length === 0) {
    records.shift();
  }
  while (records.length > 0 && records[records.length - 1]?.raw.trim().length === 0) {
    records.pop();
  }
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("--");
}

function readWithIndentationMode(params: {
  records: readonly ReadLineRecord[];
  anchorLine: number;
  limit: number;
  maxLevels: number;
  includeSiblings: boolean;
  includeHeader: boolean;
  maxLines?: number;
}): ReadLineRecord[] {
  const { records, anchorLine, limit, maxLevels, includeSiblings, includeHeader, maxLines } =
    params;
  const anchorIndex = anchorLine - 1;
  const effectiveIndents = computeEffectiveIndents(records);
  const anchorIndent = effectiveIndents[anchorIndex] ?? 0;
  const minIndent = maxLevels === 0 ? 0 : Math.max(anchorIndent - maxLevels * DEFAULT_TAB_WIDTH, 0);
  const guardLimit = maxLines ?? limit;
  const finalLimit = Math.min(limit, guardLimit, records.length);
  if (finalLimit <= 1) {
    return [records[anchorIndex]].filter((entry): entry is ReadLineRecord => Boolean(entry));
  }

  let upper = anchorIndex - 1;
  let lower = anchorIndex + 1;
  let upperMinIndentHits = 0;
  let lowerMinIndentHits = 0;
  const output: ReadLineRecord[] = [records[anchorIndex]].filter((entry): entry is ReadLineRecord =>
    Boolean(entry),
  );

  while (output.length < finalLimit) {
    let progressed = 0;

    if (upper >= 0) {
      const candidate = records[upper];
      const candidateIndent = effectiveIndents[upper] ?? 0;
      if (candidate && candidateIndent >= minIndent) {
        output.unshift(candidate);
        progressed += 1;
        upper -= 1;
        if (candidateIndent === minIndent && !includeSiblings) {
          const allowHeaderComment = includeHeader && isCommentLine(candidate.raw);
          const canTakeLine = allowHeaderComment || upperMinIndentHits === 0;
          if (canTakeLine) {
            upperMinIndentHits += 1;
          } else {
            output.shift();
            progressed -= 1;
            upper = -1;
          }
        }
        if (output.length >= finalLimit) {
          break;
        }
      } else {
        upper = -1;
      }
    }

    if (lower < records.length) {
      const candidate = records[lower];
      const candidateIndent = effectiveIndents[lower] ?? 0;
      if (candidate && candidateIndent >= minIndent) {
        output.push(candidate);
        progressed += 1;
        lower += 1;
        if (candidateIndent === minIndent && !includeSiblings) {
          if (lowerMinIndentHits > 0) {
            output.pop();
            progressed -= 1;
            lower = records.length;
          }
          lowerMinIndentHits += 1;
        }
      } else {
        lower = records.length;
      }
    }

    if (progressed === 0) {
      break;
    }
  }

  trimBoundaryBlankLines(output);
  return output;
}

async function collectDirectoryEntries(
  filesystem: AgentFilesystem,
  rootPath: string,
  depth: number,
  maxLineLength: number,
): Promise<ListEntryRecord[]> {
  const queue: Array<{ path: string; relativePrefix: string; remainingDepth: number }> = [
    { path: rootPath, relativePrefix: "", remainingDepth: depth },
  ];
  const records: ListEntryRecord[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    const entries = await filesystem.readDir(next.path);
    const nextEntries = [...entries]
      .map((entry) => {
        const relativePath = next.relativePrefix
          ? `${next.relativePrefix}/${entry.name}`
          : entry.name;
        return {
          entry,
          relativePath,
          depth: next.relativePrefix.length === 0 ? 0 : next.relativePrefix.split("/").length,
          sortName: normalizeSlashes(relativePath),
        };
      })
      .sort((left, right) => left.sortName.localeCompare(right.sortName));

    for (const item of nextEntries) {
      if (item.entry.kind === "directory" && next.remainingDepth > 1) {
        queue.push({
          path: item.entry.path,
          relativePrefix: item.relativePath,
          remainingDepth: next.remainingDepth - 1,
        });
      }
      records.push({
        name: item.sortName,
        displayName: truncateAtCodePointBoundary(item.entry.name, maxLineLength),
        depth: item.depth,
        kind: item.entry.kind,
      });
    }
  }

  records.sort((left, right) => left.name.localeCompare(right.name));
  return records;
}

function formatListEntry(entry: ListEntryRecord): string {
  const indent = " ".repeat(entry.depth * 2);
  let name = entry.displayName;
  if (entry.kind === "directory") {
    name += "/";
  } else if (entry.kind === "symlink") {
    name += "@";
  } else if (entry.kind === "other") {
    name += "?";
  }
  return `${indent}${name}`;
}

async function collectSearchFiles(params: {
  filesystem: AgentFilesystem;
  searchPath: string;
  rootKind: AgentDirectoryEntry["kind"];
  maxScannedFiles: number;
}): Promise<string[]> {
  const { filesystem, searchPath, rootKind, maxScannedFiles } = params;
  if (rootKind === "file") {
    return [searchPath];
  }

  const queue: string[] = [searchPath];
  const files: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const entries = await filesystem.readDir(current);
    for (const entry of entries) {
      if (entry.kind === "directory") {
        queue.push(entry.path);
        continue;
      }
      if (entry.kind !== "file") {
        continue;
      }
      files.push(entry.path);
      if (files.length >= maxScannedFiles) {
        return files;
      }
    }
  }
  return files;
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "m");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid regex pattern: ${message}`);
  }
}

function createGlobMatcher(
  pattern: string,
  caseSensitive = false,
): (candidatePath: string) => boolean {
  const expanded = expandBracePatterns(normalizeSlashes(pattern.trim()));
  const flags = caseSensitive ? "" : "i";
  const compiled = expanded.map((entry) => ({
    regex: globToRegex(entry, flags),
    applyToBasename: !entry.includes("/"),
  }));

  return (candidatePath: string) => {
    const normalizedPath = normalizeSlashes(candidatePath);
    const basename = path.posix.basename(normalizedPath);
    return compiled.some((entry) =>
      entry.regex.test(entry.applyToBasename ? basename : normalizedPath),
    );
  };
}

function globToRegex(globPattern: string, flags: string): RegExp {
  let source = "^";
  for (let index = 0; index < globPattern.length; index += 1) {
    const char = globPattern[index];
    const nextChar = globPattern[index + 1];

    if (char === undefined) {
      continue;
    }
    if (char === "*" && nextChar === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegexCharacter(char);
  }
  source += "$";
  return new RegExp(source, flags);
}

function expandBracePatterns(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) {
    return [pattern];
  }

  let depth = 0;
  let end = -1;
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }

  if (end === -1) {
    return [pattern];
  }

  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const body = pattern.slice(start + 1, end);
  const variants = splitTopLevel(body, ",");
  const expanded: string[] = [];
  for (const variant of variants) {
    expanded.push(...expandBracePatterns(`${prefix}${variant}${suffix}`));
  }
  return expanded;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function escapeRegexCharacter(char: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }
  return text.split(search).length - 1;
}

function safeReplaceAll(text: string, search: string, replacement: string): string {
  if (search.length === 0) {
    return text;
  }
  return text.split(search).join(replacement);
}

function isNoEntError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
