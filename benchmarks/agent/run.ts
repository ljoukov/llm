import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { estimateCallCostUsd, generateJson } from "../../src/index.js";
import { MICRO_TASKS, type MicroTask } from "./tasks.js";

type BenchmarkVariant = "replace" | "patch" | "hashline" | "apply_patch";
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

const BENCHMARK_VARIANTS: readonly BenchmarkVariant[] = [
  "replace",
  "patch",
  "hashline",
  "apply_patch",
];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const DEFAULT_MODEL = "chatgpt-gpt-5.3-codex";

const ReplaceSchema = z.object({
  replacements: z
    .array(
      z.object({
        oldText: z.string().min(1),
        newText: z.string(),
      }),
    )
    .min(1)
    .max(8),
});

const PatchSchema = z.object({
  patches: z
    .array(
      z.object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        replacement: z.string(),
      }),
    )
    .min(1)
    .max(8),
});

const HashlineSchema = z.object({
  edits: z
    .array(
      z.object({
        anchor: z.string().regex(/^\d+:[0-9a-f]{2}$/),
        newText: z.string(),
      }),
    )
    .min(1)
    .max(8),
});

const ApplyPatchSchema = z.object({
  patch: z.string().min(1),
});

type ReplacePlan = z.infer<typeof ReplaceSchema>;
type PatchPlan = z.infer<typeof PatchSchema>;
type HashlinePlan = z.infer<typeof HashlineSchema>;
type ApplyPatchPlan = z.infer<typeof ApplyPatchSchema>;

type CaseResult = {
  readonly taskId: string;
  readonly variant: BenchmarkVariant;
  readonly runIndex: number;
  readonly success: boolean;
  readonly durationMs: number;
  readonly promptTokens?: number;
  readonly responseTokens?: number;
  readonly thinkingTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd: number;
  readonly modelVersion?: string;
  readonly error?: string;
};

type Projection = {
  readonly cases: number;
  readonly perCallUsd: number;
  readonly totalUsd: number;
  readonly promptTokensPerCall: number;
  readonly responseTokensPerCall: number;
};

type VariantSummary = {
  readonly variant: BenchmarkVariant;
  readonly cases: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly avgDurationMs: number;
  readonly avgCostUsd: number;
  readonly promptTokens: number;
  readonly responseTokens: number;
  readonly thinkingTokens: number;
  readonly totalTokens: number;
};

function printUsage(): void {
  console.log(`
Micro edit benchmark for coding-agent style tasks.

Usage:
  npx tsx benchmarks/agent/run.ts [options]

Options:
  --model <id>                      Model ID (default: ${DEFAULT_MODEL})
  --variants <list>                 Comma-separated: replace,patch,hashline,apply_patch
  --tasks <list>                    Comma-separated task ids (default: first max-tasks)
  --max-tasks <n>                   Max tasks when --tasks is omitted (default: 4)
  --runs <n>                        Runs per task/variant (default: 1)
  --reasoning <level>               low, medium, high, xhigh (default: low)
  --estimate-prompt-tokens <n>      Cost projection prompt tokens/call (default: 1200)
  --estimate-response-tokens <n>    Cost projection response tokens/call (default: 300)
  --estimate-only                   Print expected cost and exit
  --out-dir <path>                  Output directory (default: benchmarks/agent/results)
  --help                            Show this help
`);
}

function asNonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function parsePositiveInt(raw: string, optionName: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${optionName}: ${raw}`);
  }
  return parsed;
}

function parseReasoningEffort(raw: string): ReasoningEffort {
  if ((REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return raw as ReasoningEffort;
  }
  throw new Error(`Invalid --reasoning value: ${raw}`);
}

function parseVariants(raw: string): readonly BenchmarkVariant[] {
  const selected = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is BenchmarkVariant =>
      (BENCHMARK_VARIANTS as readonly string[]).includes(value),
    );

  const deduped = [...new Set(selected)];
  if (deduped.length === 0) {
    throw new Error(`No valid variants in --variants=${raw}`);
  }
  return deduped;
}

function selectTasks(taskArg: string | undefined, maxTasks: number): readonly MicroTask[] {
  if (taskArg) {
    const ids = taskArg
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (ids.length === 0) {
      throw new Error("--tasks was provided but no task ids were found.");
    }
    const byId = new Map(MICRO_TASKS.map((task) => [task.id, task]));
    const selected: MicroTask[] = [];
    for (const id of ids) {
      const task = byId.get(id);
      if (!task) {
        throw new Error(`Unknown task id: ${id}`);
      }
      selected.push(task);
    }
    return selected;
  }
  return MICRO_TASKS.slice(0, maxTasks);
}

function estimateProjection(params: {
  model: string;
  taskCount: number;
  variantCount: number;
  runs: number;
  promptTokensPerCall: number;
  responseTokensPerCall: number;
}): Projection {
  const cases = params.taskCount * params.variantCount * params.runs;
  const perCallUsd = estimateCallCostUsd({
    modelId: params.model,
    tokens: {
      promptTokens: params.promptTokensPerCall,
      cachedTokens: 0,
      responseTokens: params.responseTokensPerCall,
      thinkingTokens: 0,
    },
    responseImages: 0,
  });
  return {
    cases,
    perCallUsd,
    totalUsd: perCallUsd * cases,
    promptTokensPerCall: params.promptTokensPerCall,
    responseTokensPerCall: params.responseTokensPerCall,
  };
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index < source.length) {
    const next = source.indexOf(needle, index);
    if (next === -1) {
      break;
    }
    count += 1;
    index = next + needle.length;
  }
  return count;
}

function applyReplacePlan(source: string, plan: ReplacePlan): string {
  let output = source;
  for (const edit of plan.replacements) {
    const matches = countOccurrences(output, edit.oldText);
    if (matches !== 1) {
      throw new Error(
        `replace failed: oldText match count for ${JSON.stringify(edit.oldText)} was ${matches}, expected 1`,
      );
    }
    output = output.replace(edit.oldText, edit.newText);
  }
  if (output === source) {
    throw new Error("replace failed: no effective changes were applied");
  }
  return output;
}

function applyPatchPlan(source: string, plan: PatchPlan): string {
  const lines = source.split("\n");
  const sortedPatches = [...plan.patches].sort((a, b) => b.startLine - a.startLine);
  for (const patch of sortedPatches) {
    if (patch.endLine < patch.startLine) {
      throw new Error(
        `patch failed: endLine ${patch.endLine} is before startLine ${patch.startLine}`,
      );
    }
    if (patch.startLine < 1 || patch.endLine > lines.length) {
      throw new Error(
        `patch failed: patch range ${patch.startLine}-${patch.endLine} is outside file line range 1-${lines.length}`,
      );
    }
    const replacementLines = patch.replacement.length === 0 ? [] : patch.replacement.split("\n");
    lines.splice(patch.startLine - 1, patch.endLine - patch.startLine + 1, ...replacementLines);
  }
  const output = lines.join("\n");
  if (output === source) {
    throw new Error("patch failed: no effective changes were applied");
  }
  return output;
}

function computeLineHash(line: string): string {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  const compact = normalized.replace(/\s+/g, "");
  let hash = 2166136261;
  for (let i = 0; i < compact.length; i += 1) {
    hash ^= compact.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const short = (hash >>> 0) % 256;
  return short.toString(16).padStart(2, "0");
}

function renderHashlineSource(source: string): string {
  const lines = source.split("\n");
  return lines.map((line, index) => `${index + 1}:${computeLineHash(line)}|${line}`).join("\n");
}

function parseAnchor(anchor: string): { line: number; hash: string } {
  const match = /^(\d+):([0-9a-f]{2})$/.exec(anchor);
  if (!match) {
    throw new Error(`Invalid hashline anchor: ${anchor}`);
  }
  const rawLine = match[1];
  const rawHash = match[2];
  if (rawLine === undefined || rawHash === undefined) {
    throw new Error(`Invalid hashline anchor: ${anchor}`);
  }
  const line = Number.parseInt(rawLine, 10);
  if (!Number.isFinite(line) || line < 1) {
    throw new Error(`Invalid hashline line number in anchor: ${anchor}`);
  }
  return { line, hash: rawHash };
}

function applyHashlinePlan(source: string, plan: HashlinePlan): string {
  const originalLines = source.split("\n");
  const nextLines = [...originalLines];
  for (const edit of plan.edits) {
    const { line, hash } = parseAnchor(edit.anchor);
    if (line > originalLines.length) {
      throw new Error(
        `hashline failed: anchor line ${line} exceeds file length ${originalLines.length}`,
      );
    }
    const currentLine = originalLines[line - 1] ?? "";
    const actualHash = computeLineHash(currentLine);
    if (actualHash !== hash) {
      throw new Error(
        `hashline failed: stale anchor ${edit.anchor}, expected hash ${actualHash} for line ${line}`,
      );
    }
    nextLines[line - 1] = edit.newText;
  }
  const output = nextLines.join("\n");
  if (output === source) {
    throw new Error("hashline failed: no effective changes were applied");
  }
  return output;
}

function applyApplyPatchPlan(source: string, plan: ApplyPatchPlan): string {
  const normalized = plan.patch.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  if (rawLines.length < 5) {
    throw new Error("apply_patch failed: patch is too short");
  }
  if (rawLines[0] !== "*** Begin Patch") {
    throw new Error('apply_patch failed: missing "*** Begin Patch" header');
  }
  if (rawLines[rawLines.length - 1] !== "*** End Patch") {
    throw new Error('apply_patch failed: missing "*** End Patch" footer');
  }

  const body = rawLines.slice(1, -1);
  const updateFileLines = body.filter((line) => line.startsWith("*** Update File: "));
  if (updateFileLines.length !== 1) {
    throw new Error(
      `apply_patch failed: expected exactly one "*** Update File:" section, got ${updateFileLines.length}`,
    );
  }
  const hunkStart = body.findIndex((line) => line.startsWith("@@"));
  if (hunkStart === -1) {
    throw new Error('apply_patch failed: missing "@@" hunk marker');
  }

  const hunkLines = body.slice(hunkStart + 1);
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of hunkLines) {
    if (line === "*** End of File") {
      continue;
    }
    if (line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("***")) {
      throw new Error(`apply_patch failed: unsupported line in hunk: ${line}`);
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      throw new Error(
        "apply_patch failed: context lines are not supported in this benchmark; use full-file replacement hunk",
      );
    }
    throw new Error(`apply_patch failed: unknown hunk line prefix: ${line}`);
  }

  if (removed.length === 0 || added.length === 0) {
    throw new Error("apply_patch failed: hunk must contain removed and added content");
  }

  const oldText = removed.join("\n");
  if (oldText !== source) {
    throw new Error(
      "apply_patch failed: removed block does not match the original source (use full-file replacement hunk)",
    );
  }

  const output = added.join("\n");
  if (output === source) {
    throw new Error("apply_patch failed: no effective changes were applied");
  }
  return output;
}

function shortLinePreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function describeMismatch(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const maxLines = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < maxLines; i += 1) {
    const expectedLine = expectedLines[i] ?? "";
    const actualLine = actualLines[i] ?? "";
    if (expectedLine !== actualLine) {
      return `line ${i + 1} mismatch (expected="${shortLinePreview(expectedLine)}", actual="${shortLinePreview(actualLine)}")`;
    }
  }
  return "output mismatch";
}

function buildReplacePrompt(task: MicroTask): string {
  return [
    `Task: ${task.title}`,
    task.description,
    "",
    "Apply the minimal fix using exact string replacements.",
    "Return JSON: { replacements: [{ oldText: string, newText: string }] }.",
    "Rules:",
    "- Copy oldText exactly from SOURCE.",
    "- Keep edits minimal and deterministic.",
    "- Do not add extra replacements.",
    "",
    "SOURCE:",
    `\`\`\`${task.language}`,
    task.source,
    "```",
  ].join("\n");
}

function buildPatchPrompt(task: MicroTask): string {
  return [
    `Task: ${task.title}`,
    task.description,
    "",
    "Apply the minimal fix using line-range patches against the original source.",
    "Return JSON: { patches: [{ startLine: number, endLine: number, replacement: string }] }.",
    "Rules:",
    "- Lines are 1-indexed and inclusive.",
    "- replacement may contain newlines.",
    "- Keep edits minimal and deterministic.",
    "",
    "SOURCE:",
    `\`\`\`${task.language}`,
    task.source,
    "```",
  ].join("\n");
}

function buildHashlinePrompt(task: MicroTask): string {
  const hashline = renderHashlineSource(task.source);
  return [
    `Task: ${task.title}`,
    task.description,
    "",
    "Apply the minimal fix with hashline anchors.",
    'Return JSON: { edits: [{ anchor: "LINE:HASH", newText: string }] }.',
    "Rules:",
    "- Anchor format is LINE:HASH.",
    "- The anchor must be copied from HASHLINE_SOURCE.",
    "- newText replaces the full line content for that anchor.",
    "- Keep edits minimal and deterministic.",
    "",
    "HASHLINE_SOURCE:",
    `\`\`\`${task.language}`,
    hashline,
    "```",
  ].join("\n");
}

function buildApplyPatchPrompt(task: MicroTask): string {
  return [
    `Task: ${task.title}`,
    task.description,
    "",
    "Apply the minimal fix and return a Codex-style apply_patch payload.",
    "Return JSON: { patch: string }.",
    "Rules:",
    "- patch must start with *** Begin Patch and end with *** End Patch.",
    "- include exactly one *** Update File: target.ts section.",
    "- use one @@ hunk with full-file replacement only:",
    "  first every original line prefixed with '-', then every final line prefixed with '+'.",
    "- do not use context (' ') lines.",
    "- output valid JSON only.",
    "",
    "SOURCE:",
    `\`\`\`${task.language}`,
    task.source,
    "```",
  ].join("\n");
}

function buildPrompt(task: MicroTask, variant: BenchmarkVariant): string {
  switch (variant) {
    case "replace":
      return buildReplacePrompt(task);
    case "patch":
      return buildPatchPrompt(task);
    case "hashline":
      return buildHashlinePrompt(task);
    case "apply_patch":
      return buildApplyPatchPrompt(task);
  }
}

async function runCase(params: {
  model: string;
  variant: BenchmarkVariant;
  task: MicroTask;
  runIndex: number;
  reasoning: ReasoningEffort;
}): Promise<CaseResult> {
  const startedAt = Date.now();
  const base = {
    model: params.model,
    input: buildPrompt(params.task, params.variant),
    instructions:
      "Return valid JSON only. Do not include prose, markdown, or code fences. Apply only the requested mechanical fix.",
    openAiReasoningEffort: params.reasoning,
    maxAttempts: 2,
  } as const;

  try {
    if (params.variant === "replace") {
      const response = await generateJson({
        ...base,
        schema: ReplaceSchema,
      });
      const patched = applyReplacePlan(params.task.source, response.value);
      const success = patched === params.task.expected;
      return {
        taskId: params.task.id,
        variant: params.variant,
        runIndex: params.runIndex,
        success,
        durationMs: Date.now() - startedAt,
        promptTokens: response.result.usage?.promptTokens,
        responseTokens: response.result.usage?.responseTokens,
        thinkingTokens: response.result.usage?.thinkingTokens,
        totalTokens: response.result.usage?.totalTokens,
        costUsd: response.result.costUsd,
        modelVersion: response.result.modelVersion,
        error: success ? undefined : describeMismatch(params.task.expected, patched),
      };
    }

    if (params.variant === "patch") {
      const response = await generateJson({
        ...base,
        schema: PatchSchema,
      });
      const patched = applyPatchPlan(params.task.source, response.value);
      const success = patched === params.task.expected;
      return {
        taskId: params.task.id,
        variant: params.variant,
        runIndex: params.runIndex,
        success,
        durationMs: Date.now() - startedAt,
        promptTokens: response.result.usage?.promptTokens,
        responseTokens: response.result.usage?.responseTokens,
        thinkingTokens: response.result.usage?.thinkingTokens,
        totalTokens: response.result.usage?.totalTokens,
        costUsd: response.result.costUsd,
        modelVersion: response.result.modelVersion,
        error: success ? undefined : describeMismatch(params.task.expected, patched),
      };
    }

    if (params.variant === "apply_patch") {
      const response = await generateJson({
        ...base,
        schema: ApplyPatchSchema,
      });
      const patched = applyApplyPatchPlan(params.task.source, response.value);
      const success = patched === params.task.expected;
      return {
        taskId: params.task.id,
        variant: params.variant,
        runIndex: params.runIndex,
        success,
        durationMs: Date.now() - startedAt,
        promptTokens: response.result.usage?.promptTokens,
        responseTokens: response.result.usage?.responseTokens,
        thinkingTokens: response.result.usage?.thinkingTokens,
        totalTokens: response.result.usage?.totalTokens,
        costUsd: response.result.costUsd,
        modelVersion: response.result.modelVersion,
        error: success ? undefined : describeMismatch(params.task.expected, patched),
      };
    }

    const response = await generateJson({
      ...base,
      schema: HashlineSchema,
    });
    const patched = applyHashlinePlan(params.task.source, response.value);
    const success = patched === params.task.expected;
    return {
      taskId: params.task.id,
      variant: params.variant,
      runIndex: params.runIndex,
      success,
      durationMs: Date.now() - startedAt,
      promptTokens: response.result.usage?.promptTokens,
      responseTokens: response.result.usage?.responseTokens,
      thinkingTokens: response.result.usage?.thinkingTokens,
      totalTokens: response.result.usage?.totalTokens,
      costUsd: response.result.costUsd,
      modelVersion: response.result.modelVersion,
      error: success ? undefined : describeMismatch(params.task.expected, patched),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      taskId: params.task.id,
      variant: params.variant,
      runIndex: params.runIndex,
      success: false,
      durationMs: Date.now() - startedAt,
      costUsd: 0,
      error: message,
    };
  }
}

function summarizeVariant(
  variant: BenchmarkVariant,
  caseResults: readonly CaseResult[],
): VariantSummary {
  const results = caseResults.filter((result) => result.variant === variant);
  const cases = results.length;
  const successCount = results.filter((result) => result.success).length;
  const durationTotal = results.reduce((acc, result) => acc + result.durationMs, 0);
  const costTotal = results.reduce((acc, result) => acc + result.costUsd, 0);
  const promptTokens = results.reduce((acc, result) => acc + asNonNegative(result.promptTokens), 0);
  const responseTokens = results.reduce(
    (acc, result) => acc + asNonNegative(result.responseTokens),
    0,
  );
  const thinkingTokens = results.reduce(
    (acc, result) => acc + asNonNegative(result.thinkingTokens),
    0,
  );
  const totalTokens = results.reduce((acc, result) => acc + asNonNegative(result.totalTokens), 0);

  return {
    variant,
    cases,
    successCount,
    successRate: cases > 0 ? successCount / cases : 0,
    avgDurationMs: cases > 0 ? durationTotal / cases : 0,
    avgCostUsd: cases > 0 ? costTotal / cases : 0,
    promptTokens,
    responseTokens,
    thinkingTokens,
    totalTokens,
  };
}

function formatUsd(value: number): string {
  return value.toFixed(6);
}

function buildMarkdownReport(params: {
  model: string;
  reasoning: ReasoningEffort;
  variants: readonly BenchmarkVariant[];
  tasks: readonly MicroTask[];
  runs: number;
  projection: Projection;
  caseResults: readonly CaseResult[];
  summaries: readonly VariantSummary[];
}): string {
  const successful = params.caseResults.filter((result) => result.success).length;
  const failed = params.caseResults.filter((result) => !result.success);
  const totalCost = params.caseResults.reduce((acc, result) => acc + result.costUsd, 0);
  const totalCases = params.caseResults.length;
  const successRate = totalCases > 0 ? successful / totalCases : 0;

  const lines: string[] = [];
  lines.push("# Agent Benchmark Report");
  lines.push("");
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Model: ${params.model}`);
  lines.push(`- Reasoning: ${params.reasoning}`);
  lines.push(`- Variants: ${params.variants.join(", ")}`);
  lines.push(`- Tasks: ${params.tasks.map((task) => task.id).join(", ")}`);
  lines.push(`- Runs per task/variant: ${params.runs}`);
  lines.push(`- Total cases: ${totalCases}`);
  lines.push(`- Success: ${successful}/${totalCases} (${(successRate * 100).toFixed(1)}%)`);
  lines.push(`- Total observed cost: $${formatUsd(totalCost)}`);
  lines.push("");
  lines.push("## Cost Projection");
  lines.push("");
  lines.push(
    `Projection inputs: prompt=${params.projection.promptTokensPerCall} tokens, response=${params.projection.responseTokensPerCall} tokens.`,
  );
  lines.push(`Projected cost per call: $${formatUsd(params.projection.perCallUsd)}`);
  lines.push(`Projected cost for this run: $${formatUsd(params.projection.totalUsd)}`);
  lines.push("");
  lines.push("## Variant Summary");
  lines.push("");
  lines.push(
    "| Variant | Success | Avg latency (s) | Avg cost (USD) | Prompt tokens | Response tokens | Thinking tokens | Total tokens |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const summary of params.summaries) {
    lines.push(
      `| ${summary.variant} | ${summary.successCount}/${summary.cases} (${(summary.successRate * 100).toFixed(1)}%) | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${formatUsd(summary.avgCostUsd)} | ${summary.promptTokens} | ${summary.responseTokens} | ${summary.thinkingTokens} | ${summary.totalTokens} |`,
    );
  }

  lines.push("");
  lines.push("## Failures");
  lines.push("");
  if (failed.length === 0) {
    lines.push("- None");
  } else {
    for (const failure of failed) {
      lines.push(
        `- \`${failure.variant}\` / \`${failure.taskId}\` / run ${failure.runIndex}: ${failure.error ?? "unknown error"}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: "string", default: DEFAULT_MODEL },
      variants: { type: "string", default: BENCHMARK_VARIANTS.join(",") },
      tasks: { type: "string" },
      "max-tasks": { type: "string", default: "4" },
      runs: { type: "string", default: "1" },
      reasoning: { type: "string", default: "low" },
      "estimate-prompt-tokens": { type: "string", default: "1200" },
      "estimate-response-tokens": { type: "string", default: "300" },
      "estimate-only": { type: "boolean", default: false },
      "out-dir": { type: "string", default: "benchmarks/agent/results" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const model = values.model ?? DEFAULT_MODEL;
  const variants = parseVariants(values.variants ?? BENCHMARK_VARIANTS.join(","));
  const maxTasks = parsePositiveInt(values["max-tasks"] ?? "4", "--max-tasks");
  const runs = parsePositiveInt(values.runs ?? "1", "--runs");
  const reasoning = parseReasoningEffort(values.reasoning ?? "low");
  const promptTokensPerCall = parsePositiveInt(
    values["estimate-prompt-tokens"] ?? "1200",
    "--estimate-prompt-tokens",
  );
  const responseTokensPerCall = parsePositiveInt(
    values["estimate-response-tokens"] ?? "300",
    "--estimate-response-tokens",
  );
  const tasks = selectTasks(values.tasks, maxTasks);

  if (tasks.length === 0) {
    throw new Error("No tasks selected.");
  }

  const projection = estimateProjection({
    model,
    taskCount: tasks.length,
    variantCount: variants.length,
    runs,
    promptTokensPerCall,
    responseTokensPerCall,
  });

  console.log(`Model: ${model}`);
  console.log(`Variants: ${variants.join(", ")}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Runs per task/variant: ${runs}`);
  console.log(`Projected cases: ${projection.cases}`);
  console.log(`Projected per-call cost: $${formatUsd(projection.perCallUsd)}`);
  console.log(`Projected total cost: $${formatUsd(projection.totalUsd)}`);

  if (values["estimate-only"]) {
    return;
  }

  const caseResults: CaseResult[] = [];
  for (const variant of variants) {
    for (const task of tasks) {
      for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
        const result = await runCase({
          model,
          variant,
          task,
          runIndex,
          reasoning,
        });
        caseResults.push(result);
        const marker = result.success ? "OK" : "FAIL";
        console.log(
          `[${marker}] ${variant} / ${task.id} / run ${runIndex} | ${(
            result.durationMs / 1000
          ).toFixed(
            2,
          )}s | $${formatUsd(result.costUsd)}${result.error ? ` | ${result.error}` : ""}`,
        );
      }
    }
  }

  const summaries = variants.map((variant) => summarizeVariant(variant, caseResults));
  const markdown = buildMarkdownReport({
    model,
    reasoning,
    variants,
    tasks,
    runs,
    projection,
    caseResults,
    summaries,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = resolve(values["out-dir"] ?? "benchmarks/agent/results");
  await mkdir(outputDir, { recursive: true });
  const jsonPath = join(outputDir, `agent-micro-${timestamp}.json`);
  const mdPath = join(outputDir, `agent-micro-${timestamp}.md`);

  const successful = caseResults.filter((result) => result.success).length;
  const totalCost = caseResults.reduce((acc, result) => acc + result.costUsd, 0);
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model,
        reasoning,
        variants,
        tasks: tasks.map((task) => task.id),
        runs,
        projection,
        summary: {
          cases: caseResults.length,
          successful,
          successRate: caseResults.length > 0 ? successful / caseResults.length : 0,
          totalCostUsd: totalCost,
        },
        variantsSummary: summaries,
        results: caseResults,
      },
      null,
      2,
    ),
  );
  await writeFile(mdPath, markdown);

  console.log(`\nWrote: ${jsonPath}`);
  console.log(`Wrote: ${mdPath}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
