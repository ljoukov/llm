import path from "node:path";

import { z } from "zod";

import { type LlmExecutableTool, tool } from "../llm.js";
import { createNodeAgentFilesystem, type AgentFilesystem } from "./filesystem.js";

const BEGIN_PATCH_LINE = "*** Begin Patch";
const END_PATCH_LINE = "*** End Patch";
const ADD_FILE_PREFIX = "*** Add File: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to: ";
const END_OF_FILE_LINE = "*** End of File";
const DEFAULT_MAX_PATCH_BYTES = 1024 * 1024;

type ParsedPatch = {
  readonly operations: readonly ParsedPatchOperation[];
};

type ParsedPatchOperation =
  | {
      readonly type: "add";
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly type: "delete";
      readonly path: string;
    }
  | {
      readonly type: "update";
      readonly path: string;
      readonly movePath?: string;
      readonly chunks: readonly ParsedUpdateChunk[];
    };

type ParsedUpdateChunk = {
  readonly contextSelector?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly isEndOfFile: boolean;
};

type Replacement = {
  readonly startIndex: number;
  readonly oldLength: number;
  readonly newLines: readonly string[];
};

export type ApplyPatchAccessContext = {
  readonly cwd: string;
  readonly kind: "add" | "delete" | "update" | "move";
  readonly path: string;
  readonly fromPath?: string;
  readonly toPath?: string;
};

export type ApplyPatchAccessHook = (context: ApplyPatchAccessContext) => Promise<void> | void;

export type ApplyPatchRequest = {
  readonly patch: string;
  readonly cwd?: string;
  readonly fs?: AgentFilesystem;
  readonly allowOutsideCwd?: boolean;
  readonly checkAccess?: ApplyPatchAccessHook;
  readonly maxPatchBytes?: number;
};

export type ApplyPatchResult = {
  readonly success: true;
  readonly summary: string;
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
};

export type CreateApplyPatchToolOptions = Omit<ApplyPatchRequest, "patch"> & {
  readonly description?: string;
};

const applyPatchToolInputSchema = z.object({
  input: z.string().min(1).describe("The entire apply_patch payload, including Begin/End markers."),
});

export type ApplyPatchToolInput = z.output<typeof applyPatchToolInputSchema>;

export function createApplyPatchTool(
  options: CreateApplyPatchToolOptions = {},
): LlmExecutableTool<typeof applyPatchToolInputSchema, ApplyPatchResult> {
  return tool({
    description:
      options.description ??
      "Apply edits using a Codex-style apply_patch payload with Begin/End markers.",
    inputSchema: applyPatchToolInputSchema,
    execute: async ({ input }) =>
      applyPatch({
        patch: input,
        cwd: options.cwd,
        fs: options.fs,
        allowOutsideCwd: options.allowOutsideCwd,
        checkAccess: options.checkAccess,
        maxPatchBytes: options.maxPatchBytes,
      }),
  });
}

export async function applyPatch(request: ApplyPatchRequest): Promise<ApplyPatchResult> {
  const cwd = path.resolve(request.cwd ?? process.cwd());
  const adapter = request.fs ?? createNodeAgentFilesystem();
  const allowOutsideCwd = request.allowOutsideCwd === true;
  const patchBytes = Buffer.byteLength(request.patch, "utf8");
  const maxPatchBytes = request.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  if (patchBytes > maxPatchBytes) {
    throw new Error(
      `apply_patch failed: patch too large (${patchBytes} bytes > ${maxPatchBytes} bytes)`,
    );
  }

  const parsed = parsePatchDocument(normalizePatchText(request.patch));

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const operation of parsed.operations) {
    if (operation.type === "add") {
      const absolutePath = resolvePatchPath(operation.path, cwd, allowOutsideCwd);
      await runAccessHook(request.checkAccess, {
        cwd,
        kind: "add",
        path: absolutePath,
      });
      await adapter.ensureDir(path.dirname(absolutePath));
      await adapter.writeTextFile(absolutePath, operation.content);
      added.push(toDisplayPath(absolutePath, cwd));
      continue;
    }

    if (operation.type === "delete") {
      const absolutePath = resolvePatchPath(operation.path, cwd, allowOutsideCwd);
      await runAccessHook(request.checkAccess, {
        cwd,
        kind: "delete",
        path: absolutePath,
      });
      await adapter.readTextFile(absolutePath);
      await adapter.deleteFile(absolutePath);
      deleted.push(toDisplayPath(absolutePath, cwd));
      continue;
    }

    const absolutePath = resolvePatchPath(operation.path, cwd, allowOutsideCwd);
    await runAccessHook(request.checkAccess, {
      cwd,
      kind: "update",
      path: absolutePath,
    });
    const current = await adapter.readTextFile(absolutePath);
    const next = deriveUpdatedContent(current, operation.chunks, toDisplayPath(absolutePath, cwd));

    if (operation.movePath) {
      const destinationPath = resolvePatchPath(operation.movePath, cwd, allowOutsideCwd);
      await runAccessHook(request.checkAccess, {
        cwd,
        kind: "move",
        path: destinationPath,
        fromPath: absolutePath,
        toPath: destinationPath,
      });
      await adapter.ensureDir(path.dirname(destinationPath));
      await adapter.writeTextFile(destinationPath, next);
      await adapter.deleteFile(absolutePath);
      modified.push(toDisplayPath(destinationPath, cwd));
      continue;
    }

    await adapter.writeTextFile(absolutePath, next);
    modified.push(toDisplayPath(absolutePath, cwd));
  }

  return {
    success: true,
    summary: formatSummary(added, modified, deleted),
    added,
    modified,
    deleted,
  };
}

async function runAccessHook(
  hook: ApplyPatchAccessHook | undefined,
  context: ApplyPatchAccessContext,
): Promise<void> {
  if (!hook) {
    return;
  }
  await hook(context);
}

function normalizePatchText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function resolvePatchPath(rawPath: string, cwd: string, allowOutsideCwd: boolean): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error("apply_patch failed: empty file path");
  }
  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(cwd, trimmed);
  if (!allowOutsideCwd && !isPathInsideCwd(absolutePath, cwd)) {
    throw new Error(`apply_patch failed: path "${trimmed}" resolves outside cwd "${cwd}"`);
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

function parsePatchDocument(patch: string): ParsedPatch {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length < 2) {
    throw new Error("apply_patch failed: patch must contain Begin/End markers");
  }
  if (lines[0] !== BEGIN_PATCH_LINE) {
    throw new Error(`apply_patch failed: missing "${BEGIN_PATCH_LINE}" header`);
  }
  if (lines[lines.length - 1] !== END_PATCH_LINE) {
    throw new Error(`apply_patch failed: missing "${END_PATCH_LINE}" footer`);
  }

  const body = lines.slice(1, -1);
  if (body.length === 0) {
    throw new Error("apply_patch failed: patch body is empty");
  }

  const operations: ParsedPatchOperation[] = [];
  let index = 0;
  while (index < body.length) {
    const line = body[index];
    if (!line) {
      throw new Error("apply_patch failed: unexpected empty line between file sections");
    }

    if (line.startsWith(ADD_FILE_PREFIX)) {
      const filePath = extractPatchPath(line, ADD_FILE_PREFIX);
      index += 1;
      const contentLines: string[] = [];
      while (index < body.length) {
        const contentLine = body[index];
        if (contentLine === undefined || isPatchSectionHeader(contentLine)) {
          break;
        }
        if (!contentLine.startsWith("+")) {
          throw new Error(`apply_patch failed: invalid add-file line "${contentLine}"`);
        }
        contentLines.push(contentLine.slice(1));
        index += 1;
      }
      if (contentLines.length === 0) {
        throw new Error(`apply_patch failed: add-file section for "${filePath}" is empty`);
      }
      operations.push({
        type: "add",
        path: filePath,
        content: `${contentLines.join("\n")}\n`,
      });
      continue;
    }

    if (line.startsWith(DELETE_FILE_PREFIX)) {
      operations.push({
        type: "delete",
        path: extractPatchPath(line, DELETE_FILE_PREFIX),
      });
      index += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const filePath = extractPatchPath(line, UPDATE_FILE_PREFIX);
      index += 1;

      let movePath: string | undefined;
      const moveHeader = body[index];
      if (moveHeader?.startsWith(MOVE_TO_PREFIX)) {
        movePath = extractPatchPath(moveHeader, MOVE_TO_PREFIX);
        index += 1;
      }

      const chunks: ParsedUpdateChunk[] = [];
      while (index < body.length) {
        const hunkHeader = body[index];
        if (hunkHeader === undefined || isPatchSectionHeader(hunkHeader)) {
          break;
        }
        if (!(hunkHeader === "@@" || hunkHeader.startsWith("@@ "))) {
          throw new Error(
            `apply_patch failed: expected hunk marker in "${filePath}", got "${hunkHeader}"`,
          );
        }
        const contextSelector = hunkHeader.length > 2 ? hunkHeader.slice(3) : undefined;
        index += 1;

        const oldLines: string[] = [];
        const newLines: string[] = [];
        let sawBodyLine = false;
        let sawChangeLine = false;
        let isEndOfFile = false;

        while (index < body.length) {
          const chunkLine = body[index];
          if (chunkLine === undefined) {
            break;
          }
          if (
            chunkLine === "@@" ||
            chunkLine.startsWith("@@ ") ||
            isPatchSectionHeader(chunkLine)
          ) {
            break;
          }
          if (chunkLine === END_OF_FILE_LINE) {
            isEndOfFile = true;
            index += 1;
            break;
          }
          if (chunkLine.length === 0) {
            throw new Error(`apply_patch failed: invalid empty hunk line in "${filePath}"`);
          }

          const prefix = chunkLine[0];
          const content = chunkLine.slice(1);
          if (prefix === " ") {
            oldLines.push(content);
            newLines.push(content);
          } else if (prefix === "-") {
            oldLines.push(content);
            sawChangeLine = true;
          } else if (prefix === "+") {
            newLines.push(content);
            sawChangeLine = true;
          } else {
            throw new Error(
              `apply_patch failed: unsupported hunk prefix "${prefix}" in "${chunkLine}"`,
            );
          }

          sawBodyLine = true;
          index += 1;
        }

        if (!sawBodyLine) {
          throw new Error(`apply_patch failed: empty hunk body in "${filePath}"`);
        }
        if (!sawChangeLine) {
          throw new Error(
            `apply_patch failed: hunk in "${filePath}" must include '+' or '-' lines`,
          );
        }

        chunks.push({
          contextSelector,
          oldLines,
          newLines,
          isEndOfFile,
        });
      }

      if (chunks.length === 0) {
        throw new Error(`apply_patch failed: update section for "${filePath}" has no hunks`);
      }

      operations.push({
        type: "update",
        path: filePath,
        movePath,
        chunks,
      });
      continue;
    }

    throw new Error(`apply_patch failed: unrecognized section header "${line}"`);
  }

  return { operations };
}

function extractPatchPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (value.length === 0) {
    throw new Error(`apply_patch failed: missing file path in "${line}"`);
  }
  return value;
}

function isPatchSectionHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE_PREFIX) ||
    line.startsWith(DELETE_FILE_PREFIX) ||
    line.startsWith(UPDATE_FILE_PREFIX)
  );
}

function deriveUpdatedContent(
  originalContent: string,
  chunks: readonly ParsedUpdateChunk[],
  displayPath: string,
): string {
  const originalLines = splitFileContentIntoLines(originalContent);
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.contextSelector !== undefined) {
      const contextIndex = seekSequence(originalLines, [chunk.contextSelector], lineIndex, false);
      if (contextIndex === null) {
        throw new Error(
          `apply_patch failed: unable to locate context "${chunk.contextSelector}" in ${displayPath}`,
        );
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({
        startIndex: originalLines.length,
        oldLength: 0,
        newLines: [...chunk.newLines],
      });
      continue;
    }

    let oldLines = [...chunk.oldLines];
    let newLines = [...chunk.newLines];
    let startIndex = seekSequence(originalLines, oldLines, lineIndex, chunk.isEndOfFile);

    if (startIndex === null && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") {
        newLines = newLines.slice(0, -1);
      }
      startIndex = seekSequence(originalLines, oldLines, lineIndex, chunk.isEndOfFile);
    }

    if (startIndex === null) {
      throw new Error(
        `apply_patch failed: failed to match hunk in ${displayPath}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push({
      startIndex,
      oldLength: oldLines.length,
      newLines,
    });
    lineIndex = startIndex + oldLines.length;
  }

  replacements.sort((left, right) => left.startIndex - right.startIndex);
  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }
  return nextLines.join("\n");
}

function splitFileContentIntoLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function seekSequence(
  sourceLines: readonly string[],
  targetLines: readonly string[],
  startIndex: number,
  isEndOfFile: boolean,
): number | null {
  if (targetLines.length === 0) {
    return Math.min(Math.max(startIndex, 0), sourceLines.length);
  }
  const from = Math.max(startIndex, 0);
  const maxStart = sourceLines.length - targetLines.length;
  if (maxStart < from) {
    return null;
  }

  const matchesAt = (candidateIndex: number): boolean => {
    for (let offset = 0; offset < targetLines.length; offset += 1) {
      if (sourceLines[candidateIndex + offset] !== targetLines[offset]) {
        return false;
      }
    }
    return true;
  };

  if (isEndOfFile) {
    return matchesAt(maxStart) ? maxStart : null;
  }

  for (let candidate = from; candidate <= maxStart; candidate += 1) {
    if (matchesAt(candidate)) {
      return candidate;
    }
  }
  return null;
}

function applyReplacements(
  lines: readonly string[],
  replacements: readonly Replacement[],
): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (replacement === undefined) {
      continue;
    }
    result.splice(replacement.startIndex, replacement.oldLength, ...replacement.newLines);
  }
  return result;
}

function formatSummary(
  added: readonly string[],
  modified: readonly string[],
  deleted: readonly string[],
): string {
  const lines = ["Success. Updated the following files:"];
  for (const filePath of added) {
    lines.push(`A ${filePath}`);
  }
  for (const filePath of modified) {
    lines.push(`M ${filePath}`);
  }
  for (const filePath of deleted) {
    lines.push(`D ${filePath}`);
  }
  return `${lines.join("\n")}\n`;
}
