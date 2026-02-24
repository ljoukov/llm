import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { zodToJsonSchema } from "@alcyone-labs/zod-to-json-schema";
import { z } from "zod";

import {
  type AgentFilesystemToolAccessContext,
  estimateCallCostUsd,
  generateJson,
  isLlmTextModelId,
  LLM_TEXT_MODEL_IDS,
  runAgentLoop,
  type LlmTextModelId,
  type LlmToolLoopStep,
} from "../../src/index.js";
import {
  DEFAULT_BENCHMARK_MODELS,
  type OutputFileSpec,
  type ClaimAudit,
  type QuantitativeFindings,
  type AgentBenchmarkTask,
  AGENT_BENCHMARK_TASKS,
} from "./tasks.js";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

type JsonRecord = Record<string, unknown>;

type OutputValidation = {
  readonly outputFile: string;
  readonly schemaFile: string;
  readonly exists: boolean;
  readonly jsonValid: boolean;
  readonly schemaValid: boolean;
  readonly groundingValid: boolean;
  readonly errors: readonly string[];
  readonly content?: string;
};

type ToolCallTrace = {
  readonly source: "llm" | "fs";
  readonly toolName: string;
  readonly step?: number;
  readonly action?: string;
  readonly path?: string;
  readonly timestamp?: string;
  readonly error?: string;
};

type FilesystemActionTrace = {
  readonly toolName: string;
  readonly action: AgentFilesystemToolAccessContext["action"];
  readonly path: string;
  readonly timestamp: string;
};

type ToolTraceEvaluation = {
  readonly pass: boolean;
  readonly totalCalls: number;
  readonly failedCalls: number;
  readonly toolsUsed: readonly string[];
  readonly hasSuccessfulRead: boolean;
  readonly hasSuccessfulWrite: boolean;
  readonly pathPolicyViolations: readonly string[];
  readonly notes: readonly string[];
  readonly calls: readonly ToolCallTrace[];
};

type GraderVerdict = z.infer<typeof GraderSchema>;

type UsageSummary = {
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly responseTokens: number;
  readonly thinkingTokens: number;
  readonly totalTokens: number;
};

type CaseResult = {
  readonly model: string;
  readonly agentReasoning: ReasoningEffort;
  readonly taskId: string;
  readonly runIndex: number;
  readonly workspacePath: string;
  readonly success: boolean;
  readonly schemaPass: boolean;
  readonly toolTracePass: boolean;
  readonly graderPass: boolean;
  readonly durationMs: number;
  readonly agentCostUsd: number;
  readonly graderCostUsd: number;
  readonly totalCostUsd: number;
  readonly agentUsage: UsageSummary;
  readonly graderUsage: UsageSummary;
  readonly totalUsage: UsageSummary;
  readonly modelVersions: readonly string[];
  readonly agentFinalText: string;
  readonly agentError?: string;
  readonly outputValidation: readonly OutputValidation[];
  readonly toolTrace: ToolTraceEvaluation;
  readonly grader: {
    readonly model: string;
    readonly value?: GraderVerdict;
    readonly error?: string;
  };
};

type Projection = {
  readonly totalCases: number;
  readonly estimatedAgentCostUsd: number;
  readonly estimatedGraderCostUsd: number;
  readonly estimatedTotalCostUsd: number;
  readonly agentPromptTokens: number;
  readonly agentResponseTokens: number;
  readonly graderPromptTokens: number;
  readonly graderResponseTokens: number;
};

type BenchmarkTaskSummary = {
  readonly id: string;
  readonly title: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
};

type ModelTaskRunSummary = {
  readonly model: string;
  readonly taskId: string;
  readonly runs: number;
  readonly passCount: number;
  readonly schemaPassCount: number;
  readonly toolPassCount: number;
  readonly graderPassCount: number;
  readonly bestRunIndex: number;
  readonly bestSuccess: boolean;
  readonly avgDurationMs: number;
  readonly bestDurationMs: number;
  readonly avgCostUsd: number;
  readonly bestCostUsd: number;
  readonly avgToolCalls: number;
  readonly bestToolCalls: number;
};

type LatestSummarySnapshot = {
  readonly models: readonly string[];
  readonly tasks: readonly BenchmarkTaskSummary[];
  readonly runs: number;
  readonly graderModel: string;
  readonly reasoning: ReasoningEffort;
  readonly caseResults: readonly CaseResult[];
};

type WorkspaceLayout = {
  readonly rootAbs: string;
  readonly rootRel: string;
  readonly reportPath: string;
  readonly reportText: string;
  readonly outputFileSpecs: readonly OutputFileSpec[];
  readonly taskFilePath: string;
};

type PromptTemplates = {
  readonly agentPrompt: string;
  readonly taskTemplate: string;
  readonly graderPrompt: string;
};

const DEFAULT_GRADER_MODEL: LlmTextModelId = "chatgpt-gpt-5.2";
const DEFAULT_MAX_STEPS = 100;
const DEFAULT_AGENT_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_GRADER_TIMEOUT_MS = 4 * 60_000;
const MIN_TOOL_CALLS = 3;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const MODEL_REASONING_OVERRIDES: Readonly<Record<string, ReasoningEffort>> = {};

const READ_TOOL_NAMES = new Set([
  "read_file",
  "read_files",
  "list_dir",
  "list_directory",
  "grep_files",
  "grep_search",
  "rg_search",
  "glob",
]);

const WRITE_TOOL_NAMES = new Set(["write_file", "replace", "apply_patch"]);

const GraderSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    scores: z
      .object({
        faithfulness: z.number().int().min(1).max(5),
        coverage: z.number().int().min(1).max(5),
        usefulness: z.number().int().min(1).max(5),
      })
      .strict(),
    critical_issues: z.array(z.string().min(8)).max(8),
    summary: z.string().min(20).max(500),
  })
  .strict();

function printUsage(): void {
  console.log(`
Filesystem Agent Benchmark for extraction/summarization from scientific reports.

Usage:
  npx tsx benchmarks/agent/run.ts [options]

Options:
  --models <list>                    Comma-separated model ids (default: ${DEFAULT_BENCHMARK_MODELS.join(",")})
  --tasks <list>                     Comma-separated task ids, or "all" (default: tumor-vaccine-ici)
  --runs <n>                         Runs per model/task (default: 1)
  --reasoning <level>                low, medium, high, xhigh (default: medium)
  --grader-model <id>                LLM grader model (default: ${DEFAULT_GRADER_MODEL})
  --max-steps <n>                    Max agent tool-loop steps (default: ${DEFAULT_MAX_STEPS})
  --estimate-agent-prompt-tokens <n> Estimated prompt tokens per agent call (default: 4200)
  --estimate-agent-response-tokens <n> Estimated response tokens per agent call (default: 900)
  --estimate-grader-prompt-tokens <n> Estimated prompt tokens per grader call (default: 5200)
  --estimate-grader-response-tokens <n> Estimated response tokens per grader call (default: 350)
  --estimate-only                    Print cost projection and exit
  --merge-latest                     Merge this run into traces/latest instead of replacing it
  --prune-traces                     Keep only traces/latest + traces/README.md after run
  --out-dir <path>                   Output directory (default: benchmarks/agent/results)
  --help                             Show this help
`);
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

function parseCsvList(raw: string): readonly string[] {
  const deduped = [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (deduped.length === 0) {
    throw new Error("Expected a non-empty comma-separated list.");
  }
  return deduped;
}

function parseModelId(raw: string, optionName: string): LlmTextModelId {
  if (isLlmTextModelId(raw)) {
    return raw;
  }
  throw new Error(
    `Invalid ${optionName} value: ${raw}. Supported models: ${LLM_TEXT_MODEL_IDS.join(", ")}`,
  );
}

function parseModelList(raw: string): readonly LlmTextModelId[] {
  return parseCsvList(raw).map((entry) => parseModelId(entry, "--models"));
}

function selectTasks(taskArg: string | undefined): readonly AgentBenchmarkTask[] {
  if (!taskArg) {
    return [AGENT_BENCHMARK_TASKS[0]].filter(
      (task): task is AgentBenchmarkTask => task !== undefined,
    );
  }
  const normalized = taskArg.trim().toLowerCase();
  if (normalized === "all" || normalized === "*") {
    return AGENT_BENCHMARK_TASKS;
  }
  const requested = parseCsvList(taskArg);
  const taskById = new Map(AGENT_BENCHMARK_TASKS.map((task) => [task.id, task]));
  const selected: AgentBenchmarkTask[] = [];
  for (const id of requested) {
    const task = taskById.get(id);
    if (!task) {
      throw new Error(`Unknown task id: ${id}`);
    }
    selected.push(task);
  }
  return selected;
}

function toBenchmarkTaskSummary(task: AgentBenchmarkTask): BenchmarkTaskSummary {
  return {
    id: task.id,
    title: task.title,
    sourceTitle: task.sourceTitle,
    sourceUrl: task.sourceUrl,
  };
}

const BENCHMARK_TASKS_BY_ID = new Map(
  AGENT_BENCHMARK_TASKS.map((task) => [task.id, toBenchmarkTaskSummary(task)]),
);

function sanitizeForPath(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeSlashes(value: string): string {
  return value.split(sep).join("/");
}

function toSafeRelativePath(params: { cwd: string; absolutePath: string }): string {
  const rel = normalizeSlashes(relative(params.cwd, params.absolutePath));
  if (rel === "") {
    return ".";
  }
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Path escapes workspace root.");
  }
  if (rel.includes("/../") || rel.endsWith("/..")) {
    throw new Error("Path traversal is not allowed.");
  }
  return rel;
}

function sanitizePathLikeText(value: string, workspaceRootAbs: string): string {
  let output = value;
  const escapedWorkspace = workspaceRootAbs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  output = output.replace(new RegExp(escapedWorkspace, "g"), "<workspace>");
  output = output.replace(/\/home\/[^/\s]+\/projects\//g, "<redacted>/projects/");
  return output;
}

function redactSensitivePaths(value: unknown, workspaceRootAbs: string): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith("http://") &&
      !trimmed.startsWith("https://") &&
      isAbsolute(trimmed)
    ) {
      try {
        return toSafeRelativePath({ cwd: workspaceRootAbs, absolutePath: trimmed });
      } catch {
        return "<redacted-absolute-path>";
      }
    }
    return sanitizePathLikeText(value, workspaceRootAbs);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitivePaths(entry, workspaceRootAbs));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactSensitivePaths(entry, workspaceRootAbs);
    }
    return output;
  }
  return value;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{([A-Z0-9_]+)}}/g, (_match, key: string) => values[key] ?? "");
}

async function loadPromptTemplates(benchmarkRoot: string): Promise<PromptTemplates> {
  const promptsRoot = join(benchmarkRoot, "prompts");
  const [agentPrompt, taskTemplate, graderPrompt] = await Promise.all([
    readFile(join(promptsRoot, "agent_prompt.md"), "utf8"),
    readFile(join(promptsRoot, "task_template.md"), "utf8"),
    readFile(join(promptsRoot, "grader_prompt.md"), "utf8"),
  ]);
  return { agentPrompt, taskTemplate, graderPrompt };
}

function formatUsd(value: number): string {
  return value.toFixed(6);
}

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.0%";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function resolveAgentReasoning(model: string, baseReasoning: ReasoningEffort): ReasoningEffort {
  return MODEL_REASONING_OVERRIDES[model] ?? baseReasoning;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : 0;
}

function emptyUsageSummary(): UsageSummary {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    responseTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
  };
}

function sumUsageSummaries(values: readonly UsageSummary[]): UsageSummary {
  const total = {
    promptTokens: 0,
    cachedTokens: 0,
    responseTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
  };
  for (const value of values) {
    total.promptTokens += value.promptTokens;
    total.cachedTokens += value.cachedTokens;
    total.responseTokens += value.responseTokens;
    total.thinkingTokens += value.thinkingTokens;
    total.totalTokens += value.totalTokens;
  }
  return total;
}

function summarizeUsage(value: unknown): UsageSummary {
  if (typeof value !== "object" || value === null) {
    return emptyUsageSummary();
  }
  const usage = value as {
    promptTokens?: unknown;
    cachedTokens?: unknown;
    responseTokens?: unknown;
    thinkingTokens?: unknown;
    totalTokens?: unknown;
  };
  return {
    promptTokens: toNonNegativeInt(usage.promptTokens),
    cachedTokens: toNonNegativeInt(usage.cachedTokens),
    responseTokens: toNonNegativeInt(usage.responseTokens),
    thinkingTokens: toNonNegativeInt(usage.thinkingTokens),
    totalTokens: toNonNegativeInt(usage.totalTokens),
  };
}

function asJsonRecord(value: unknown): JsonRecord | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return undefined;
}

function resolveSchemaRoot(schema: JsonRecord): JsonRecord {
  const refValue = schema.$ref;
  if (typeof refValue !== "string") {
    return schema;
  }
  const refMatch = /^#\/(definitions|[$]defs)\/(.+)$/u.exec(refValue);
  if (!refMatch) {
    return schema;
  }
  const defsKey = refMatch[1];
  const defName = refMatch[2];
  if (!defsKey || !defName) {
    return schema;
  }
  const defsRaw = schema[defsKey];
  const defs = asJsonRecord(defsRaw);
  if (!defs) {
    return schema;
  }
  const defValue = defs[defName];
  const defRecord = asJsonRecord(defValue);
  if (!defRecord) {
    return schema;
  }
  return defRecord;
}

function toSchemaDocument(spec: OutputFileSpec): JsonRecord {
  const schemaName = spec.schemaFile.replace(/\.schema\.json$/u, "").replace(/[/.]/g, "-");
  const raw = zodToJsonSchema(spec.schema, {
    name: schemaName,
    target: "jsonSchema7",
  }) as JsonRecord;
  const root = resolveSchemaRoot(raw);
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: schemaName,
    ...root,
  };
}

function buildTaskFile(params: {
  task: AgentBenchmarkTask;
  layout: WorkspaceLayout;
  taskTemplate: string;
}): string {
  const outputMappingList = params.layout.outputFileSpecs
    .map((spec) => `- \`${spec.outputFile}\` (schema: \`${spec.schemaFile}\`)`)
    .join("\n");

  return renderTemplate(params.taskTemplate, {
    TASK_ID: params.task.id,
    TASK_TITLE: params.task.title,
    SOURCE_TITLE: params.task.sourceTitle,
    SOURCE_URL: params.task.sourceUrl,
    TASK_FILE: params.layout.taskFilePath,
    REPORT_PATH: params.layout.reportPath,
    OUTPUT_SCHEMA_MAPPING_LIST: outputMappingList,
  });
}

async function createWorkspace(params: {
  task: AgentBenchmarkTask;
  workspaceRootAbs: string;
  workspaceRootRel: string;
  benchmarkRoot: string;
  taskTemplate: string;
}): Promise<WorkspaceLayout> {
  await mkdir(params.workspaceRootAbs, { recursive: true });

  const reportTemplatePath = join(params.benchmarkRoot, params.task.reportFile);
  const reportText = await readFile(reportTemplatePath, "utf8");

  const reportPath = "input/report.md";
  await mkdir(dirname(join(params.workspaceRootAbs, reportPath)), { recursive: true });
  await writeFile(join(params.workspaceRootAbs, reportPath), reportText);

  for (const spec of params.task.outputFileSpecs) {
    const schemaPath = spec.schemaFile;
    const outputPath = spec.outputFile;

    await mkdir(dirname(join(params.workspaceRootAbs, schemaPath)), { recursive: true });
    await mkdir(dirname(join(params.workspaceRootAbs, outputPath)), { recursive: true });

    const schemaDocument = toSchemaDocument(spec);
    await writeFile(
      join(params.workspaceRootAbs, schemaPath),
      `${JSON.stringify(schemaDocument, null, 2)}\n`,
    );

    // Pre-create placeholders to keep tool behavior deterministic across models.
    await writeFile(join(params.workspaceRootAbs, outputPath), "{}\n");
  }

  const layout: WorkspaceLayout = {
    rootAbs: params.workspaceRootAbs,
    rootRel: params.workspaceRootRel,
    reportPath,
    reportText,
    outputFileSpecs: params.task.outputFileSpecs,
    taskFilePath: "TASK.md",
  };

  await writeFile(
    join(params.workspaceRootAbs, layout.taskFilePath),
    buildTaskFile({ task: params.task, layout, taskTemplate: params.taskTemplate }),
  );
  return layout;
}
function buildAgentPrompt(layout: WorkspaceLayout, template: string): string {
  return renderTemplate(template, {
    TASK_FILE: layout.taskFilePath,
  });
}

function parseLineRef(ref: string): number | undefined {
  const match = /^L([1-9]\d*)$/u.exec(ref.trim());
  if (!match) {
    return undefined;
  }
  const raw = match[1];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validateLineRefSet(lineRefs: readonly string[], reportLineCount: number): string[] {
  const errors: string[] = [];
  for (const ref of lineRefs) {
    const lineNumber = parseLineRef(ref);
    if (lineNumber === undefined) {
      errors.push(`Invalid line reference format: ${ref}`);
      continue;
    }
    if (lineNumber > reportLineCount) {
      errors.push(`Line reference out of range: ${ref} (report has ${reportLineCount} lines)`);
    }
  }
  return errors;
}

function validateQuantitativeGrounding(
  value: QuantitativeFindings,
  reportLineCount: number,
): readonly string[] {
  const lineRefs: string[] = [];
  for (const finding of value.findings) {
    lineRefs.push(...finding.evidence_line_refs);
  }
  for (const control of value.controls_or_null_results) {
    lineRefs.push(control.evidence_line_ref);
  }
  return validateLineRefSet(lineRefs, reportLineCount);
}

function validateClaimGrounding(
  value: ClaimAudit,
  reportLineCount: number,
  reportText: string,
): readonly string[] {
  const errors: string[] = [];
  const lineRefs: string[] = [];
  const normalizedReport = normalizeWhitespace(reportText);

  for (const claim of value.claims) {
    for (const evidence of claim.evidence) {
      lineRefs.push(evidence.line_ref);
      const normalizedQuote = normalizeWhitespace(evidence.quote);
      if (normalizedQuote.length === 0) {
        errors.push(`Empty quote in claim ${claim.claim_id}`);
        continue;
      }
      if (!normalizedReport.includes(normalizedQuote)) {
        errors.push(
          `Quote in ${claim.claim_id} was not found verbatim in report: ${JSON.stringify(evidence.quote)}`,
        );
      }
    }
  }

  return errors.concat(validateLineRefSet(lineRefs, reportLineCount));
}

function flattenLlmToolCalls(steps: readonly LlmToolLoopStep[]): readonly ToolCallTrace[] {
  const traces: ToolCallTrace[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls) {
      traces.push({
        source: "llm",
        step: step.step,
        toolName: call.toolName,
        error: call.error,
      });
    }
  }
  return traces;
}

function flattenFilesystemActions(
  actions: readonly FilesystemActionTrace[],
): readonly ToolCallTrace[] {
  return actions.map((entry) => ({
    source: "fs",
    toolName: entry.toolName,
    action: entry.action,
    path: entry.path,
    timestamp: entry.timestamp,
  }));
}

const TOOL_PATH_KEYS = new Set(["file_path", "dir_path", "path", "paths", "from_path", "to_path"]);

function collectPathValuesFromInput(input: unknown): string[] {
  const values: string[] = [];
  if (typeof input !== "object" || input === null) {
    return values;
  }
  if (Array.isArray(input)) {
    for (const entry of input) {
      values.push(...collectPathValuesFromInput(entry));
    }
    return values;
  }

  for (const [key, value] of Object.entries(input)) {
    if (TOOL_PATH_KEYS.has(key)) {
      if (typeof value === "string") {
        values.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") {
            values.push(item);
          }
        }
      }
    }
    values.push(...collectPathValuesFromInput(value));
  }
  return values;
}

function collectPathPolicyViolations(steps: readonly LlmToolLoopStep[]): readonly string[] {
  const violations: string[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const pathValues = collectPathValuesFromInput(call.input);
      for (const rawPath of pathValues) {
        const pathValue = rawPath.trim();
        if (pathValue.length === 0) {
          continue;
        }
        if (isAbsolute(pathValue)) {
          violations.push(
            `Step ${step.step} tool ${call.toolName}: absolute path is disallowed (${JSON.stringify(pathValue)}).`,
          );
        }
        if (pathValue === ".." || pathValue.startsWith("../") || pathValue.includes("/../")) {
          violations.push(
            `Step ${step.step} tool ${call.toolName}: '..' path traversal is disallowed (${JSON.stringify(pathValue)}).`,
          );
        }
      }
    }
  }
  return violations;
}

function evaluateToolTrace(params: {
  steps: readonly LlmToolLoopStep[];
  fsActions: readonly FilesystemActionTrace[];
}): ToolTraceEvaluation {
  const llmCalls = flattenLlmToolCalls(params.steps);
  const fsCalls = flattenFilesystemActions(params.fsActions);
  const calls = llmCalls.concat(fsCalls);
  const toolsUsed = [...new Set(calls.map((call) => call.toolName))].sort();

  const hasSuccessfulRead = calls.some(
    (call) =>
      (READ_TOOL_NAMES.has(call.toolName) ||
        call.action === "read" ||
        call.action === "list" ||
        call.action === "search") &&
      !call.error,
  );
  const hasSuccessfulWrite = calls.some(
    (call) =>
      (WRITE_TOOL_NAMES.has(call.toolName) ||
        call.action === "write" ||
        call.action === "delete" ||
        call.action === "move") &&
      !call.error,
  );

  const failedCalls = calls.filter((call) => typeof call.error === "string").length;
  const notes: string[] = [];
  const pathPolicyViolations = collectPathPolicyViolations(params.steps);

  if (calls.length < MIN_TOOL_CALLS) {
    notes.push(`Expected at least ${MIN_TOOL_CALLS} tool calls, observed ${calls.length}.`);
  }
  if (!hasSuccessfulRead) {
    notes.push("No successful read/list/search tool call observed.");
  }
  if (!hasSuccessfulWrite) {
    notes.push("No successful write tool call observed (write_file/replace/apply_patch).");
  }
  notes.push(...pathPolicyViolations);

  return {
    pass: notes.length === 0,
    totalCalls: calls.length,
    failedCalls,
    toolsUsed,
    hasSuccessfulRead,
    hasSuccessfulWrite,
    pathPolicyViolations,
    notes,
    calls,
  };
}

function collectLineRefsFromValue(value: unknown): string[] {
  const refs: string[] = [];
  if (typeof value !== "object" || value === null) {
    return refs;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      refs.push(...collectLineRefsFromValue(entry));
    }
    return refs;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "line_ref" && typeof entry === "string") {
      refs.push(entry);
      continue;
    }
    if (key === "line_refs" && Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string") {
          refs.push(item);
        }
      }
      continue;
    }
    refs.push(...collectLineRefsFromValue(entry));
  }
  return refs;
}

function normalizeUnit(value: string): string {
  const compact = value.trim().toLowerCase().replace(/\s+/g, "");

  if (compact === "g") {
    return "g";
  }
  if (compact === "unitless" || compact === "dimensionless" || compact === "1") {
    return "dimensionless";
  }
  if (compact.includes("kj") && compact.includes("mol")) {
    return "kj/mol";
  }
  if (compact.includes("mol") && compact.includes("dm")) {
    return "mol/dm3";
  }
  return compact;
}

function validateExpectedAnswerValue(
  value: unknown,
  expected: NonNullable<OutputFileSpec["expectedAnswer"]>,
): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["Parsed output is not an object."];
  }
  const finalAnswer = (value as { final_answer?: unknown }).final_answer;
  if (typeof finalAnswer !== "object" || finalAnswer === null) {
    return ["Missing final_answer object."];
  }
  const actualValue = (finalAnswer as { value?: unknown }).value;
  const actualUnits = (finalAnswer as { units?: unknown }).units;
  if (typeof actualValue !== "number" || !Number.isFinite(actualValue)) {
    errors.push("final_answer.value must be a finite number.");
  } else {
    const delta = Math.abs(actualValue - expected.value);
    if (delta > expected.tolerance) {
      errors.push(
        `final_answer.value ${actualValue} differs from expected ${expected.value} by ${delta}, beyond tolerance ${expected.tolerance}.`,
      );
    }
  }
  if (typeof actualUnits !== "string" || actualUnits.trim().length === 0) {
    errors.push("final_answer.units must be a non-empty string.");
  } else if (normalizeUnit(actualUnits) !== normalizeUnit(expected.units)) {
    errors.push(
      `final_answer.units ${JSON.stringify(actualUnits)} != expected ${JSON.stringify(expected.units)}.`,
    );
  }
  return errors;
}

async function validateOutputs(layout: WorkspaceLayout): Promise<readonly OutputValidation[]> {
  const validations: OutputValidation[] = [];
  const reportLineCount = layout.reportText.split("\n").length;

  for (const spec of layout.outputFileSpecs) {
    const outputPath = join(layout.rootAbs, spec.outputFile);
    let content: string | undefined;
    try {
      content = await readFile(outputPath, "utf8");
    } catch {
      validations.push({
        outputFile: spec.outputFile,
        schemaFile: spec.schemaFile,
        exists: false,
        jsonValid: false,
        schemaValid: false,
        groundingValid: false,
        errors: [`Missing output file: ${spec.outputFile}`],
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      validations.push({
        outputFile: spec.outputFile,
        schemaFile: spec.schemaFile,
        exists: true,
        jsonValid: false,
        schemaValid: false,
        groundingValid: false,
        errors: [`Invalid JSON: ${message}`],
        content,
      });
      continue;
    }

    const schemaResult = spec.schema.safeParse(parsed);
    if (!schemaResult.success) {
      validations.push({
        outputFile: spec.outputFile,
        schemaFile: spec.schemaFile,
        exists: true,
        jsonValid: true,
        schemaValid: false,
        groundingValid: false,
        errors: schemaResult.error.issues.map(
          (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        ),
        content,
      });
      continue;
    }

    let groundingErrors: readonly string[] = [];
    switch (spec.groundingMode) {
      case "claim-audit":
        groundingErrors = validateClaimGrounding(
          schemaResult.data as ClaimAudit,
          reportLineCount,
          layout.reportText,
        );
        break;
      case "quantitative-findings":
        groundingErrors = validateQuantitativeGrounding(
          schemaResult.data as QuantitativeFindings,
          reportLineCount,
        );
        break;
      case "line-refs":
        groundingErrors = validateLineRefSet(
          collectLineRefsFromValue(schemaResult.data),
          reportLineCount,
        );
        break;
      default:
        groundingErrors = [];
        break;
    }

    const expectedAnswerErrors = spec.expectedAnswer
      ? validateExpectedAnswerValue(schemaResult.data, spec.expectedAnswer)
      : [];
    const allErrors = [...groundingErrors, ...expectedAnswerErrors];

    validations.push({
      outputFile: spec.outputFile,
      schemaFile: spec.schemaFile,
      exists: true,
      jsonValid: true,
      schemaValid: true,
      groundingValid: allErrors.length === 0,
      errors: allErrors,
      content,
    });
  }

  return validations;
}
function renderOutputBundle(validations: readonly OutputValidation[]): string {
  const sections: string[] = [];
  for (const validation of validations) {
    sections.push(`### ${validation.outputFile}`);
    sections.push(`- exists: ${validation.exists}`);
    sections.push(`- jsonValid: ${validation.jsonValid}`);
    sections.push(`- schemaValid: ${validation.schemaValid}`);
    sections.push(`- groundingValid: ${validation.groundingValid}`);
    if (validation.errors.length > 0) {
      sections.push("- validationErrors:");
      for (const error of validation.errors) {
        sections.push(`  - ${error}`);
      }
    }
    sections.push("```json");
    sections.push(validation.content ?? "<missing>");
    sections.push("```");
    sections.push("");
  }
  return sections.join("\n");
}

function renderNumberedReport(reportText: string): string {
  return reportText
    .split("\n")
    .map((line, index) => `L${index + 1}: ${line}`)
    .join("\n");
}

function buildGraderPrompt(params: {
  task: AgentBenchmarkTask;
  reportText: string;
  validations: readonly OutputValidation[];
  graderTemplate: string;
}): string {
  return renderTemplate(params.graderTemplate, {
    TASK_ID: params.task.id,
    TASK_TITLE: params.task.title,
    SOURCE_URL: params.task.sourceUrl,
    NUMBERED_REPORT: renderNumberedReport(params.reportText),
    OUTPUT_BUNDLE: renderOutputBundle(params.validations),
  });
}

async function gradeOutputs(params: {
  graderModel: LlmTextModelId;
  task: AgentBenchmarkTask;
  layout: WorkspaceLayout;
  validations: readonly OutputValidation[];
  reasoning: ReasoningEffort;
  graderTemplate: string;
}): Promise<{
  readonly value?: GraderVerdict;
  readonly error?: string;
  readonly costUsd: number;
  readonly usage: UsageSummary;
}> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error("Grader timeout exceeded."));
  }, DEFAULT_GRADER_TIMEOUT_MS);

  try {
    const response = await generateJson({
      model: params.graderModel,
      input: buildGraderPrompt({
        task: params.task,
        reportText: params.layout.reportText,
        validations: params.validations,
        graderTemplate: params.graderTemplate,
      }),
      schema: GraderSchema,
      instructions:
        "Be conservative. If uncertain about fidelity or coverage, choose fail and explain concrete issues.",
      openAiReasoningEffort: params.reasoning,
      maxAttempts: 2,
      signal: abortController.signal,
    });

    return {
      value: response.value,
      costUsd: response.result.costUsd,
      usage: summarizeUsage(response.result.usage),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, costUsd: 0, usage: emptyUsageSummary() };
  } finally {
    clearTimeout(timeout);
  }
}

async function runCase(params: {
  model: LlmTextModelId;
  agentReasoning: ReasoningEffort;
  task: AgentBenchmarkTask;
  runIndex: number;
  outRoot: string;
  benchmarkRoot: string;
  reasoning: ReasoningEffort;
  graderModel: LlmTextModelId;
  maxSteps: number;
  promptTemplates: PromptTemplates;
}): Promise<CaseResult> {
  const caseName = `${sanitizeForPath(params.model)}-${params.task.id}-run-${params.runIndex}`;
  const workspacePath = normalizeSlashes(join("workspaces", caseName));
  const workspaceRootAbs = join(params.outRoot, workspacePath);
  const layout = await createWorkspace({
    task: params.task,
    workspaceRootAbs,
    workspaceRootRel: workspacePath,
    benchmarkRoot: params.benchmarkRoot,
    taskTemplate: params.promptTemplates.taskTemplate,
  });

  const startedAt = Date.now();

  let agentError: string | undefined;
  let agentFinalText = "";
  let agentCostUsd = 0;
  let agentUsage: UsageSummary = emptyUsageSummary();
  let modelVersions: readonly string[] = [];
  let agentSteps: readonly LlmToolLoopStep[] = [];
  const fsActions: FilesystemActionTrace[] = [];

  const agentAbortController = new AbortController();
  const agentTimeout = setTimeout(() => {
    agentAbortController.abort(new Error("Agent timeout exceeded."));
  }, DEFAULT_AGENT_TIMEOUT_MS);

  try {
    const result = await runAgentLoop({
      model: params.model,
      input: buildAgentPrompt(layout, params.promptTemplates.agentPrompt),
      filesystemTool: {
        profile: "model-agnostic",
        options: {
          cwd: layout.rootAbs,
          checkAccess: (context) => {
            const safePath = toSafeRelativePath({
              cwd: layout.rootAbs,
              absolutePath: context.path,
            });
            fsActions.push({
              toolName: context.tool,
              action: context.action,
              path: safePath,
              timestamp: new Date().toISOString(),
            });
          },
        },
      },
      openAiReasoningEffort: params.agentReasoning,
      maxSteps: params.maxSteps,
      signal: agentAbortController.signal,
    });

    agentFinalText = sanitizePathLikeText(result.text, layout.rootAbs);
    agentCostUsd = result.totalCostUsd;
    agentSteps = result.steps;
    agentUsage = sumUsageSummaries(result.steps.map((step) => summarizeUsage(step.usage)));
    modelVersions = [...new Set(result.steps.map((step) => step.modelVersion))];

    const redactedResult = redactSensitivePaths(result, layout.rootAbs);
    await writeFile(
      join(layout.rootAbs, "agent-run.json"),
      `${JSON.stringify(
        {
          model: params.model,
          taskId: params.task.id,
          runIndex: params.runIndex,
          result: redactedResult,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentError = sanitizePathLikeText(message, layout.rootAbs);
    await writeFile(
      join(layout.rootAbs, "agent-run.json"),
      `${JSON.stringify(
        {
          model: params.model,
          taskId: params.task.id,
          runIndex: params.runIndex,
          error: agentError,
          partialResult: {
            text: agentFinalText,
            totalCostUsd: agentCostUsd,
            steps: redactSensitivePaths(agentSteps, layout.rootAbs),
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    clearTimeout(agentTimeout);
  }

  await writeFile(
    join(layout.rootAbs, "filesystem-access-trace.json"),
    `${JSON.stringify(fsActions, null, 2)}\n`,
  );

  const toolTrace = evaluateToolTrace({ steps: agentSteps, fsActions });
  const validations = await validateOutputs(layout);
  const schemaPass = validations.every(
    (validation) => validation.schemaValid && validation.groundingValid,
  );

  const grader = await gradeOutputs({
    graderModel: params.graderModel,
    task: params.task,
    layout,
    validations,
    reasoning: params.reasoning,
    graderTemplate: params.promptTemplates.graderPrompt,
  });

  const graderPass = grader.value?.verdict === "pass";
  const durationMs = Date.now() - startedAt;
  const totalCostUsd = agentCostUsd + grader.costUsd;
  const totalUsage = sumUsageSummaries([agentUsage, grader.usage]);

  const success = !agentError && schemaPass && toolTrace.pass && graderPass;

  const caseResult: CaseResult = {
    model: params.model,
    agentReasoning: params.agentReasoning,
    taskId: params.task.id,
    runIndex: params.runIndex,
    workspacePath: layout.rootRel,
    success,
    schemaPass,
    toolTracePass: toolTrace.pass,
    graderPass,
    durationMs,
    agentCostUsd,
    graderCostUsd: grader.costUsd,
    totalCostUsd,
    agentUsage,
    graderUsage: grader.usage,
    totalUsage,
    modelVersions,
    agentFinalText,
    agentError,
    outputValidation: validations,
    toolTrace,
    grader: {
      model: params.graderModel,
      value: grader.value,
      error: grader.error,
    },
  };

  await writeFile(
    join(layout.rootAbs, "validation.json"),
    `${JSON.stringify(caseResult, null, 2)}\n`,
  );
  return caseResult;
}

function estimateProjection(params: {
  models: readonly string[];
  taskCount: number;
  runs: number;
  graderModel: string;
  agentPromptTokens: number;
  agentResponseTokens: number;
  graderPromptTokens: number;
  graderResponseTokens: number;
}): Projection {
  let estimatedAgentCostUsd = 0;
  let estimatedGraderCostUsd = 0;

  for (const model of params.models) {
    const perCaseAgent = estimateCallCostUsd({
      modelId: model,
      tokens: {
        promptTokens: params.agentPromptTokens,
        cachedTokens: 0,
        responseTokens: params.agentResponseTokens,
        thinkingTokens: 0,
      },
      responseImages: 0,
    });
    const casesForModel = params.taskCount * params.runs;
    estimatedAgentCostUsd += perCaseAgent * casesForModel;
  }

  const perCaseGrader = estimateCallCostUsd({
    modelId: params.graderModel,
    tokens: {
      promptTokens: params.graderPromptTokens,
      cachedTokens: 0,
      responseTokens: params.graderResponseTokens,
      thinkingTokens: 0,
    },
    responseImages: 0,
  });

  const totalCases = params.models.length * params.taskCount * params.runs;
  estimatedGraderCostUsd = perCaseGrader * totalCases;

  return {
    totalCases,
    estimatedAgentCostUsd,
    estimatedGraderCostUsd,
    estimatedTotalCostUsd: estimatedAgentCostUsd + estimatedGraderCostUsd,
    agentPromptTokens: params.agentPromptTokens,
    agentResponseTokens: params.agentResponseTokens,
    graderPromptTokens: params.graderPromptTokens,
    graderResponseTokens: params.graderResponseTokens,
  };
}

function summarizeByModel(
  model: string,
  cases: readonly CaseResult[],
): {
  readonly model: string;
  readonly cases: number;
  readonly success: number;
  readonly schemaPass: number;
  readonly toolPass: number;
  readonly graderPass: number;
  readonly avgDurationMs: number;
  readonly totalDurationMs: number;
  readonly totalToolCalls: number;
  readonly totalCostUsd: number;
  readonly totalUsage: UsageSummary;
} {
  const modelCases = cases.filter((entry) => entry.model === model);
  const count = modelCases.length;
  const success = modelCases.filter((entry) => entry.success).length;
  const schemaPass = modelCases.filter((entry) => entry.schemaPass).length;
  const toolPass = modelCases.filter((entry) => entry.toolTracePass).length;
  const graderPass = modelCases.filter((entry) => entry.graderPass).length;
  const totalDurationMs = modelCases.reduce((acc, entry) => acc + entry.durationMs, 0);
  const avgDurationMs = count === 0 ? 0 : totalDurationMs / count;
  const totalToolCalls = modelCases.reduce((acc, entry) => acc + entry.toolTrace.totalCalls, 0);
  const totalCostUsd = modelCases.reduce((acc, entry) => acc + entry.totalCostUsd, 0);
  const totalUsage = sumUsageSummaries(modelCases.map((entry) => entry.totalUsage));

  return {
    model,
    cases: count,
    success,
    schemaPass,
    toolPass,
    graderPass,
    avgDurationMs,
    totalDurationMs,
    totalToolCalls,
    totalCostUsd,
    totalUsage,
  };
}

function modelTaskResultKey(value: Pick<CaseResult, "model" | "taskId">): string {
  return `${value.model}::${value.taskId}`;
}

function graderScoreTotal(result: CaseResult): number {
  const scores = result.grader.value?.scores;
  if (!scores) {
    return 0;
  }
  return scores.faithfulness + scores.coverage + scores.usefulness;
}

function resultGateScore(result: CaseResult): number {
  let score = 0;
  if (result.success) {
    score += 8;
  }
  if (result.schemaPass) {
    score += 4;
  }
  if (result.toolTracePass) {
    score += 2;
  }
  if (result.graderPass) {
    score += 1;
  }
  return score;
}

function isBetterCaseResult(candidate: CaseResult, best: CaseResult): boolean {
  const candidateGate = resultGateScore(candidate);
  const bestGate = resultGateScore(best);
  if (candidateGate !== bestGate) {
    return candidateGate > bestGate;
  }

  const candidateGrader = graderScoreTotal(candidate);
  const bestGrader = graderScoreTotal(best);
  if (candidateGrader !== bestGrader) {
    return candidateGrader > bestGrader;
  }

  if (candidate.durationMs !== best.durationMs) {
    return candidate.durationMs < best.durationMs;
  }
  if (candidate.totalCostUsd !== best.totalCostUsd) {
    return candidate.totalCostUsd < best.totalCostUsd;
  }
  return candidate.runIndex < best.runIndex;
}

function summarizeByModelTaskAcrossRuns(params: {
  models: readonly string[];
  tasks: readonly BenchmarkTaskSummary[];
  cases: readonly CaseResult[];
}): readonly ModelTaskRunSummary[] {
  const grouped = new Map<string, CaseResult[]>();
  for (const result of params.cases) {
    const key = modelTaskResultKey(result);
    const group = grouped.get(key);
    if (group) {
      group.push(result);
    } else {
      grouped.set(key, [result]);
    }
  }

  const summaries: ModelTaskRunSummary[] = [];
  const consumed = new Set<string>();
  const appendSummary = (model: string, taskId: string, entries: readonly CaseResult[]) => {
    if (entries.length === 0) {
      return;
    }

    let best = entries[0];
    if (!best) {
      return;
    }
    for (const result of entries.slice(1)) {
      if (isBetterCaseResult(result, best)) {
        best = result;
      }
    }

    const runs = entries.length;
    const passCount = entries.filter((entry) => entry.success).length;
    const schemaPassCount = entries.filter((entry) => entry.schemaPass).length;
    const toolPassCount = entries.filter((entry) => entry.toolTracePass).length;
    const graderPassCount = entries.filter((entry) => entry.graderPass).length;
    const avgDurationMs = entries.reduce((acc, entry) => acc + entry.durationMs, 0) / runs;
    const avgCostUsd = entries.reduce((acc, entry) => acc + entry.totalCostUsd, 0) / runs;
    const avgToolCalls = entries.reduce((acc, entry) => acc + entry.toolTrace.totalCalls, 0) / runs;

    summaries.push({
      model,
      taskId,
      runs,
      passCount,
      schemaPassCount,
      toolPassCount,
      graderPassCount,
      bestRunIndex: best.runIndex,
      bestSuccess: best.success,
      avgDurationMs,
      bestDurationMs: best.durationMs,
      avgCostUsd,
      bestCostUsd: best.totalCostUsd,
      avgToolCalls,
      bestToolCalls: best.toolTrace.totalCalls,
    });
  };

  for (const model of params.models) {
    for (const task of params.tasks) {
      const key = modelTaskResultKey({ model, taskId: task.id });
      const entries = grouped.get(key);
      if (!entries) {
        continue;
      }
      consumed.add(key);
      appendSummary(model, task.id, entries);
    }
  }

  const remaining = [...grouped.entries()].filter(([key]) => !consumed.has(key));
  remaining.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, entries] of remaining) {
    const [model, taskId] = key.split("::");
    if (!model || !taskId) {
      continue;
    }
    appendSummary(model, taskId, entries);
  }

  return summaries;
}

function buildMarkdownReport(params: {
  runId: string;
  generatedAt: string;
  models: readonly string[];
  tasks: readonly BenchmarkTaskSummary[];
  runs: number;
  reasoning: ReasoningEffort;
  graderModel: string;
  projection: Projection;
  caseResults: readonly CaseResult[];
}): string {
  const totalCases = params.caseResults.length;
  const success = params.caseResults.filter((entry) => entry.success).length;
  const schemaPass = params.caseResults.filter((entry) => entry.schemaPass).length;
  const toolPass = params.caseResults.filter((entry) => entry.toolTracePass).length;
  const graderPass = params.caseResults.filter((entry) => entry.graderPass).length;
  const totalCostUsd = params.caseResults.reduce((acc, entry) => acc + entry.totalCostUsd, 0);
  const totalDurationMs = params.caseResults.reduce((acc, entry) => acc + entry.durationMs, 0);
  const avgDurationMs = totalCases === 0 ? 0 : totalDurationMs / totalCases;
  const totalUsage = sumUsageSummaries(params.caseResults.map((entry) => entry.totalUsage));
  const perTaskAcrossRuns = summarizeByModelTaskAcrossRuns({
    models: params.models,
    tasks: params.tasks,
    cases: params.caseResults,
  });

  const lines: string[] = [];
  lines.push("# Filesystem Agent Benchmark Report");
  lines.push("");
  lines.push(`- Run id: ${params.runId}`);
  lines.push(`- Generated at: ${params.generatedAt}`);
  lines.push(`- Models: ${params.models.join(", ")}`);
  lines.push(`- Grader model: ${params.graderModel}`);
  lines.push(`- Reasoning effort: ${params.reasoning}`);
  const modelReasoningOverrideEntries = Object.entries(MODEL_REASONING_OVERRIDES);
  if (modelReasoningOverrideEntries.length > 0) {
    lines.push(
      `- Model reasoning overrides: ${modelReasoningOverrideEntries.map(([model, effort]) => `${model}=${effort}`).join(", ")}`,
    );
  }
  lines.push(`- Tasks: ${params.tasks.map((task) => task.id).join(", ")}`);
  lines.push(`- Runs per model/task: ${params.runs}`);
  lines.push(`- Cases: ${totalCases}`);
  lines.push(`- Overall success: ${success}/${totalCases}`);
  lines.push(`- Schema pass: ${schemaPass}/${totalCases}`);
  lines.push(`- Tool trace pass: ${toolPass}/${totalCases}`);
  lines.push(`- Grader pass: ${graderPass}/${totalCases}`);
  lines.push(`- Observed total latency: ${(totalDurationMs / 1000).toFixed(2)}s`);
  lines.push(`- Observed avg latency/case: ${(avgDurationMs / 1000).toFixed(2)}s`);
  lines.push(`- Observed total cost: $${formatUsd(totalCostUsd)}`);
  lines.push(
    `- Observed tokens (in/cached/out): ${formatInt(totalUsage.promptTokens)}/${formatInt(totalUsage.cachedTokens)}/${formatInt(totalUsage.responseTokens)}`,
  );
  lines.push(`- Observed thinking tokens: ${formatInt(totalUsage.thinkingTokens)}`);
  lines.push(`- Observed total tokens: ${formatInt(totalUsage.totalTokens)}`);
  lines.push("");

  lines.push("## Source Papers");
  lines.push("");
  for (const task of params.tasks) {
    lines.push(`- ${task.id}: ${task.sourceTitle} (${task.sourceUrl})`);
  }
  lines.push("");

  lines.push("## Cost Projection Inputs");
  lines.push("");
  lines.push(`- Agent prompt tokens per call: ${params.projection.agentPromptTokens}`);
  lines.push(`- Agent response tokens per call: ${params.projection.agentResponseTokens}`);
  lines.push(`- Grader prompt tokens per call: ${params.projection.graderPromptTokens}`);
  lines.push(`- Grader response tokens per call: ${params.projection.graderResponseTokens}`);
  lines.push(
    `- Estimated agent cost total: $${formatUsd(params.projection.estimatedAgentCostUsd)}`,
  );
  lines.push(
    `- Estimated grader cost total: $${formatUsd(params.projection.estimatedGraderCostUsd)}`,
  );
  lines.push(`- Estimated grand total: $${formatUsd(params.projection.estimatedTotalCostUsd)}`);
  lines.push("");

  lines.push("## Per-Model Summary");
  lines.push("");
  lines.push(
    "| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const model of params.models) {
    const summary = summarizeByModel(model, params.caseResults);
    lines.push(
      `| ${summary.model} | ${summary.success}/${summary.cases} | ${summary.schemaPass}/${summary.cases} | ${summary.toolPass}/${summary.cases} | ${summary.graderPass}/${summary.cases} | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.totalDurationMs / 1000).toFixed(2)} | ${summary.totalToolCalls} | ${formatUsd(summary.totalCostUsd)} | ${formatInt(summary.totalUsage.promptTokens)} | ${formatInt(summary.totalUsage.cachedTokens)} | ${formatInt(summary.totalUsage.responseTokens)} |`,
    );
  }
  lines.push("");

  lines.push("## Per-Task Across Runs (Best + Average)");
  lines.push("");
  lines.push(
    "| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |",
  );
  lines.push("|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const summary of perTaskAcrossRuns) {
    lines.push(
      `| ${summary.model} | ${summary.taskId} | ${summary.runs} | ${summary.bestSuccess ? "PASS" : "FAIL"} (run ${summary.bestRunIndex}) | ${summary.passCount}/${summary.runs} (${formatPercent(summary.passCount, summary.runs)}) | ${summary.schemaPassCount}/${summary.runs} (${formatPercent(summary.schemaPassCount, summary.runs)}) | ${summary.toolPassCount}/${summary.runs} (${formatPercent(summary.toolPassCount, summary.runs)}) | ${summary.graderPassCount}/${summary.runs} (${formatPercent(summary.graderPassCount, summary.runs)}) | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.bestDurationMs / 1000).toFixed(2)} | ${formatUsd(summary.avgCostUsd)} | ${formatUsd(summary.bestCostUsd)} | ${summary.avgToolCalls.toFixed(2)} | ${summary.bestToolCalls} |`,
    );
  }
  lines.push("");

  lines.push("## Case Matrix");
  lines.push("");
  lines.push(
    "| Model | Task | Run | Reasoning | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |",
  );
  lines.push("|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const result of params.caseResults) {
    lines.push(
      `| ${result.model} | ${result.taskId} | ${result.runIndex} | ${result.agentReasoning} | ${result.success ? "PASS" : "FAIL"} | ${result.schemaPass ? "pass" : "fail"} | ${result.toolTracePass ? "pass" : "fail"} | ${result.graderPass ? "pass" : "fail"} | ${(result.durationMs / 1000).toFixed(2)} | ${result.toolTrace.totalCalls} | ${formatUsd(result.totalCostUsd)} | ${formatInt(result.totalUsage.promptTokens)} | ${formatInt(result.totalUsage.cachedTokens)} | ${formatInt(result.totalUsage.responseTokens)} |`,
    );
  }
  lines.push("");

  lines.push("## Failures");
  lines.push("");
  const failures = params.caseResults.filter((entry) => !entry.success);
  if (failures.length === 0) {
    lines.push("- None");
  } else {
    for (const failure of failures) {
      const reasons: string[] = [];
      if (failure.agentError) {
        reasons.push(`agent_error=${failure.agentError}`);
      }
      if (!failure.schemaPass) {
        reasons.push("schema_or_grounding_failed");
      }
      if (!failure.toolTracePass) {
        reasons.push(`tool_trace=${failure.toolTrace.notes.join("; ") || "failed"}`);
      }
      if (!failure.graderPass) {
        reasons.push(
          failure.grader.error
            ? `grader_error=${failure.grader.error}`
            : `grader_verdict=${failure.grader.value?.verdict ?? "missing"}`,
        );
      }
      lines.push(
        `- ${failure.model} / ${failure.taskId} / run ${failure.runIndex}: ${reasons.join(" | ")}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildLatestResultsMarkdown(params: {
  runId: string;
  generatedAt: string;
  models: readonly string[];
  tasks: readonly BenchmarkTaskSummary[];
  graderModel: string;
  caseResults: readonly CaseResult[];
}): string {
  const totalCases = params.caseResults.length;
  const success = params.caseResults.filter((entry) => entry.success).length;
  const schemaPass = params.caseResults.filter((entry) => entry.schemaPass).length;
  const toolPass = params.caseResults.filter((entry) => entry.toolTracePass).length;
  const graderPass = params.caseResults.filter((entry) => entry.graderPass).length;
  const totalCostUsd = params.caseResults.reduce((acc, entry) => acc + entry.totalCostUsd, 0);
  const totalDurationMs = params.caseResults.reduce((acc, entry) => acc + entry.durationMs, 0);
  const avgDurationMs = totalCases === 0 ? 0 : totalDurationMs / totalCases;
  const totalUsage = sumUsageSummaries(params.caseResults.map((entry) => entry.totalUsage));
  const perTaskAcrossRuns = summarizeByModelTaskAcrossRuns({
    models: params.models,
    tasks: params.tasks,
    cases: params.caseResults,
  });

  const lines: string[] = [];
  lines.push("# Latest Agent Benchmark Results");
  lines.push("");
  lines.push("This file is auto-generated from the latest benchmark run.");
  lines.push("");
  lines.push(`- Run id: \`${params.runId}\``);
  lines.push(`- Generated at: \`${params.generatedAt}\``);
  lines.push(`- Tasks: ${params.tasks.map((task) => `\`${task.id}\``).join(", ")}`);
  lines.push(`- Models: ${params.models.map((model) => `\`${model}\``).join(", ")}`);
  lines.push(`- Grader: \`${params.graderModel}\``);
  const modelReasoningOverrideEntries = Object.entries(MODEL_REASONING_OVERRIDES);
  if (modelReasoningOverrideEntries.length > 0) {
    lines.push(
      `- Model reasoning overrides: ${modelReasoningOverrideEntries.map(([model, effort]) => `\`${model}=${effort}\``).join(", ")}`,
    );
  }
  lines.push("");

  lines.push("## Aggregate");
  lines.push("");
  lines.push(
    `- Cases: ${success}/${totalCases} pass (${schemaPass}/${totalCases} schema, ${toolPass}/${totalCases} tool trace, ${graderPass}/${totalCases} grader)`,
  );
  lines.push(`- Total latency: ${(totalDurationMs / 1000).toFixed(2)}s`);
  lines.push(`- Avg latency per case: ${(avgDurationMs / 1000).toFixed(2)}s`);
  lines.push(`- Total cost: $${formatUsd(totalCostUsd)}`);
  lines.push(
    `- Tokens (in/cached/out): ${formatInt(totalUsage.promptTokens)}/${formatInt(totalUsage.cachedTokens)}/${formatInt(totalUsage.responseTokens)}`,
  );
  lines.push(`- Thinking tokens: ${formatInt(totalUsage.thinkingTokens)}`);
  lines.push(`- Total tokens: ${formatInt(totalUsage.totalTokens)}`);
  lines.push("");

  lines.push("## Outcome");
  lines.push("");
  lines.push(
    "| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |",
  );
  lines.push("|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const model of params.models) {
    const summary = summarizeByModel(model, params.caseResults);
    const overall = summary.success === summary.cases ? "PASS" : "FAIL";
    lines.push(
      `| \`${summary.model}\` | ${overall} | ${summary.schemaPass}/${summary.cases} | ${summary.toolPass}/${summary.cases} | ${summary.graderPass}/${summary.cases} | ${summary.totalToolCalls} | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.totalDurationMs / 1000).toFixed(2)} | ${formatUsd(summary.totalCostUsd)} | ${formatInt(summary.totalUsage.promptTokens)} | ${formatInt(summary.totalUsage.cachedTokens)} | ${formatInt(summary.totalUsage.responseTokens)} |`,
    );
  }
  lines.push("");

  lines.push("## Per-Task Across Runs (Best + Average)");
  lines.push("");
  lines.push(
    "| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |",
  );
  lines.push("|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const summary of perTaskAcrossRuns) {
    lines.push(
      `| \`${summary.model}\` | \`${summary.taskId}\` | ${summary.runs} | ${summary.bestSuccess ? "PASS" : "FAIL"} (run ${summary.bestRunIndex}) | ${summary.passCount}/${summary.runs} (${formatPercent(summary.passCount, summary.runs)}) | ${summary.schemaPassCount}/${summary.runs} (${formatPercent(summary.schemaPassCount, summary.runs)}) | ${summary.toolPassCount}/${summary.runs} (${formatPercent(summary.toolPassCount, summary.runs)}) | ${summary.graderPassCount}/${summary.runs} (${formatPercent(summary.graderPassCount, summary.runs)}) | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.bestDurationMs / 1000).toFixed(2)} | ${formatUsd(summary.avgCostUsd)} | ${formatUsd(summary.bestCostUsd)} | ${summary.avgToolCalls.toFixed(2)} | ${summary.bestToolCalls} |`,
    );
  }
  lines.push("");

  lines.push("## Artifact Paths");
  lines.push("");
  lines.push("- Committed traces/workspaces: `benchmarks/agent/traces/latest/`");
  lines.push("- Raw run outputs (gitignored): `benchmarks/agent/results/`");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function pruneTraceArtifacts(benchmarkRoot: string): Promise<void> {
  const tracesRoot = join(benchmarkRoot, "traces");
  const entries = await readdir(tracesRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === "latest" || entry.name === "README.md") {
        return;
      }
      await rm(join(tracesRoot, entry.name), { recursive: true, force: true });
    }),
  );
}

function caseResultKey(value: Pick<CaseResult, "model" | "taskId" | "runIndex">): string {
  return `${value.model}::${value.taskId}::${value.runIndex}`;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function parseBenchmarkTaskSummaries(value: unknown): BenchmarkTaskSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tasks: BenchmarkTaskSummary[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const task = item as Record<string, unknown>;
    const id = typeof task.id === "string" ? task.id.trim() : "";
    const title = typeof task.title === "string" ? task.title : id;
    const sourceTitle = typeof task.sourceTitle === "string" ? task.sourceTitle : title;
    const sourceUrl = typeof task.sourceUrl === "string" ? task.sourceUrl : "";
    if (!id) {
      continue;
    }
    tasks.push({ id, title, sourceTitle, sourceUrl });
  }
  return tasks;
}

function parseCaseResults(value: unknown): CaseResult[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const entry = item as Record<string, unknown>;
    return (
      typeof entry.model === "string" &&
      typeof entry.taskId === "string" &&
      typeof entry.runIndex === "number"
    );
  }) as CaseResult[];
}

async function loadLatestSummarySnapshot(
  benchmarkRoot: string,
): Promise<LatestSummarySnapshot | undefined> {
  const latestSummaryPath = join(benchmarkRoot, "traces", "latest", "summary.json");
  let raw: string;
  try {
    raw = await readFile(latestSummaryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const models =
    Array.isArray(parsed.models) && parsed.models.every((value) => typeof value === "string")
      ? (parsed.models as string[])
      : [];
  const tasks = parseBenchmarkTaskSummaries(parsed.tasks);
  const runs =
    typeof parsed.runs === "number" && Number.isFinite(parsed.runs) && parsed.runs > 0
      ? Math.floor(parsed.runs)
      : 1;
  const graderModel = typeof parsed.graderModel === "string" ? parsed.graderModel : "";
  const reasoning = isReasoningEffort(parsed.reasoning) ? parsed.reasoning : "medium";
  const caseResults = parseCaseResults(parsed.results);

  return {
    models,
    tasks,
    runs,
    graderModel,
    reasoning,
    caseResults,
  };
}

function mergeCaseResults(
  existing: readonly CaseResult[],
  updates: readonly CaseResult[],
): readonly CaseResult[] {
  const merged = new Map<string, CaseResult>();
  for (const result of existing) {
    merged.set(caseResultKey(result), result);
  }
  for (const result of updates) {
    merged.set(caseResultKey(result), result);
  }
  return [...merged.values()];
}

function mergeModels(params: {
  existingModels: readonly string[];
  currentModels: readonly string[];
  caseResults: readonly CaseResult[];
}): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  for (const model of params.existingModels) {
    add(model);
  }
  for (const model of params.currentModels) {
    add(model);
  }
  for (const result of params.caseResults) {
    add(result.model);
  }
  return ordered;
}

function mergeTaskSummaries(params: {
  existingTasks: readonly BenchmarkTaskSummary[];
  currentTasks: readonly BenchmarkTaskSummary[];
  caseResults: readonly CaseResult[];
}): readonly BenchmarkTaskSummary[] {
  const ordered = new Map<string, BenchmarkTaskSummary>();
  const add = (task: BenchmarkTaskSummary) => {
    if (!ordered.has(task.id)) {
      ordered.set(task.id, task);
    }
  };

  for (const task of params.existingTasks) {
    add(task);
  }
  for (const task of params.currentTasks) {
    add(task);
  }

  for (const result of params.caseResults) {
    if (ordered.has(result.taskId)) {
      continue;
    }
    const known = BENCHMARK_TASKS_BY_ID.get(result.taskId);
    if (known) {
      add(known);
    } else {
      add({
        id: result.taskId,
        title: result.taskId,
        sourceTitle: "Unknown source",
        sourceUrl: "",
      });
    }
  }

  return [...ordered.values()];
}

function sortCaseResultsForReporting(params: {
  caseResults: readonly CaseResult[];
  models: readonly string[];
  tasks: readonly BenchmarkTaskSummary[];
}): readonly CaseResult[] {
  const modelOrder = new Map(params.models.map((model, index) => [model, index]));
  const taskOrder = new Map(params.tasks.map((task, index) => [task.id, index]));
  return [...params.caseResults].sort((a, b) => {
    const aModel = modelOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER;
    const bModel = modelOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER;
    if (aModel !== bModel) {
      return aModel - bModel;
    }
    const aTask = taskOrder.get(a.taskId) ?? Number.MAX_SAFE_INTEGER;
    const bTask = taskOrder.get(b.taskId) ?? Number.MAX_SAFE_INTEGER;
    if (aTask !== bTask) {
      return aTask - bTask;
    }
    return a.runIndex - b.runIndex;
  });
}

function hasGraderInfrastructureError(result: CaseResult): boolean {
  return Boolean(result.grader.error) || result.grader.value === undefined;
}

async function mergeWorkspaceArtifacts(params: {
  tracesLatestRoot: string;
  runRoot: string;
  caseResults: readonly CaseResult[];
}): Promise<void> {
  await mkdir(join(params.tracesLatestRoot, "workspaces"), { recursive: true });
  for (const result of params.caseResults) {
    const fromPath = join(params.runRoot, result.workspacePath);
    const toPath = join(params.tracesLatestRoot, result.workspacePath);
    await rm(toPath, { recursive: true, force: true });
    await mkdir(dirname(toPath), { recursive: true });
    await cp(fromPath, toPath, { recursive: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      models: { type: "string", default: DEFAULT_BENCHMARK_MODELS.join(",") },
      tasks: { type: "string" },
      runs: { type: "string", default: "1" },
      reasoning: { type: "string", default: "medium" },
      "grader-model": { type: "string", default: DEFAULT_GRADER_MODEL },
      "max-steps": { type: "string", default: String(DEFAULT_MAX_STEPS) },
      "estimate-agent-prompt-tokens": { type: "string", default: "4200" },
      "estimate-agent-response-tokens": { type: "string", default: "900" },
      "estimate-grader-prompt-tokens": { type: "string", default: "5200" },
      "estimate-grader-response-tokens": { type: "string", default: "350" },
      "estimate-only": { type: "boolean", default: false },
      "merge-latest": { type: "boolean", default: false },
      "prune-traces": { type: "boolean", default: false },
      "out-dir": { type: "string", default: "benchmarks/agent/results" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const models = parseModelList(values.models ?? DEFAULT_BENCHMARK_MODELS.join(","));
  const tasks = selectTasks(values.tasks);
  const runs = parsePositiveInt(values.runs ?? "1", "--runs");
  const reasoning = parseReasoningEffort(values.reasoning ?? "medium");
  const graderModel = parseModelId(
    (values["grader-model"] ?? DEFAULT_GRADER_MODEL).trim(),
    "--grader-model",
  );
  const maxSteps = parsePositiveInt(
    values["max-steps"] ?? String(DEFAULT_MAX_STEPS),
    "--max-steps",
  );

  const projection = estimateProjection({
    models,
    taskCount: tasks.length,
    runs,
    graderModel,
    agentPromptTokens: parsePositiveInt(
      values["estimate-agent-prompt-tokens"] ?? "4200",
      "--estimate-agent-prompt-tokens",
    ),
    agentResponseTokens: parsePositiveInt(
      values["estimate-agent-response-tokens"] ?? "900",
      "--estimate-agent-response-tokens",
    ),
    graderPromptTokens: parsePositiveInt(
      values["estimate-grader-prompt-tokens"] ?? "5200",
      "--estimate-grader-prompt-tokens",
    ),
    graderResponseTokens: parsePositiveInt(
      values["estimate-grader-response-tokens"] ?? "350",
      "--estimate-grader-response-tokens",
    ),
  });

  console.log(`Models: ${models.join(", ")}`);
  console.log(`Tasks: ${tasks.map((task) => task.id).join(", ")}`);
  console.log(`Runs per model/task: ${runs}`);
  console.log(`Grader model: ${graderModel}`);
  console.log(`Projected cases: ${projection.totalCases}`);
  console.log(`Projected agent cost: $${formatUsd(projection.estimatedAgentCostUsd)}`);
  console.log(`Projected grader cost: $${formatUsd(projection.estimatedGraderCostUsd)}`);
  console.log(`Projected total cost: $${formatUsd(projection.estimatedTotalCostUsd)}`);
  if (values["merge-latest"]) {
    console.log("Merge mode: enabled (patch traces/latest using only this run's cases).");
  }
  const modelReasoningOverrideEntries = Object.entries(MODEL_REASONING_OVERRIDES);
  if (modelReasoningOverrideEntries.length > 0) {
    console.log(
      `Model reasoning overrides: ${modelReasoningOverrideEntries.map(([model, effort]) => `${model}=${effort}`).join(", ")}`,
    );
  }

  if (values["estimate-only"]) {
    return;
  }

  const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
  const promptTemplates = await loadPromptTemplates(benchmarkRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `agent-fs-${timestamp}`;
  const outDir = resolve(values["out-dir"] ?? "benchmarks/agent/results");
  const runRoot = join(outDir, runId);
  await mkdir(runRoot, { recursive: true });

  const modelCaseGroups = await Promise.all(
    models.map(async (model) => {
      const modelResults: CaseResult[] = [];
      const agentReasoning = resolveAgentReasoning(model, reasoning);
      for (const task of tasks) {
        for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
          const result = await runCase({
            model,
            agentReasoning,
            task,
            runIndex,
            outRoot: runRoot,
            benchmarkRoot,
            reasoning,
            graderModel,
            maxSteps,
            promptTemplates,
          });
          modelResults.push(result);

          const status = result.success ? "PASS" : "FAIL";
          const reason = result.success
            ? ""
            : [
                result.agentError ? `agent=${result.agentError}` : undefined,
                !result.schemaPass ? "schema" : undefined,
                !result.toolTracePass ? "tools" : undefined,
                !result.graderPass
                  ? result.grader.error
                    ? `grader=${result.grader.error}`
                    : `grader=${result.grader.value?.verdict ?? "missing"}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" | ");

          console.log(
            `[${status}] ${model} / ${task.id} / run ${runIndex} | ${(result.durationMs / 1000).toFixed(2)}s | $${formatUsd(result.totalCostUsd)}${reason ? ` | ${reason}` : ""}`,
          );
        }
      }
      return modelResults;
    }),
  );

  const caseResults = modelCaseGroups.flat();
  const graderInfrastructureFailures = caseResults.filter(hasGraderInfrastructureError);
  const generatedAt = new Date().toISOString();
  const taskSummaries = tasks.map(toBenchmarkTaskSummary);
  const orderedRunCaseResults = sortCaseResultsForReporting({
    caseResults,
    models,
    tasks: taskSummaries,
  });

  const markdown = buildMarkdownReport({
    runId,
    generatedAt,
    models,
    tasks: taskSummaries,
    runs,
    reasoning,
    graderModel,
    projection,
    caseResults: orderedRunCaseResults,
  });

  const buildSummaryPayload = (params: {
    models: readonly string[];
    tasks: readonly BenchmarkTaskSummary[];
    runs: number;
    reasoning: ReasoningEffort;
    graderModel: string;
    projection: Projection;
    caseResults: readonly CaseResult[];
  }) => ({
    runId,
    generatedAt,
    models: params.models,
    graderModel: params.graderModel,
    reasoning: params.reasoning,
    modelReasoningOverrides: MODEL_REASONING_OVERRIDES,
    tasks: params.tasks,
    runs: params.runs,
    projection: params.projection,
    aggregate: {
      cases: params.caseResults.length,
      success: params.caseResults.filter((entry) => entry.success).length,
      schemaPass: params.caseResults.filter((entry) => entry.schemaPass).length,
      toolTracePass: params.caseResults.filter((entry) => entry.toolTracePass).length,
      graderPass: params.caseResults.filter((entry) => entry.graderPass).length,
      totalDurationMs: params.caseResults.reduce((acc, entry) => acc + entry.durationMs, 0),
      avgDurationMs:
        params.caseResults.length === 0
          ? 0
          : params.caseResults.reduce((acc, entry) => acc + entry.durationMs, 0) /
            params.caseResults.length,
      totalCostUsd: params.caseResults.reduce((acc, entry) => acc + entry.totalCostUsd, 0),
      usage: sumUsageSummaries(params.caseResults.map((entry) => entry.totalUsage)),
      perModelTask: summarizeByModelTaskAcrossRuns({
        models: params.models,
        tasks: params.tasks,
        cases: params.caseResults,
      }),
    },
    results: params.caseResults,
  });

  const summary = buildSummaryPayload({
    models,
    tasks: taskSummaries,
    runs,
    reasoning,
    graderModel,
    projection,
    caseResults: orderedRunCaseResults,
  });

  let latestModels: readonly string[] = models;
  let latestTasks: readonly BenchmarkTaskSummary[] = taskSummaries;
  let latestRuns = runs;
  let latestGraderModel = graderModel;
  let latestReasoning = reasoning;
  let latestCaseResults: readonly CaseResult[] = orderedRunCaseResults;

  if (values["merge-latest"]) {
    const existingSnapshot = await loadLatestSummarySnapshot(benchmarkRoot);
    if (existingSnapshot) {
      latestCaseResults = mergeCaseResults(existingSnapshot.caseResults, latestCaseResults);
      latestModels = mergeModels({
        existingModels: existingSnapshot.models,
        currentModels: models,
        caseResults: latestCaseResults,
      });
      latestTasks = mergeTaskSummaries({
        existingTasks: existingSnapshot.tasks,
        currentTasks: taskSummaries,
        caseResults: latestCaseResults,
      });
      latestRuns = Math.max(
        runs,
        existingSnapshot.runs,
        ...latestCaseResults.map((entry) => entry.runIndex),
      );
      latestGraderModel = isLlmTextModelId(existingSnapshot.graderModel)
        ? existingSnapshot.graderModel
        : graderModel;
      latestReasoning = existingSnapshot.reasoning;
      console.log("Merged this run with existing traces/latest summary.");
    } else {
      console.log(
        "No existing traces/latest/summary.json found; merge mode will publish current run.",
      );
    }
  }

  latestCaseResults = sortCaseResultsForReporting({
    caseResults: latestCaseResults,
    models: latestModels,
    tasks: latestTasks,
  });

  const latestProjection = estimateProjection({
    models: latestModels,
    taskCount: latestTasks.length,
    runs: latestRuns,
    graderModel: latestGraderModel,
    agentPromptTokens: projection.agentPromptTokens,
    agentResponseTokens: projection.agentResponseTokens,
    graderPromptTokens: projection.graderPromptTokens,
    graderResponseTokens: projection.graderResponseTokens,
  });

  const latestSummary = buildSummaryPayload({
    models: latestModels,
    tasks: latestTasks,
    runs: latestRuns,
    reasoning: latestReasoning,
    graderModel: latestGraderModel,
    projection: latestProjection,
    caseResults: latestCaseResults,
  });

  const latestMarkdown = buildMarkdownReport({
    runId,
    generatedAt,
    models: latestModels,
    tasks: latestTasks,
    runs: latestRuns,
    reasoning: latestReasoning,
    graderModel: latestGraderModel,
    projection: latestProjection,
    caseResults: latestCaseResults,
  });

  const latestResultsMarkdown = buildLatestResultsMarkdown({
    runId,
    generatedAt,
    models: latestModels,
    tasks: latestTasks,
    graderModel: latestGraderModel,
    caseResults: latestCaseResults,
  });

  const summaryJsonPath = join(runRoot, "summary.json");
  const summaryMarkdownPath = join(runRoot, "report.md");
  const latestResultsPath = join(benchmarkRoot, "LATEST_RESULTS.md");
  const tracesLatestRoot = join(benchmarkRoot, "traces", "latest");

  await writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(summaryMarkdownPath, markdown);
  await writeFile(latestResultsPath, latestResultsMarkdown);
  if (values["merge-latest"]) {
    await mkdir(tracesLatestRoot, { recursive: true });
    await writeFile(
      join(tracesLatestRoot, "summary.json"),
      `${JSON.stringify(latestSummary, null, 2)}\n`,
    );
    await writeFile(join(tracesLatestRoot, "report.md"), latestMarkdown);
    await mergeWorkspaceArtifacts({
      tracesLatestRoot,
      runRoot,
      caseResults: orderedRunCaseResults,
    });
  } else {
    await rm(tracesLatestRoot, { recursive: true, force: true });
    await mkdir(tracesLatestRoot, { recursive: true });
    await writeFile(
      join(tracesLatestRoot, "summary.json"),
      `${JSON.stringify(latestSummary, null, 2)}\n`,
    );
    await writeFile(join(tracesLatestRoot, "report.md"), latestMarkdown);
    await cp(join(runRoot, "workspaces"), join(tracesLatestRoot, "workspaces"), {
      recursive: true,
    });
  }
  if (values["prune-traces"]) {
    await pruneTraceArtifacts(benchmarkRoot);
  }

  const displaySummaryJsonPath = normalizeSlashes(relative(process.cwd(), summaryJsonPath));
  const displaySummaryMarkdownPath = normalizeSlashes(relative(process.cwd(), summaryMarkdownPath));
  const displayLatestResultsPath = normalizeSlashes(relative(process.cwd(), latestResultsPath));
  const displayLatestTraceRoot = normalizeSlashes(relative(process.cwd(), tracesLatestRoot));
  console.log(`\nWrote: ${displaySummaryJsonPath}`);
  console.log(`Wrote: ${displaySummaryMarkdownPath}`);
  console.log(`Wrote: ${displayLatestResultsPath}`);
  console.log(`Wrote: ${displayLatestTraceRoot}`);
  if (values["merge-latest"]) {
    console.log("Merged run artifacts into existing traces/latest workspaces and reports.");
  }
  if (values["prune-traces"]) {
    console.log("Pruned benchmark traces to keep only traces/latest and traces/README.md");
  }

  if (graderInfrastructureFailures.length > 0) {
    const details = graderInfrastructureFailures
      .map(
        (result) =>
          `${result.model}/${result.taskId}/run ${result.runIndex}: ${result.grader.error ?? "missing grader JSON verdict"}`,
      )
      .join(" | ");
    throw new Error(
      `Grader infrastructure error: failed to produce valid JSON for ${graderInfrastructureFailures.length} case(s). ${details}`,
    );
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
