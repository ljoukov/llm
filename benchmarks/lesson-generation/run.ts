import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
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
  type TaskGraderAspect,
  type ClaimAudit,
  type QuantitativeFindings,
  type AgentBenchmarkTask,
  AGENT_BENCHMARK_TASKS,
} from "./tasks.js";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type BenchmarkVariant = "baseline" | "subagents";

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
  readonly durationMs?: number;
  readonly metrics?: Record<string, unknown>;
  readonly error?: string;
};

type LlmCallTraceRecord = {
  readonly source: "agent" | "grader";
  readonly stage: string;
  readonly model: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly requestSummary: Record<string, unknown>;
  readonly responseSummary: Record<string, unknown>;
};

type StalePhaseDiagnostic = {
  readonly appearsStale: boolean;
  readonly bottleneckStage: string;
  readonly maxCallDurationMs: number;
  readonly notes: readonly string[];
  readonly suggestedFixes: readonly string[];
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

type GraderAspectRun = {
  readonly aspectId: string;
  readonly aspectName: string;
  readonly criteria: string;
  readonly value?: GraderVerdict;
  readonly error?: string;
  readonly costUsd: number;
  readonly usage: UsageSummary;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly requestSummary: Record<string, unknown>;
  readonly responseSummary: Record<string, unknown>;
};

type UsageSummary = {
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly responseTokens: number;
  readonly thinkingTokens: number;
  readonly totalTokens: number;
};

type SubagentUsageSummary = {
  readonly spawnAgentCalls: number;
  readonly sendInputCalls: number;
  readonly waitCalls: number;
  readonly closeAgentCalls: number;
  readonly totalSubagentCalls: number;
  readonly usedSubagents: boolean;
};

type CaseTimingBreakdown = {
  totalWallClockMs: number;
  agentWallClockMs: number;
  graderWallClockMs: number;
  spawnStartupCount: number;
  spawnStartupLatencyMs: number;
  modelQueueWaitMs: number;
  modelConnectionSetupMs: number;
  modelActiveGenerationMs: number;
  modelSchedulerDelayMs: number;
  modelRetryDelayMs: number;
  modelAttempts: number;
  toolExecutionMs: number;
  pollingWaitToolMs: number;
  stepCount: number;
};

type BenchmarkTimingEvent = {
  readonly phase: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly attributes?: Record<string, unknown>;
};

type TimingPhaseAggregate = {
  readonly phase: string;
  readonly count: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number;
};

type CaseResult = {
  readonly model: string;
  readonly variant: BenchmarkVariant;
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
  readonly subagentUsage: SubagentUsageSummary;
  readonly subagentPolicyPass: boolean;
  readonly firstSubagentSpawnStep: number | null;
  readonly llmCallTraces: readonly LlmCallTraceRecord[];
  readonly staleDiagnostic: StalePhaseDiagnostic;
  readonly timing: CaseTimingBreakdown;
  readonly timingEvents: readonly BenchmarkTimingEvent[];
  readonly grader: {
    readonly model: string;
    readonly value?: GraderVerdict;
    readonly error?: string;
    readonly aspects: readonly GraderAspectRun[];
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
  readonly variant: BenchmarkVariant;
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
  readonly avgSubagentCalls: number;
  readonly bestSubagentCalls: number;
  readonly runsUsingSubagents: number;
  readonly avgTiming: CaseTimingBreakdown;
};

type LatestSummarySnapshot = {
  readonly models: readonly string[];
  readonly variants: readonly BenchmarkVariant[];
  readonly tasks: readonly BenchmarkTaskSummary[];
  readonly runs: number;
  readonly graderModel: string;
  readonly reasoning: ReasoningEffort;
  readonly caseResults: readonly CaseResult[];
};

type VariantSpeedupSummary = {
  readonly model: string;
  readonly taskId: string;
  readonly baselineAvgDurationMs: number;
  readonly subagentsAvgDurationMs: number;
  readonly speedupRatio: number;
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
const DEFAULT_MAX_STEPS = 24;
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_GRADER_TIMEOUT_MS = 4 * 60_000;
const MIN_TOOL_CALLS = 3;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const BENCHMARK_VARIANTS: readonly BenchmarkVariant[] = ["subagents"];
const SUBAGENT_TOOL_NAMES = {
  spawn: "spawn_agent",
  sendInput: "send_input",
  wait: "wait",
  close: "close_agent",
} as const;
const MODEL_REASONING_OVERRIDES: Readonly<Record<string, ReasoningEffort>> = {
  "chatgpt-gpt-5.3-codex": "xhigh",
};

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

const DEFAULT_GRADER_ASPECTS: readonly TaskGraderAspect[] = [
  {
    id: "overall",
    name: "Overall Fidelity and Coverage",
    criteria: [
      "- No fabricated quantitative claims.",
      "- Main findings and caveats are covered.",
      "- Claims are calibrated (no overstatement).",
      "- Outputs are coherent and useful for downstream review.",
      "- Line references are valid and map to the numbered source lines where applicable.",
    ].join("\n"),
  },
];

function printUsage(): void {
  console.log(`
Filesystem Agent Benchmark for Spark-style lesson generation/verification.

Usage:
  npx tsx benchmarks/agent/run.ts [options]

Options:
  --models <list>                    Comma-separated model ids (default: ${DEFAULT_BENCHMARK_MODELS.join(",")})
  --tasks <list>                     Comma-separated task ids, or "all" (default: tumor-vaccine-ici)
  --variants <list>                  Comma-separated variants: ${BENCHMARK_VARIANTS.join(",")} (default: ${BENCHMARK_VARIANTS.join(",")})
  --variant <name>                   Single variant alias for --variants
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

function isBenchmarkVariant(value: string): value is BenchmarkVariant {
  return (BENCHMARK_VARIANTS as readonly string[]).includes(value);
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

function parseBenchmarkVariants(raw: string): readonly BenchmarkVariant[] {
  return parseCsvList(raw).map((entry) => {
    if (isBenchmarkVariant(entry)) {
      return entry;
    }
    throw new Error(
      `Invalid --variants value: ${entry}. Supported variants: ${BENCHMARK_VARIANTS.join(", ")}`,
    );
  });
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

async function resolveTaskPromptTemplates(params: {
  benchmarkRoot: string;
  task: AgentBenchmarkTask;
  defaults: PromptTemplates;
}): Promise<PromptTemplates> {
  const overrides = params.task.promptOverrides;
  if (!overrides) {
    return params.defaults;
  }

  const readOverride = async (
    relativePath: string | undefined,
    fallback: string,
  ): Promise<string> => {
    if (!relativePath) {
      return fallback;
    }
    return readFile(join(params.benchmarkRoot, relativePath), "utf8");
  };

  const [agentPrompt, taskTemplate, graderPrompt] = await Promise.all([
    readOverride(overrides.agentPromptFile, params.defaults.agentPrompt),
    readOverride(overrides.taskTemplateFile, params.defaults.taskTemplate),
    readOverride(overrides.graderPromptFile, params.defaults.graderPrompt),
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

function emptyStalePhaseDiagnostic(): StalePhaseDiagnostic {
  return {
    appearsStale: false,
    bottleneckStage: "none",
    maxCallDurationMs: 0,
    notes: [],
    suggestedFixes: [],
  };
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : 0;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value > 0 ? value : 0;
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

function emptySubagentUsageSummary(): SubagentUsageSummary {
  return {
    spawnAgentCalls: 0,
    sendInputCalls: 0,
    waitCalls: 0,
    closeAgentCalls: 0,
    totalSubagentCalls: 0,
    usedSubagents: false,
  };
}

function summarizeSubagentUsageFromCalls(calls: readonly ToolCallTrace[]): SubagentUsageSummary {
  let spawnAgentCalls = 0;
  let sendInputCalls = 0;
  let waitCalls = 0;
  let closeAgentCalls = 0;

  for (const call of calls) {
    if (call.toolName === SUBAGENT_TOOL_NAMES.spawn) {
      spawnAgentCalls += 1;
      continue;
    }
    if (call.toolName === SUBAGENT_TOOL_NAMES.sendInput) {
      sendInputCalls += 1;
      continue;
    }
    if (call.toolName === SUBAGENT_TOOL_NAMES.wait) {
      waitCalls += 1;
      continue;
    }
    if (call.toolName === SUBAGENT_TOOL_NAMES.close) {
      closeAgentCalls += 1;
    }
  }

  const totalSubagentCalls = spawnAgentCalls + sendInputCalls + waitCalls + closeAgentCalls;
  return {
    spawnAgentCalls,
    sendInputCalls,
    waitCalls,
    closeAgentCalls,
    totalSubagentCalls,
    usedSubagents: totalSubagentCalls > 0,
  };
}

function findFirstSpawnStep(steps: readonly LlmToolLoopStep[]): number | null {
  let first: number | null = null;
  for (const step of steps) {
    if (!step.toolCalls.some((call) => call.toolName === SUBAGENT_TOOL_NAMES.spawn)) {
      continue;
    }
    if (first === null || step.step < first) {
      first = step.step;
    }
  }
  return first;
}

function parseSubagentUsageSummary(value: unknown): SubagentUsageSummary {
  if (typeof value !== "object" || value === null) {
    return emptySubagentUsageSummary();
  }
  const summary = value as {
    spawnAgentCalls?: unknown;
    sendInputCalls?: unknown;
    waitCalls?: unknown;
    closeAgentCalls?: unknown;
    totalSubagentCalls?: unknown;
    usedSubagents?: unknown;
  };
  const spawnAgentCalls = toNonNegativeInt(summary.spawnAgentCalls);
  const sendInputCalls = toNonNegativeInt(summary.sendInputCalls);
  const waitCalls = toNonNegativeInt(summary.waitCalls);
  const closeAgentCalls = toNonNegativeInt(summary.closeAgentCalls);
  const fallbackTotal = spawnAgentCalls + sendInputCalls + waitCalls + closeAgentCalls;
  const totalSubagentCalls = toNonNegativeInt(summary.totalSubagentCalls) || fallbackTotal;
  const usedSubagents =
    typeof summary.usedSubagents === "boolean" ? summary.usedSubagents : totalSubagentCalls > 0;

  return {
    spawnAgentCalls,
    sendInputCalls,
    waitCalls,
    closeAgentCalls,
    totalSubagentCalls,
    usedSubagents,
  };
}

function emptyCaseTimingBreakdown(): CaseTimingBreakdown {
  return {
    totalWallClockMs: 0,
    agentWallClockMs: 0,
    graderWallClockMs: 0,
    spawnStartupCount: 0,
    spawnStartupLatencyMs: 0,
    modelQueueWaitMs: 0,
    modelConnectionSetupMs: 0,
    modelActiveGenerationMs: 0,
    modelSchedulerDelayMs: 0,
    modelRetryDelayMs: 0,
    modelAttempts: 0,
    toolExecutionMs: 0,
    pollingWaitToolMs: 0,
    stepCount: 0,
  };
}

function sumTimingBreakdowns(values: readonly CaseTimingBreakdown[]): CaseTimingBreakdown {
  const total = emptyCaseTimingBreakdown();
  for (const value of values) {
    total.totalWallClockMs += value.totalWallClockMs;
    total.agentWallClockMs += value.agentWallClockMs;
    total.graderWallClockMs += value.graderWallClockMs;
    total.spawnStartupCount += value.spawnStartupCount;
    total.spawnStartupLatencyMs += value.spawnStartupLatencyMs;
    total.modelQueueWaitMs += value.modelQueueWaitMs;
    total.modelConnectionSetupMs += value.modelConnectionSetupMs;
    total.modelActiveGenerationMs += value.modelActiveGenerationMs;
    total.modelSchedulerDelayMs += value.modelSchedulerDelayMs;
    total.modelRetryDelayMs += value.modelRetryDelayMs;
    total.modelAttempts += value.modelAttempts;
    total.toolExecutionMs += value.toolExecutionMs;
    total.pollingWaitToolMs += value.pollingWaitToolMs;
    total.stepCount += value.stepCount;
  }
  return total;
}

function averageTimingBreakdown(
  values: readonly CaseTimingBreakdown[],
  count: number,
): CaseTimingBreakdown {
  if (count <= 0 || values.length === 0) {
    return emptyCaseTimingBreakdown();
  }
  const total = sumTimingBreakdowns(values);
  return {
    totalWallClockMs: total.totalWallClockMs / count,
    agentWallClockMs: total.agentWallClockMs / count,
    graderWallClockMs: total.graderWallClockMs / count,
    spawnStartupCount: total.spawnStartupCount / count,
    spawnStartupLatencyMs: total.spawnStartupLatencyMs / count,
    modelQueueWaitMs: total.modelQueueWaitMs / count,
    modelConnectionSetupMs: total.modelConnectionSetupMs / count,
    modelActiveGenerationMs: total.modelActiveGenerationMs / count,
    modelSchedulerDelayMs: total.modelSchedulerDelayMs / count,
    modelRetryDelayMs: total.modelRetryDelayMs / count,
    modelAttempts: total.modelAttempts / count,
    toolExecutionMs: total.toolExecutionMs / count,
    pollingWaitToolMs: total.pollingWaitToolMs / count,
    stepCount: total.stepCount / count,
  };
}

function parseSpawnStartupLatencyFromCall(call: {
  readonly toolName: string;
  readonly output: unknown;
  readonly metrics?: Record<string, unknown>;
}): number | undefined {
  if (call.toolName !== SUBAGENT_TOOL_NAMES.spawn) {
    return undefined;
  }
  const metricLatency = toNonNegativeNumber(call.metrics?.spawnStartupLatencyMs);
  if (metricLatency > 0) {
    return metricLatency;
  }
  const outputRecord = asJsonRecord(call.output);
  const agentRecord = outputRecord ? asJsonRecord(outputRecord.agent) : undefined;
  if (!agentRecord) {
    return undefined;
  }
  const latency = toNonNegativeNumber(agentRecord.spawn_startup_latency_ms);
  return latency > 0 ? latency : undefined;
}

function computeTimingBreakdownFromSteps(
  steps: readonly LlmToolLoopStep[],
  durationMs: number,
  agentDurationMs: number,
  graderDurationMs: number,
): CaseTimingBreakdown {
  const timing = emptyCaseTimingBreakdown();
  timing.totalWallClockMs = Math.max(0, durationMs);
  timing.agentWallClockMs = Math.max(0, agentDurationMs);
  timing.graderWallClockMs = Math.max(0, graderDurationMs);
  timing.stepCount = steps.length;

  for (const step of steps) {
    if (step.timing) {
      timing.modelQueueWaitMs += toNonNegativeNumber(step.timing.queueWaitMs);
      timing.modelConnectionSetupMs += toNonNegativeNumber(step.timing.connectionSetupMs);
      timing.modelActiveGenerationMs += toNonNegativeNumber(step.timing.activeGenerationMs);
      timing.modelSchedulerDelayMs += toNonNegativeNumber(step.timing.schedulerDelayMs);
      timing.modelRetryDelayMs += toNonNegativeNumber(step.timing.providerRetryDelayMs);
      timing.modelAttempts += toNonNegativeNumber(step.timing.providerAttempts);
      timing.toolExecutionMs += toNonNegativeNumber(step.timing.toolExecutionMs);
      timing.pollingWaitToolMs += toNonNegativeNumber(step.timing.waitToolMs);
    }
    for (const call of step.toolCalls) {
      const startupLatency = parseSpawnStartupLatencyFromCall(call);
      if (startupLatency === undefined) {
        continue;
      }
      timing.spawnStartupCount += 1;
      timing.spawnStartupLatencyMs += startupLatency;
    }
  }

  return timing;
}

function truncatePreview(value: string, limit = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit - 3)}...`;
}

function buildAgentLlmCallTraces(
  model: string,
  steps: readonly LlmToolLoopStep[],
): readonly LlmCallTraceRecord[] {
  const traces: LlmCallTraceRecord[] = [];
  for (const step of steps) {
    if (!step.timing) {
      continue;
    }
    traces.push({
      source: "agent",
      stage: `agent.step.${step.step}`,
      model,
      startedAt: step.timing.startedAt,
      completedAt: step.timing.completedAt,
      durationMs: toNonNegativeNumber(step.timing.totalMs),
      requestSummary: {
        step: step.step,
        promptTokens: toNonNegativeInt(step.usage?.promptTokens),
        cachedTokens: toNonNegativeInt(step.usage?.cachedTokens),
        toolCallBudgetHint: "filesystem+subagents",
      },
      responseSummary: {
        responseTokens: toNonNegativeInt(step.usage?.responseTokens),
        thinkingTokens: toNonNegativeInt(step.usage?.thinkingTokens),
        toolCalls: step.toolCalls.length,
        tools: [...new Set(step.toolCalls.map((call) => call.toolName))],
        thoughtsPreview:
          typeof step.thoughts === "string" && step.thoughts.trim().length > 0
            ? truncatePreview(step.thoughts)
            : "",
        textPreview:
          typeof step.text === "string" && step.text.trim().length > 0
            ? truncatePreview(step.text)
            : "",
      },
    });
  }
  return traces;
}

function detectStalePhase(callTraces: readonly LlmCallTraceRecord[]): StalePhaseDiagnostic {
  if (callTraces.length === 0) {
    return emptyStalePhaseDiagnostic();
  }
  let max = callTraces[0];
  if (!max) {
    return emptyStalePhaseDiagnostic();
  }
  for (const trace of callTraces.slice(1)) {
    if (trace.durationMs > max.durationMs) {
      max = trace;
    }
  }
  const appearsStale = max.durationMs >= 90_000;
  const notes: string[] = [];
  const suggestedFixes: string[] = [];
  if (appearsStale) {
    notes.push(
      `Longest LLM call exceeded 90s at ${max.stage} (${(max.durationMs / 1000).toFixed(2)}s).`,
    );
    if (max.source === "agent") {
      suggestedFixes.push(
        "Reduce per-step generation scope: batch deterministic writes and avoid iterative rewrite loops.",
      );
      suggestedFixes.push(
        "Delegate heavy independent outputs to subagents earlier and cap each subagent step budget.",
      );
    } else {
      suggestedFixes.push(
        "Trim grader prompt payload and keep outputs concise to reduce per-call latency.",
      );
    }
  } else {
    notes.push("No stale phases detected (no single LLM call exceeded 90s).");
  }
  return {
    appearsStale,
    bottleneckStage: max.stage,
    maxCallDurationMs: max.durationMs,
    notes,
    suggestedFixes,
  };
}

function parseCaseTimingBreakdown(value: unknown): CaseTimingBreakdown {
  if (typeof value !== "object" || value === null) {
    return emptyCaseTimingBreakdown();
  }
  const timing = value as Partial<CaseTimingBreakdown>;
  return {
    totalWallClockMs: toNonNegativeNumber(timing.totalWallClockMs),
    agentWallClockMs: toNonNegativeNumber(timing.agentWallClockMs),
    graderWallClockMs: toNonNegativeNumber(timing.graderWallClockMs),
    spawnStartupCount: toNonNegativeNumber(timing.spawnStartupCount),
    spawnStartupLatencyMs: toNonNegativeNumber(timing.spawnStartupLatencyMs),
    modelQueueWaitMs: toNonNegativeNumber(timing.modelQueueWaitMs),
    modelConnectionSetupMs: toNonNegativeNumber(timing.modelConnectionSetupMs),
    modelActiveGenerationMs: toNonNegativeNumber(timing.modelActiveGenerationMs),
    modelSchedulerDelayMs: toNonNegativeNumber(timing.modelSchedulerDelayMs),
    modelRetryDelayMs: toNonNegativeNumber(timing.modelRetryDelayMs),
    modelAttempts: toNonNegativeNumber(timing.modelAttempts),
    toolExecutionMs: toNonNegativeNumber(timing.toolExecutionMs),
    pollingWaitToolMs: toNonNegativeNumber(timing.pollingWaitToolMs),
    stepCount: toNonNegativeNumber(timing.stepCount),
  };
}

function parseTimingEvents(value: unknown): readonly BenchmarkTimingEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: BenchmarkTimingEvent[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const event = item as Record<string, unknown>;
    const phase = typeof event.phase === "string" ? event.phase.trim() : "";
    const startedAt = typeof event.startedAt === "string" ? event.startedAt : "";
    const completedAt = typeof event.completedAt === "string" ? event.completedAt : "";
    if (!phase || !startedAt || !completedAt) {
      continue;
    }
    events.push({
      phase,
      startedAt,
      completedAt,
      durationMs: toNonNegativeNumber(event.durationMs),
      success: typeof event.success === "boolean" ? event.success : true,
      ...(asJsonRecord(event.attributes) ? { attributes: asJsonRecord(event.attributes) } : {}),
    });
  }
  return events;
}

function summarizeTimingPhases(
  caseResults: readonly {
    readonly timingEvents?: readonly BenchmarkTimingEvent[];
  }[],
): readonly TimingPhaseAggregate[] {
  const phaseMap = new Map<
    string,
    {
      count: number;
      successCount: number;
      totalDurationMs: number;
    }
  >();

  for (const entry of caseResults) {
    const events = entry.timingEvents;
    if (!events) {
      continue;
    }
    for (const event of events) {
      const phase = event.phase.trim();
      if (!phase) {
        continue;
      }
      const current = phaseMap.get(phase) ?? { count: 0, successCount: 0, totalDurationMs: 0 };
      current.count += 1;
      if (event.success) {
        current.successCount += 1;
      }
      current.totalDurationMs += toNonNegativeNumber(event.durationMs);
      phaseMap.set(phase, current);
    }
  }

  return [...phaseMap.entries()]
    .map(([phase, value]) => ({
      phase,
      count: value.count,
      successCount: value.successCount,
      failureCount: Math.max(0, value.count - value.successCount),
      totalDurationMs: value.totalDurationMs,
      avgDurationMs: value.count > 0 ? value.totalDurationMs / value.count : 0,
    }))
    .sort((a, b) => (a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : 0));
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
  if (!spec.schema) {
    throw new Error(`Missing zod schema for output spec: ${spec.outputFile}`);
  }
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

async function resolveSchemaDocumentForSpec(params: {
  spec: OutputFileSpec;
  benchmarkRoot: string;
}): Promise<JsonRecord> {
  if (params.spec.schemaSourceFile) {
    const raw = await readFile(join(params.benchmarkRoot, params.spec.schemaSourceFile), "utf8");
    const parsed = JSON.parse(raw);
    const record = asJsonRecord(parsed);
    if (!record) {
      throw new Error(
        `Schema source file must contain a JSON object: ${params.spec.schemaSourceFile}`,
      );
    }
    return record;
  }
  if (params.spec.schema) {
    return toSchemaDocument(params.spec);
  }
  throw new Error(
    `Output spec must define either schema or schemaSourceFile: ${params.spec.outputFile}`,
  );
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

  const reportPath = params.task.reportPath ?? "input/report.md";
  await mkdir(dirname(join(params.workspaceRootAbs, reportPath)), { recursive: true });
  await writeFile(join(params.workspaceRootAbs, reportPath), reportText);

  for (const spec of params.task.outputFileSpecs) {
    const schemaPath = spec.schemaFile;
    const outputPath = spec.outputFile;

    await mkdir(dirname(join(params.workspaceRootAbs, schemaPath)), { recursive: true });
    await mkdir(dirname(join(params.workspaceRootAbs, outputPath)), { recursive: true });

    const schemaDocument = await resolveSchemaDocumentForSpec({
      spec,
      benchmarkRoot: params.benchmarkRoot,
    });
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
function buildAgentPrompt(
  layout: WorkspaceLayout,
  template: string,
  variant: BenchmarkVariant,
): string {
  const basePrompt = renderTemplate(template, {
    TASK_FILE: layout.taskFilePath,
  });
  if (variant !== "subagents") {
    return basePrompt;
  }
  const delegationDirective = [
    "",
    "Subagent mode is enabled for this run. You must delegate part of the work.",
    "Hard gate: this benchmark case fails automatically if you do not call `spawn_agent` at least once.",
    "Required delegation pattern:",
    "- Spawn at least two subagents with focused prompts using `spawn_agent`.",
    "- Wait for each delegated agent with `wait` until it is no longer running.",
    "- Close each delegated agent with `close_agent` after collecting its result.",
    "- Integrate delegated results and still satisfy every output schema.",
  ].join("\n");
  return `${basePrompt}\n${delegationDirective}`;
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
        timestamp: call.startedAt,
        durationMs: call.durationMs,
        metrics: call.metrics,
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

const LESSON_PLAN_ITEM_EXPECTATIONS: ReadonlyArray<{
  readonly id: string;
  readonly kind: "quiz" | "coding_problem";
}> = [
  { id: "quiz-1", kind: "quiz" },
  { id: "problem-1", kind: "coding_problem" },
  { id: "quiz-2", kind: "quiz" },
  { id: "problem-2", kind: "coding_problem" },
  { id: "quiz-3", kind: "quiz" },
  { id: "problem-3", kind: "coding_problem" },
  { id: "quiz-4", kind: "quiz" },
];

const SAFE_HAVEN_SAMPLE_CASE = {
  input: "3 5 5",
  output: "2 1",
} as const;

const SAFE_HAVEN_HIDDEN_CASES = [
  { input: "1 100 200", output: "1 0" },
  { input: "2 1 1", output: "1 1" },
  { input: "2 7 23", output: "1 0" },
  { input: "4 8 94", output: "3 3" },
  { input: "6 213 1040", output: "3 6" },
  { input: "7 2025 7", output: "7 6" },
  { input: "8 19 22", output: "4 10" },
  { input: "9 510 4152", output: "9 5" },
  { input: "10 3548 872", output: "9 15" },
  { input: "10 4999 4999", output: "5 8" },
] as const;

type LessonAlignmentPair = {
  readonly quizFile: string;
  readonly problemFile: string;
  readonly label: string;
  readonly minTopicMatches: number;
  readonly minPrereqMatches: number;
  readonly referencePhrases: readonly string[];
};

const LESSON_ALIGNMENT_PAIRS: readonly LessonAlignmentPair[] = [
  {
    quizFile: "lesson/output/quiz/quiz-1.json",
    problemFile: "lesson/output/code/problem-1.json",
    label: "quiz-1 -> problem-1",
    minTopicMatches: 2,
    minPrereqMatches: 3,
    referencePhrases: ["problem 1", "problem-1", "intro bio"],
  },
  {
    quizFile: "lesson/output/quiz/quiz-2.json",
    problemFile: "lesson/output/code/problem-2.json",
    label: "quiz-2 -> problem-2",
    minTopicMatches: 2,
    minPrereqMatches: 3,
    referencePhrases: ["problem 2", "problem-2", "intermediate bio"],
  },
  {
    quizFile: "lesson/output/quiz/quiz-3.json",
    problemFile: "lesson/output/code/problem-3.json",
    label: "quiz-3 -> problem-3",
    minTopicMatches: 2,
    minPrereqMatches: 3,
    referencePhrases: ["problem 3", "problem-3", "safe haven", "final bio"],
  },
  {
    quizFile: "lesson/output/quiz/quiz-4.json",
    problemFile: "lesson/output/code/problem-3.json",
    label: "quiz-4 -> problem-3",
    minTopicMatches: 1,
    minPrereqMatches: 3,
    referencePhrases: ["problem 3", "problem-3", "safe haven", "final bio"],
  },
] as const;

const LESSON_ALIGNMENT_SHORT_TOKENS = new Set(["io", "dfs", "bfs", "dp", "uf", "n2"]);
const LESSON_ALIGNMENT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "to",
  "up",
  "use",
  "uses",
  "using",
  "with",
  "you",
  "your",
  "will",
  "must",
  "should",
  "could",
  "would",
  "problem",
  "quiz",
  "lesson",
  "student",
  "students",
  "coding",
  "code",
  "task",
  "final",
  "first",
  "second",
  "third",
  "fourth",
  "intro",
  "intermediate",
  "review",
  "reflection",
  "prepare",
  "prep",
  "learn",
  "learning",
  "practice",
  "theory",
  "question",
  "questions",
  "prompt",
  "choice",
  "answer",
  "answers",
  "true",
  "false",
  "where",
  "when",
  "what",
  "which",
  "whose",
  "while",
  "after",
  "before",
  "between",
  "until",
  "through",
  "across",
  "over",
  "under",
  "than",
  "also",
  "each",
  "every",
  "any",
  "all",
  "some",
  "more",
  "most",
  "least",
  "very",
  "only",
  "same",
  "new",
  "old",
  "main",
  "key",
  "part",
  "parts",
  "step",
  "steps",
  "example",
  "examples",
  "input",
  "output",
]);

type LessonQuizAlignmentContext = {
  readonly headerText: string;
  readonly fullText: string;
  readonly tokenSet: ReadonlySet<string>;
  readonly questionTexts: readonly string[];
  readonly questionTokenSets: readonly ReadonlySet<string>[];
};

type LessonProblemAlignmentContext = {
  readonly topicPhrases: readonly string[];
  readonly prereqTokens: readonly string[];
};

function normalizeAlignmentText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeAlignmentText(value: string): readonly string[] {
  const normalized = normalizeAlignmentText(value);
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split(" ").filter((token) => token.length > 0);
}

function isAlignmentTokenMeaningful(token: string): boolean {
  if (LESSON_ALIGNMENT_SHORT_TOKENS.has(token)) {
    return true;
  }
  if (token.length < 4) {
    return false;
  }
  if (LESSON_ALIGNMENT_STOPWORDS.has(token)) {
    return false;
  }
  return true;
}

function collectStringValues(value: unknown): readonly string[] {
  const strings: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      if (current.trim().length > 0) {
        strings.push(current);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }
    if (typeof current !== "object" || current === null) {
      return;
    }
    for (const valueItem of Object.values(current)) {
      visit(valueItem);
    }
  };
  visit(value);
  return strings;
}

function containsNormalizedPhrase(text: string, phrase: string): boolean {
  if (text.length === 0 || phrase.length === 0) {
    return false;
  }
  const paddedText = ` ${text} `;
  const normalizedPhrase = normalizeAlignmentText(phrase);
  if (normalizedPhrase.length === 0) {
    return false;
  }
  return paddedText.includes(` ${normalizedPhrase} `);
}

function collectQuestionTexts(quizValue: unknown): readonly string[] {
  if (typeof quizValue !== "object" || quizValue === null) {
    return [];
  }
  const questions = (quizValue as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  const results: string[] = [];
  for (const question of questions) {
    const fragments = collectStringValues(question);
    if (fragments.length === 0) {
      continue;
    }
    const normalized = normalizeAlignmentText(fragments.join(" "));
    if (normalized.length > 0) {
      results.push(normalized);
    }
  }
  return results;
}

function buildLessonQuizAlignmentContext(quizValue: unknown): LessonQuizAlignmentContext {
  if (typeof quizValue !== "object" || quizValue === null) {
    return {
      headerText: "",
      fullText: "",
      tokenSet: new Set<string>(),
      questionTexts: [],
      questionTokenSets: [],
    };
  }
  const objectValue = quizValue as {
    title?: unknown;
    description?: unknown;
    gradingPrompt?: unknown;
  };
  const headerPieces: string[] = [];
  if (typeof objectValue.title === "string") {
    headerPieces.push(objectValue.title);
  }
  if (typeof objectValue.description === "string") {
    headerPieces.push(objectValue.description);
  }
  if (typeof objectValue.gradingPrompt === "string") {
    headerPieces.push(objectValue.gradingPrompt);
  }
  const headerText = normalizeAlignmentText(headerPieces.join(" "));
  const questionTexts = collectQuestionTexts(quizValue);
  const fullTextParts = [headerText, ...questionTexts].filter((part) => part.length > 0);
  const fullText = fullTextParts.join(" ");
  const tokenSet = new Set(tokenizeAlignmentText(fullText));
  const questionTokenSets = questionTexts.map((questionText) => new Set(tokenizeAlignmentText(questionText)));
  return {
    headerText,
    fullText,
    tokenSet,
    questionTexts,
    questionTokenSets,
  };
}

function buildLessonProblemAlignmentContext(problemValue: unknown): LessonProblemAlignmentContext {
  if (typeof problemValue !== "object" || problemValue === null) {
    return { topicPhrases: [], prereqTokens: [] };
  }
  const objectValue = problemValue as {
    title?: unknown;
    description?: unknown;
    inputFormat?: unknown;
    topics?: unknown;
    constraints?: unknown;
    hints?: unknown;
    examples?: unknown;
  };
  const topicPhrases = Array.isArray(objectValue.topics)
    ? objectValue.topics
        .filter((topic): topic is string => typeof topic === "string")
        .map((topic) => normalizeAlignmentText(topic))
        .filter((topic) => topic.length > 0)
    : [];

  const sourceParts: string[] = [];
  if (typeof objectValue.title === "string") {
    sourceParts.push(objectValue.title);
  }
  if (typeof objectValue.description === "string") {
    sourceParts.push(objectValue.description);
  }
  if (typeof objectValue.inputFormat === "string") {
    sourceParts.push(objectValue.inputFormat);
  }
  if (Array.isArray(objectValue.constraints)) {
    for (const item of objectValue.constraints) {
      if (typeof item === "string") {
        sourceParts.push(item);
      }
    }
  }
  if (Array.isArray(objectValue.hints)) {
    for (const item of objectValue.hints) {
      if (typeof item === "string") {
        sourceParts.push(item);
      }
    }
  }
  if (Array.isArray(objectValue.examples)) {
    for (const example of objectValue.examples) {
      if (typeof example !== "object" || example === null) {
        continue;
      }
      const explanation = (example as { explanation?: unknown }).explanation;
      if (typeof explanation === "string") {
        sourceParts.push(explanation);
      }
    }
  }

  const frequency = new Map<string, number>();
  for (const part of sourceParts) {
    for (const token of tokenizeAlignmentText(part)) {
      if (!isAlignmentTokenMeaningful(token)) {
        continue;
      }
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  for (const topicPhrase of topicPhrases) {
    for (const token of tokenizeAlignmentText(topicPhrase)) {
      if (!isAlignmentTokenMeaningful(token)) {
        continue;
      }
      frequency.set(token, (frequency.get(token) ?? 0) + 2);
    }
  }

  const prereqTokens = [...frequency.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 24)
    .map(([token]) => token);

  return { topicPhrases, prereqTokens };
}

function matchPhrasesInText(text: string, phrases: readonly string[]): readonly string[] {
  const uniqueMatches = new Set<string>();
  for (const phrase of phrases) {
    if (containsNormalizedPhrase(text, phrase)) {
      uniqueMatches.add(normalizeAlignmentText(phrase));
    }
  }
  return [...uniqueMatches];
}

function matchTokensInSet(tokens: ReadonlySet<string>, candidates: readonly string[]): readonly string[] {
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (tokens.has(candidate)) {
      matches.push(candidate);
    }
  }
  return matches;
}

function safeParseValidationContent(validation: OutputValidation): unknown | undefined {
  if (!validation.content) {
    return undefined;
  }
  try {
    return JSON.parse(validation.content);
  } catch {
    return undefined;
  }
}

function validateLessonQuizCodingAlignment(
  validations: readonly OutputValidation[],
): ReadonlyMap<string, readonly string[]> {
  const errorsByFile = new Map<string, string[]>();
  const validationsByFile = new Map(validations.map((validation) => [validation.outputFile, validation]));
  const parsedByFile = new Map<string, unknown>();

  for (const pair of LESSON_ALIGNMENT_PAIRS) {
    const quizValidation = validationsByFile.get(pair.quizFile);
    const problemValidation = validationsByFile.get(pair.problemFile);
    if (
      !quizValidation ||
      !problemValidation ||
      !quizValidation.exists ||
      !problemValidation.exists ||
      !quizValidation.jsonValid ||
      !problemValidation.jsonValid ||
      !quizValidation.schemaValid ||
      !problemValidation.schemaValid
    ) {
      continue;
    }
    const quizParsed =
      parsedByFile.get(pair.quizFile) ?? safeParseValidationContent(quizValidation);
    const problemParsed =
      parsedByFile.get(pair.problemFile) ?? safeParseValidationContent(problemValidation);
    if (quizParsed === undefined || problemParsed === undefined) {
      continue;
    }
    parsedByFile.set(pair.quizFile, quizParsed);
    parsedByFile.set(pair.problemFile, problemParsed);

    const quizContext = buildLessonQuizAlignmentContext(quizParsed);
    const problemContext = buildLessonProblemAlignmentContext(problemParsed);
    const pairErrors: string[] = [];

    const referenceMatched = pair.referencePhrases.some((phrase) =>
      containsNormalizedPhrase(quizContext.headerText, phrase),
    );
    if (!referenceMatched) {
      pairErrors.push(
        `[alignment ${pair.label}] quiz header must explicitly reference the paired coding problem.`,
      );
    }

    const matchedTopics = matchPhrasesInText(quizContext.fullText, problemContext.topicPhrases);
    const requiredTopicMatches = Math.min(problemContext.topicPhrases.length, pair.minTopicMatches);
    if (requiredTopicMatches > 0 && matchedTopics.length < requiredTopicMatches) {
      pairErrors.push(
        `[alignment ${pair.label}] quiz covers ${matchedTopics.length}/${requiredTopicMatches} required problem topics.`,
      );
    }

    const matchedPrereqTokens = matchTokensInSet(quizContext.tokenSet, problemContext.prereqTokens);
    const requiredPrereqMatches = Math.min(problemContext.prereqTokens.length, pair.minPrereqMatches);
    if (requiredPrereqMatches > 0 && matchedPrereqTokens.length < requiredPrereqMatches) {
      pairErrors.push(
        `[alignment ${pair.label}] quiz covers ${matchedPrereqTokens.length}/${requiredPrereqMatches} prerequisite/tricky concepts from the coding problem.`,
      );
    }

    const hasRequirementFocusedQuestion = quizContext.questionTokenSets.some((tokenSet) => {
      const matches = matchTokensInSet(tokenSet, problemContext.prereqTokens);
      return matches.length > 0;
    });
    if (!hasRequirementFocusedQuestion) {
      pairErrors.push(
        `[alignment ${pair.label}] quiz needs at least one requirement-focused question derived from paired coding constraints/hints.`,
      );
    }

    const hasTopicFocusedQuestion = quizContext.questionTexts.some((questionText) => {
      const matches = matchPhrasesInText(questionText, problemContext.topicPhrases);
      return matches.length > 0;
    });
    if (!hasTopicFocusedQuestion) {
      pairErrors.push(
        `[alignment ${pair.label}] quiz needs at least one question directly targeting a paired coding topic.`,
      );
    }

    if (pairErrors.length > 0) {
      errorsByFile.set(pair.quizFile, pairErrors);
    }
  }

  return errorsByFile;
}

function applyCrossFileValidationErrors(params: {
  validations: readonly OutputValidation[];
  errorsByFile: ReadonlyMap<string, readonly string[]>;
}): readonly OutputValidation[] {
  if (params.errorsByFile.size === 0) {
    return params.validations;
  }
  return params.validations.map((validation) => {
    const extraErrors = params.errorsByFile.get(validation.outputFile);
    if (!extraErrors || extraErrors.length === 0) {
      return validation;
    }
    return {
      ...validation,
      groundingValid: false,
      errors: [...validation.errors, ...extraErrors],
    };
  });
}

function normalizeIoText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseCodeIoCases(value: unknown): {
  readonly examples: readonly { input: string; output: string }[];
  readonly tests: readonly { input: string; output: string }[];
} {
  if (typeof value !== "object" || value === null) {
    return { examples: [], tests: [] };
  }
  const objectValue = value as {
    examples?: unknown;
    tests?: unknown;
  };

  const toCases = (source: unknown): { input: string; output: string }[] => {
    if (!Array.isArray(source)) {
      return [];
    }
    const cases: { input: string; output: string }[] = [];
    for (const item of source) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const input = (item as { input?: unknown }).input;
      const output = (item as { output?: unknown }).output;
      if (typeof input !== "string" || typeof output !== "string") {
        continue;
      }
      cases.push({ input, output });
    }
    return cases;
  };

  return {
    examples: toCases(objectValue.examples),
    tests: toCases(objectValue.tests),
  };
}

function hasIoCase(
  cases: readonly { input: string; output: string }[],
  target: { input: string; output: string },
): boolean {
  const expectedInput = normalizeIoText(target.input);
  const expectedOutput = normalizeIoText(target.output);
  return cases.some(
    (item) =>
      normalizeIoText(item.input) === expectedInput &&
      normalizeIoText(item.output) === expectedOutput,
  );
}

function validateLessonSession(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["Session output must be an object."];
  }
  const plan = (value as { plan?: unknown }).plan;
  if (!Array.isArray(plan)) {
    return ["Session output must include plan[]."];
  }
  if (plan.length !== LESSON_PLAN_ITEM_EXPECTATIONS.length) {
    errors.push(
      `Session plan length must be ${LESSON_PLAN_ITEM_EXPECTATIONS.length}, got ${plan.length}.`,
    );
    return errors;
  }

  for (const [index, expected] of LESSON_PLAN_ITEM_EXPECTATIONS.entries()) {
    const item = plan[index];
    if (typeof item !== "object" || item === null) {
      errors.push(`Plan item ${index + 1} must be an object.`);
      continue;
    }
    const id = (item as { id?: unknown }).id;
    const kind = (item as { kind?: unknown }).kind;
    if (id !== expected.id) {
      errors.push(`Plan item ${index + 1} id must be "${expected.id}".`);
    }
    if (kind !== expected.kind) {
      errors.push(`Plan item ${index + 1} kind must be "${expected.kind}".`);
    }
  }

  return errors;
}

function validateLessonQuiz(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["Quiz output must be an object."];
  }
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return ["Quiz output must include questions[]."];
  }
  if (questions.length !== 18) {
    errors.push(`Quiz must contain exactly 18 questions, got ${questions.length}.`);
  }

  let infoCards = 0;
  let multipleChoice = 0;
  let typeAnswer = 0;

  for (const entry of questions) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const kind = (entry as { kind?: unknown }).kind;
    if (kind === "info-card") {
      infoCards += 1;
      continue;
    }
    if (kind === "multiple-choice") {
      multipleChoice += 1;
      continue;
    }
    if (kind === "type-answer") {
      typeAnswer += 1;
    }
  }

  if (infoCards !== 4) {
    errors.push(`Quiz must contain 4 info-card questions, got ${infoCards}.`);
  }
  if (multipleChoice !== 10) {
    errors.push(`Quiz must contain 10 multiple-choice questions, got ${multipleChoice}.`);
  }
  if (typeAnswer !== 4) {
    errors.push(`Quiz must contain 4 type-answer questions, got ${typeAnswer}.`);
  }

  return errors;
}

function validateLessonCodeProblem(
  value: unknown,
  options: { readonly isFinalProblem: boolean },
): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["Coding problem output must be an object."];
  }
  const { examples, tests } = parseCodeIoCases(value);
  if (tests.length < 4) {
    errors.push(`Coding problem should contain at least 4 tests, got ${tests.length}.`);
  }

  if (!options.isFinalProblem) {
    return errors;
  }

  const description = (value as { description?: unknown }).description;
  if (typeof description !== "string" || !description.toLowerCase().includes("safe haven")) {
    errors.push('Final problem description must clearly include "Safe Haven".');
  }

  if (!hasIoCase(examples, SAFE_HAVEN_SAMPLE_CASE)) {
    errors.push(
      `Final problem examples must include sample case ${SAFE_HAVEN_SAMPLE_CASE.input} -> ${SAFE_HAVEN_SAMPLE_CASE.output}.`,
    );
  }

  const missingHidden = SAFE_HAVEN_HIDDEN_CASES.filter((target) => !hasIoCase(tests, target));
  if (missingHidden.length > 0) {
    errors.push(
      `Final problem hidden tests are missing ${missingHidden.length} required marking cases.`,
    );
  }

  return errors;
}

function validateDelegationEvidence(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["Delegation evidence must be an object."];
  }
  const objectValue = value as {
    delegated_early?: unknown;
    first_spawn_step?: unknown;
    parallel_workstreams?: unknown;
    alignment_pass?: unknown;
  };
  if (objectValue.delegated_early !== true) {
    errors.push("delegated_early must be true.");
  }
  if (
    typeof objectValue.first_spawn_step !== "number" ||
    !Number.isFinite(objectValue.first_spawn_step) ||
    objectValue.first_spawn_step > 8
  ) {
    errors.push("first_spawn_step must be a number <= 8.");
  }
  const streams = Array.isArray(objectValue.parallel_workstreams)
    ? objectValue.parallel_workstreams
    : [];
  const ownsQuiz = streams.some((stream) => {
    if (typeof stream !== "object" || stream === null) {
      return false;
    }
    const outputs = (stream as { owned_outputs?: unknown }).owned_outputs;
    return (
      Array.isArray(outputs) &&
      outputs.some(
        (output) =>
          typeof output === "string" && (output.includes("/quiz/") || output.includes("quiz-")),
      )
    );
  });
  const ownsCode = streams.some((stream) => {
    if (typeof stream !== "object" || stream === null) {
      return false;
    }
    const outputs = (stream as { owned_outputs?: unknown }).owned_outputs;
    return (
      Array.isArray(outputs) &&
      outputs.some(
        (output) =>
          typeof output === "string" && (output.includes("/code/") || output.includes("problem-")),
      )
    );
  });
  if (!ownsQuiz) {
    errors.push("Delegation evidence must include a quiz-focused workstream.");
  }
  if (!ownsCode) {
    errors.push("Delegation evidence must include a coding-focused workstream.");
  }

  const alignmentPass = objectValue.alignment_pass;
  if (typeof alignmentPass !== "object" || alignmentPass === null) {
    errors.push("Delegation evidence must include alignment_pass.");
    return errors;
  }
  const pairings = Array.isArray((alignmentPass as { pairings?: unknown }).pairings)
    ? ((alignmentPass as { pairings: unknown[] }).pairings ?? [])
    : [];
  const expectedPairings = new Map([
    ["quiz-1", "problem-1"],
    ["quiz-2", "problem-2"],
    ["quiz-3", "problem-3"],
    ["quiz-4", "problem-3"],
  ]);
  for (const [quizId, problemId] of expectedPairings.entries()) {
    const matched = pairings.some((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const quiz = (entry as { quiz_id?: unknown }).quiz_id;
      const problem = (entry as { coding_problem_id?: unknown }).coding_problem_id;
      return quiz === quizId && problem === problemId;
    });
    if (!matched) {
      errors.push(
        `alignment_pass.pairings must include ${JSON.stringify(quizId)} -> ${JSON.stringify(problemId)}.`,
      );
    }
  }

  const updatedQuizFiles = Array.isArray((alignmentPass as { updated_quiz_files?: unknown }).updated_quiz_files)
    ? ((alignmentPass as { updated_quiz_files: unknown[] }).updated_quiz_files ?? [])
    : [];
  for (const requiredQuizId of ["quiz-1", "quiz-2", "quiz-3"]) {
    const hasQuiz = updatedQuizFiles.some(
      (entry) => typeof entry === "string" && entry.includes(requiredQuizId),
    );
    if (!hasQuiz) {
      errors.push(`alignment_pass.updated_quiz_files must include ${requiredQuizId}.`);
    }
  }

  return errors;
}

function validateByProfile(
  profile: OutputFileSpec["validationProfile"],
  value: unknown,
): readonly string[] {
  switch (profile) {
    case "lesson-session":
      return validateLessonSession(value);
    case "lesson-quiz":
      return validateLessonQuiz(value);
    case "lesson-code-problem":
      return validateLessonCodeProblem(value, { isFinalProblem: false });
    case "lesson-code-problem-final":
      return validateLessonCodeProblem(value, { isFinalProblem: true });
    case "delegation-evidence":
      return validateDelegationEvidence(value);
    default:
      return [];
  }
}

function formatAjvErrorPath(path: string): string {
  if (!path || path === "/") {
    return "<root>";
  }
  return path;
}

async function validateOutputAgainstJsonSchema(params: {
  spec: OutputFileSpec;
  parsed: unknown;
  workspaceRootAbs: string;
  validatorCache: Map<string, ValidateFunction>;
  ajv: Ajv;
}): Promise<readonly string[]> {
  const schemaPath = join(params.workspaceRootAbs, params.spec.schemaFile);
  let validator = params.validatorCache.get(schemaPath);
  if (!validator) {
    const schemaRaw = await readFile(schemaPath, "utf8");
    const schemaJson = JSON.parse(schemaRaw);
    validator = params.ajv.compile(schemaJson);
    params.validatorCache.set(schemaPath, validator);
  }
  const valid = validator(params.parsed);
  if (valid) {
    return [];
  }
  return (validator.errors ?? []).map(
    (error: ErrorObject) =>
      `${formatAjvErrorPath(error.instancePath)}: ${error.message ?? "schema violation"}`,
  );
}

async function validateOutputs(layout: WorkspaceLayout): Promise<readonly OutputValidation[]> {
  const validations: OutputValidation[] = [];
  const reportLineCount = layout.reportText.split("\n").length;
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const validatorCache = new Map<string, ValidateFunction>();

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

    let validatedValue: unknown = parsed;
    let schemaErrors: readonly string[] = [];
    if (spec.schema) {
      const schemaResult = spec.schema.safeParse(parsed);
      if (!schemaResult.success) {
        schemaErrors = schemaResult.error.issues.map(
          (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        );
      } else {
        validatedValue = schemaResult.data;
      }
    } else {
      schemaErrors = await validateOutputAgainstJsonSchema({
        spec,
        parsed,
        workspaceRootAbs: layout.rootAbs,
        validatorCache,
        ajv,
      });
    }

    if (schemaErrors.length > 0) {
      validations.push({
        outputFile: spec.outputFile,
        schemaFile: spec.schemaFile,
        exists: true,
        jsonValid: true,
        schemaValid: false,
        groundingValid: false,
        errors: schemaErrors,
        content,
      });
      continue;
    }

    let groundingErrors: readonly string[] = [];
    switch (spec.groundingMode) {
      case "claim-audit":
        groundingErrors = validateClaimGrounding(
          validatedValue as ClaimAudit,
          reportLineCount,
          layout.reportText,
        );
        break;
      case "quantitative-findings":
        groundingErrors = validateQuantitativeGrounding(
          validatedValue as QuantitativeFindings,
          reportLineCount,
        );
        break;
      case "line-refs":
        groundingErrors = validateLineRefSet(collectLineRefsFromValue(validatedValue), reportLineCount);
        break;
      default:
        groundingErrors = [];
        break;
    }

    const expectedAnswerErrors = spec.expectedAnswer
      ? validateExpectedAnswerValue(validatedValue, spec.expectedAnswer)
      : [];
    const profileErrors = validateByProfile(spec.validationProfile, validatedValue);
    const allErrors = [...groundingErrors, ...expectedAnswerErrors, ...profileErrors];

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

  const alignmentErrorsByFile = validateLessonQuizCodingAlignment(validations);
  return applyCrossFileValidationErrors({
    validations,
    errorsByFile: alignmentErrorsByFile,
  });
}
function renderOutputBundle(validations: readonly OutputValidation[]): string {
  const sections: string[] = [];
  for (const validation of validations) {
    let parsedContent: unknown;
    if (validation.content) {
      try {
        parsedContent = JSON.parse(validation.content);
      } catch {
        parsedContent = undefined;
      }
    }
    sections.push(`### ${validation.outputFile}`);
    sections.push(`- exists: ${validation.exists}`);
    sections.push(`- jsonValid: ${validation.jsonValid}`);
    sections.push(`- schemaValid: ${validation.schemaValid}`);
    sections.push(`- groundingValid: ${validation.groundingValid}`);
    if (parsedContent && typeof parsedContent === "object") {
      if (validation.outputFile.includes("/quiz/")) {
        const questions = Array.isArray((parsedContent as { questions?: unknown }).questions)
          ? ((parsedContent as { questions: unknown[] }).questions ?? [])
          : [];
        const kindCounts = {
          "info-card": 0,
          "multiple-choice": 0,
          "type-answer": 0,
        };
        for (const question of questions) {
          if (typeof question !== "object" || question === null) {
            continue;
          }
          const kind = (question as { kind?: unknown }).kind;
          if (kind === "info-card" || kind === "multiple-choice" || kind === "type-answer") {
            kindCounts[kind] += 1;
          }
        }
        sections.push(
          `- quizSummary: total=${questions.length}, info-card=${kindCounts["info-card"]}, multiple-choice=${kindCounts["multiple-choice"]}, type-answer=${kindCounts["type-answer"]}`,
        );
      }
      if (validation.outputFile.includes("/code/")) {
        const examples = Array.isArray((parsedContent as { examples?: unknown }).examples)
          ? (parsedContent as { examples: unknown[] }).examples.length
          : 0;
        const tests = Array.isArray((parsedContent as { tests?: unknown }).tests)
          ? (parsedContent as { tests: unknown[] }).tests.length
          : 0;
        sections.push(`- codeSummary: examples=${examples}, tests=${tests}`);
      }
      if (validation.outputFile.endsWith("session.json")) {
        const plan = Array.isArray((parsedContent as { plan?: unknown }).plan)
          ? ((parsedContent as { plan: unknown[] }).plan ?? [])
          : [];
        const planKinds = plan
          .map((item) => (typeof item === "object" && item ? (item as { kind?: unknown }).kind : ""))
          .filter((kind): kind is string => typeof kind === "string" && kind.length > 0);
        sections.push(`- sessionSummary: planItems=${plan.length}, kinds=${planKinds.join(",")}`);
      }
      if (validation.outputFile.endsWith("delegation_evidence.json")) {
        const firstSpawn =
          typeof (parsedContent as { first_spawn_step?: unknown }).first_spawn_step === "number"
            ? (parsedContent as { first_spawn_step: number }).first_spawn_step
            : "n/a";
        const streams = Array.isArray(
          (parsedContent as { parallel_workstreams?: unknown }).parallel_workstreams,
        )
          ? (parsedContent as { parallel_workstreams: unknown[] }).parallel_workstreams.length
          : 0;
        sections.push(`- delegationSummary: first_spawn_step=${firstSpawn}, streams=${streams}`);
      }
    }
    if (validation.errors.length > 0) {
      sections.push("- validationErrors:");
      for (const error of validation.errors) {
        sections.push(`  - ${error}`);
      }
    }
    sections.push("- contentPreview:");
    sections.push("```json");
    const preview = validation.content
      ? truncatePreview(validation.content, 1200)
      : "<missing>";
    sections.push(preview);
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
  aspect: TaskGraderAspect;
}): string {
  const basePrompt = renderTemplate(params.graderTemplate, {
    TASK_ID: params.task.id,
    TASK_TITLE: params.task.title,
    SOURCE_URL: params.task.sourceUrl,
    GRADER_ASPECT_ID: params.aspect.id,
    GRADER_ASPECT_NAME: params.aspect.name,
    GRADER_ASPECT_CRITERIA: params.aspect.criteria,
    NUMBERED_REPORT: renderNumberedReport(params.reportText),
    OUTPUT_BUNDLE: renderOutputBundle(params.validations),
  });
  const fallbackAspectBlock = [
    "",
    "## GRADING ASPECT (fallback)",
    `- Aspect id: ${params.aspect.id}`,
    `- Aspect name: ${params.aspect.name}`,
    "- Evaluation criteria:",
    params.aspect.criteria,
  ].join("\n");
  return `${basePrompt}${fallbackAspectBlock}`;
}

function toSyntheticFailVerdict(message: string): GraderVerdict {
  return {
    verdict: "fail",
    scores: {
      faithfulness: 1,
      coverage: 1,
      usefulness: 1,
    },
    critical_issues: [message],
    summary: message.slice(0, 500),
  };
}

function clampGraderScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  if (rounded < 1) {
    return 1;
  }
  if (rounded > 5) {
    return 5;
  }
  return rounded;
}

function averageGraderScores(values: readonly GraderVerdict[]): GraderVerdict["scores"] {
  if (values.length === 0) {
    return { faithfulness: 1, coverage: 1, usefulness: 1 };
  }
  const totals = values.reduce(
    (acc, verdict) => {
      acc.faithfulness += verdict.scores.faithfulness;
      acc.coverage += verdict.scores.coverage;
      acc.usefulness += verdict.scores.usefulness;
      return acc;
    },
    { faithfulness: 0, coverage: 0, usefulness: 0 },
  );
  return {
    faithfulness: clampGraderScore(totals.faithfulness / values.length),
    coverage: clampGraderScore(totals.coverage / values.length),
    usefulness: clampGraderScore(totals.usefulness / values.length),
  };
}

function resolveTaskGraderAspects(task: AgentBenchmarkTask): readonly TaskGraderAspect[] {
  if (task.graderAspects && task.graderAspects.length > 0) {
    return task.graderAspects;
  }
  return DEFAULT_GRADER_ASPECTS;
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
  readonly aspects: readonly GraderAspectRun[];
}> {
  const aspects = resolveTaskGraderAspects(params.task);
  const aspectRuns: GraderAspectRun[] = [];

  for (const aspect of aspects) {
    const aspectStartedAtMs = Date.now();
    const aspectPrompt = buildGraderPrompt({
      task: params.task,
      reportText: params.layout.reportText,
      validations: params.validations,
      graderTemplate: params.graderTemplate,
      aspect,
    });
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort(new Error(`Grader timeout exceeded for aspect "${aspect.id}".`));
    }, DEFAULT_GRADER_TIMEOUT_MS);

    try {
      const response = await generateJson({
        model: params.graderModel,
        input: aspectPrompt,
        schema: GraderSchema,
        instructions:
          "Be conservative. If uncertain about fidelity or coverage, choose fail and explain concrete issues.",
        openAiReasoningEffort: params.reasoning,
        maxAttempts: 2,
        signal: abortController.signal,
      });
      const aspectCompletedAtMs = Date.now();
      aspectRuns.push({
        aspectId: aspect.id,
        aspectName: aspect.name,
        criteria: aspect.criteria,
        value: response.value,
        costUsd: response.result.costUsd,
        usage: summarizeUsage(response.result.usage),
        startedAt: new Date(aspectStartedAtMs).toISOString(),
        completedAt: new Date(aspectCompletedAtMs).toISOString(),
        durationMs: Math.max(0, aspectCompletedAtMs - aspectStartedAtMs),
        requestSummary: {
          promptChars: aspectPrompt.length,
          validationFiles: params.validations.length,
          aspectId: aspect.id,
        },
        responseSummary: {
          verdict: response.value.verdict,
          scoreTotal:
            response.value.scores.faithfulness +
            response.value.scores.coverage +
            response.value.scores.usefulness,
          criticalIssueCount: response.value.critical_issues.length,
          summaryPreview: truncatePreview(response.value.summary, 140),
        },
      });
    } catch (error) {
      const aspectCompletedAtMs = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      aspectRuns.push({
        aspectId: aspect.id,
        aspectName: aspect.name,
        criteria: aspect.criteria,
        error: message,
        costUsd: 0,
        usage: emptyUsageSummary(),
        startedAt: new Date(aspectStartedAtMs).toISOString(),
        completedAt: new Date(aspectCompletedAtMs).toISOString(),
        durationMs: Math.max(0, aspectCompletedAtMs - aspectStartedAtMs),
        requestSummary: {
          promptChars: aspectPrompt.length,
          validationFiles: params.validations.length,
          aspectId: aspect.id,
        },
        responseSummary: {
          error: truncatePreview(message, 180),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  const totalCost = aspectRuns.reduce((acc, entry) => acc + entry.costUsd, 0);
  const totalUsage = sumUsageSummaries(aspectRuns.map((entry) => entry.usage));
  const normalizedVerdicts = aspectRuns.map((entry) => {
    if (entry.value) {
      return entry.value;
    }
    return toSyntheticFailVerdict(
      `Aspect ${entry.aspectId} (${entry.aspectName}) failed: ${entry.error ?? "no verdict produced"}`,
    );
  });
  const hasAspectErrors = aspectRuns.some((entry) => typeof entry.error === "string");
  const anyAspectFailed = normalizedVerdicts.some((entry) => entry.verdict !== "pass");
  const mergedCriticalIssues = [...new Set(normalizedVerdicts.flatMap((entry) => entry.critical_issues))]
    .slice(0, 8)
    .map((issue) => issue.slice(0, 500));
  const summary = hasAspectErrors
    ? `Multi-aspect grading failed with ${aspectRuns.filter((entry) => entry.error).length} grader invocation error(s).`
    : "Multi-aspect grading completed.";
  const overallVerdict: GraderVerdict = {
    verdict: anyAspectFailed || hasAspectErrors ? "fail" : "pass",
    scores: averageGraderScores(normalizedVerdicts),
    critical_issues:
      mergedCriticalIssues.length > 0
        ? mergedCriticalIssues
        : ["No critical issues reported by grader aspects."],
    summary,
  };

  return {
    value: overallVerdict,
    costUsd: totalCost,
    usage: totalUsage,
    aspects: aspectRuns,
  };
}

async function runCase(params: {
  model: LlmTextModelId;
  variant: BenchmarkVariant;
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
  const caseName = `${sanitizeForPath(params.model)}-${params.task.id}-${params.variant}-run-${params.runIndex}`;
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
  let agentDurationMs = 0;
  let graderDurationMs = 0;
  let agentRunStartedAtMs = 0;
  let agentRunCompletedAtMs = 0;
  let agentRunSucceeded = false;
  const fsActions: FilesystemActionTrace[] = [];
  const timingEvents: BenchmarkTimingEvent[] = [];

  const agentAbortController = new AbortController();
  const agentTimeout = setTimeout(() => {
    agentAbortController.abort(new Error("Agent timeout exceeded."));
  }, DEFAULT_AGENT_TIMEOUT_MS);

  try {
    agentRunStartedAtMs = Date.now();
    const result = await runAgentLoop({
      model: params.model,
      input: buildAgentPrompt(layout, params.promptTemplates.agentPrompt, params.variant),
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
      subagents:
        params.variant === "subagents"
          ? {
              enabled: true,
              maxAgents: 4,
              maxDepth: 2,
              defaultWaitTimeoutMs: 10_000,
              maxWaitTimeoutMs: 120_000,
            }
          : false,
    });

    agentFinalText = sanitizePathLikeText(result.text, layout.rootAbs);
    agentCostUsd = result.totalCostUsd;
    agentSteps = result.steps;
    agentUsage = sumUsageSummaries(result.steps.map((step) => summarizeUsage(step.usage)));
    modelVersions = [...new Set(result.steps.map((step) => step.modelVersion))];
    agentDurationMs = Math.max(0, Date.now() - agentRunStartedAtMs);
    agentRunSucceeded = true;

    const redactedResult = redactSensitivePaths(result, layout.rootAbs);
    await writeFile(
      join(layout.rootAbs, "agent-run.json"),
      `${JSON.stringify(
        {
          model: params.model,
          variant: params.variant,
          taskId: params.task.id,
          runIndex: params.runIndex,
          agentDurationMs,
          result: redactedResult,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (agentDurationMs === 0) {
      const durationStartMs = agentRunStartedAtMs > 0 ? agentRunStartedAtMs : startedAt;
      agentDurationMs = Math.max(0, Date.now() - durationStartMs);
    }
    const message = error instanceof Error ? error.message : String(error);
    agentError = sanitizePathLikeText(message, layout.rootAbs);
    await writeFile(
      join(layout.rootAbs, "agent-run.json"),
      `${JSON.stringify(
        {
          model: params.model,
          variant: params.variant,
          taskId: params.task.id,
          runIndex: params.runIndex,
          agentDurationMs,
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
    agentRunCompletedAtMs = Date.now();
    if (agentRunStartedAtMs > 0) {
      if (agentDurationMs === 0) {
        agentDurationMs = Math.max(0, agentRunCompletedAtMs - agentRunStartedAtMs);
      }
      timingEvents.push({
        phase: "agent.run",
        startedAt: new Date(agentRunStartedAtMs).toISOString(),
        completedAt: new Date(agentRunCompletedAtMs).toISOString(),
        durationMs: agentDurationMs,
        success: agentRunSucceeded,
        attributes: {
          model: params.model,
          variant: params.variant,
          stepCount: agentSteps.length,
          toolCalls: flattenLlmToolCalls(agentSteps).length,
          ...(agentError ? { error: agentError } : {}),
        },
      });
    }
    clearTimeout(agentTimeout);
  }

  await writeFile(
    join(layout.rootAbs, "filesystem-access-trace.json"),
    `${JSON.stringify(fsActions, null, 2)}\n`,
  );

  const toolTrace = evaluateToolTrace({ steps: agentSteps, fsActions });
  const subagentUsage = summarizeSubagentUsageFromCalls(toolTrace.calls);
  const firstSubagentSpawnStep = findFirstSpawnStep(agentSteps);
  const subagentPolicyPass =
    params.variant !== "subagents"
      ? true
      : subagentUsage.usedSubagents &&
        firstSubagentSpawnStep !== null &&
        firstSubagentSpawnStep <= 8;
  const validationStartedAtMs = Date.now();
  const validations = await validateOutputs(layout);
  const validationCompletedAtMs = Date.now();
  const schemaPass = validations.every(
    (validation) => validation.schemaValid && validation.groundingValid,
  );
  timingEvents.push({
    phase: "outputs.validate",
    startedAt: new Date(validationStartedAtMs).toISOString(),
    completedAt: new Date(validationCompletedAtMs).toISOString(),
    durationMs: Math.max(0, validationCompletedAtMs - validationStartedAtMs),
    success: schemaPass,
    attributes: {
      totalFiles: validations.length,
      failedFiles: validations.filter(
        (validation) => !validation.schemaValid || !validation.groundingValid,
      ).length,
    },
  });

  const graderStartedAtMs = Date.now();
  const grader = await gradeOutputs({
    graderModel: params.graderModel,
    task: params.task,
    layout,
    validations,
    reasoning: params.reasoning,
    graderTemplate: params.promptTemplates.graderPrompt,
  });
  const graderCompletedAtMs = Date.now();
  graderDurationMs = Math.max(0, graderCompletedAtMs - graderStartedAtMs);

  const graderPass = grader.value?.verdict === "pass";
  const graderAspectPassCount = grader.aspects.filter(
    (entry) => entry.value?.verdict === "pass" && !entry.error,
  ).length;
  timingEvents.push({
    phase: "grader.run",
    startedAt: new Date(graderStartedAtMs).toISOString(),
    completedAt: new Date(graderCompletedAtMs).toISOString(),
    durationMs: graderDurationMs,
    success: graderPass,
    attributes: {
      model: params.graderModel,
      verdict: grader.value?.verdict ?? "error",
      aspectCount: grader.aspects.length,
      aspectPassCount: graderAspectPassCount,
      ...(grader.error ? { error: grader.error } : {}),
    },
  });
  const durationMs = Date.now() - startedAt;
  const totalCostUsd = agentCostUsd + grader.costUsd;
  const totalUsage = sumUsageSummaries([agentUsage, grader.usage]);
  const agentLlmCallTraces = buildAgentLlmCallTraces(params.model, agentSteps);
  const graderLlmCallTraces: readonly LlmCallTraceRecord[] = grader.aspects.map((aspect) => ({
    source: "grader",
    stage: `grader.aspect.${aspect.aspectId}`,
    model: params.graderModel,
    startedAt: aspect.startedAt,
    completedAt: aspect.completedAt,
    durationMs: aspect.durationMs,
    requestSummary: aspect.requestSummary,
    responseSummary: aspect.responseSummary,
  }));
  const llmCallTraces = agentLlmCallTraces.concat(graderLlmCallTraces);
  const staleDiagnostic = detectStalePhase(llmCallTraces);
  const timing = computeTimingBreakdownFromSteps(
    agentSteps,
    durationMs,
    agentDurationMs,
    graderDurationMs,
  );

  const success =
    !agentError && schemaPass && toolTrace.pass && graderPass && subagentPolicyPass;
  timingEvents.push({
    phase: "case.total",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + durationMs).toISOString(),
    durationMs,
    success,
    attributes: {
      schemaPass,
      toolTracePass: toolTrace.pass,
      graderPass,
      subagentPolicyPass,
      firstSubagentSpawnStep,
      subagentCalls: subagentUsage.totalSubagentCalls,
    },
  });

  const caseResult: CaseResult = {
    model: params.model,
    variant: params.variant,
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
    subagentUsage,
    subagentPolicyPass,
    firstSubagentSpawnStep,
    llmCallTraces,
    staleDiagnostic,
    timing,
    timingEvents,
    grader: {
      model: params.graderModel,
      value: grader.value,
      error: grader.error,
      aspects: grader.aspects,
    },
  };

  await writeFile(
    join(layout.rootAbs, "timing-breakdown.json"),
    `${JSON.stringify(timing, null, 2)}\n`,
  );
  await writeFile(
    join(layout.rootAbs, "timing-events.json"),
    `${JSON.stringify(timingEvents, null, 2)}\n`,
  );
  await writeFile(
    join(layout.rootAbs, "validation.json"),
    `${JSON.stringify(caseResult, null, 2)}\n`,
  );
  await mkdir(join(layout.rootAbs, "artifacts", "logs"), { recursive: true });
  await writeFile(
    join(layout.rootAbs, "artifacts", "logs", "llm-call-trace.json"),
    `${JSON.stringify(llmCallTraces, null, 2)}\n`,
  );
  await writeFile(
    join(layout.rootAbs, "artifacts", "logs", "stale-diagnostic.json"),
    `${JSON.stringify(staleDiagnostic, null, 2)}\n`,
  );
  return caseResult;
}

function estimateProjection(params: {
  models: readonly string[];
  taskCount: number;
  variantCount: number;
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
    const casesForModel = params.taskCount * params.variantCount * params.runs;
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

  const totalCases = params.models.length * params.taskCount * params.variantCount * params.runs;
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

function summarizeByModelVariant(
  model: string,
  variant: BenchmarkVariant,
  cases: readonly CaseResult[],
): {
  readonly model: string;
  readonly variant: BenchmarkVariant;
  readonly cases: number;
  readonly success: number;
  readonly schemaPass: number;
  readonly toolPass: number;
  readonly graderPass: number;
  readonly avgDurationMs: number;
  readonly totalDurationMs: number;
  readonly totalToolCalls: number;
  readonly totalSubagentCalls: number;
  readonly runsUsingSubagents: number;
  readonly totalCostUsd: number;
  readonly totalUsage: UsageSummary;
  readonly totalTiming: CaseTimingBreakdown;
  readonly avgTiming: CaseTimingBreakdown;
} {
  const modelCases = cases.filter((entry) => entry.model === model && entry.variant === variant);
  const count = modelCases.length;
  const success = modelCases.filter((entry) => entry.success).length;
  const schemaPass = modelCases.filter((entry) => entry.schemaPass).length;
  const toolPass = modelCases.filter((entry) => entry.toolTracePass).length;
  const graderPass = modelCases.filter((entry) => entry.graderPass).length;
  const totalDurationMs = modelCases.reduce((acc, entry) => acc + entry.durationMs, 0);
  const avgDurationMs = count === 0 ? 0 : totalDurationMs / count;
  const totalToolCalls = modelCases.reduce((acc, entry) => acc + entry.toolTrace.totalCalls, 0);
  const totalSubagentCalls = modelCases.reduce(
    (acc, entry) => acc + entry.subagentUsage.totalSubagentCalls,
    0,
  );
  const runsUsingSubagents = modelCases.filter((entry) => entry.subagentUsage.usedSubagents).length;
  const totalCostUsd = modelCases.reduce((acc, entry) => acc + entry.totalCostUsd, 0);
  const totalUsage = sumUsageSummaries(modelCases.map((entry) => entry.totalUsage));
  const totalTiming = sumTimingBreakdowns(modelCases.map((entry) => entry.timing));
  const avgTiming = averageTimingBreakdown(
    modelCases.map((entry) => entry.timing),
    count,
  );

  return {
    model,
    variant,
    cases: count,
    success,
    schemaPass,
    toolPass,
    graderPass,
    avgDurationMs,
    totalDurationMs,
    totalToolCalls,
    totalSubagentCalls,
    runsUsingSubagents,
    totalCostUsd,
    totalUsage,
    totalTiming,
    avgTiming,
  };
}

function modelTaskVariantResultKey(
  value: Pick<CaseResult, "model" | "taskId" | "variant">,
): string {
  return `${value.model}::${value.variant}::${value.taskId}`;
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
  variants: readonly BenchmarkVariant[];
  tasks: readonly BenchmarkTaskSummary[];
  cases: readonly CaseResult[];
}): readonly ModelTaskRunSummary[] {
  const grouped = new Map<string, CaseResult[]>();
  for (const result of params.cases) {
    const key = modelTaskVariantResultKey(result);
    const group = grouped.get(key);
    if (group) {
      group.push(result);
    } else {
      grouped.set(key, [result]);
    }
  }

  const summaries: ModelTaskRunSummary[] = [];
  const consumed = new Set<string>();
  const appendSummary = (
    model: string,
    variant: BenchmarkVariant,
    taskId: string,
    entries: readonly CaseResult[],
  ) => {
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
    const avgSubagentCalls =
      entries.reduce((acc, entry) => acc + entry.subagentUsage.totalSubagentCalls, 0) / runs;
    const runsUsingSubagents = entries.filter((entry) => entry.subagentUsage.usedSubagents).length;
    const avgTiming = averageTimingBreakdown(
      entries.map((entry) => entry.timing),
      runs,
    );

    summaries.push({
      model,
      variant,
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
      avgSubagentCalls,
      bestSubagentCalls: best.subagentUsage.totalSubagentCalls,
      runsUsingSubagents,
      avgTiming,
    });
  };

  for (const model of params.models) {
    for (const variant of params.variants) {
      for (const task of params.tasks) {
        const key = modelTaskVariantResultKey({ model, variant, taskId: task.id });
        const entries = grouped.get(key);
        if (!entries) {
          continue;
        }
        consumed.add(key);
        appendSummary(model, variant, task.id, entries);
      }
    }
  }

  const remaining = [...grouped.entries()].filter(([key]) => !consumed.has(key));
  remaining.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, entries] of remaining) {
    const [model, variantRaw, taskId] = key.split("::");
    if (!model || !variantRaw || !taskId || !isBenchmarkVariant(variantRaw)) {
      continue;
    }
    appendSummary(model, variantRaw, taskId, entries);
  }

  return summaries;
}

function computeVariantSpeedups(
  summaries: readonly ModelTaskRunSummary[],
): readonly VariantSpeedupSummary[] {
  const grouped = new Map<
    string,
    {
      baseline?: ModelTaskRunSummary;
      subagents?: ModelTaskRunSummary;
    }
  >();

  for (const summary of summaries) {
    const key = `${summary.model}::${summary.taskId}`;
    const current = grouped.get(key) ?? {};
    if (summary.variant === "baseline") {
      current.baseline = summary;
    } else if (summary.variant === "subagents") {
      current.subagents = summary;
    }
    grouped.set(key, current);
  }

  const speedups: VariantSpeedupSummary[] = [];
  for (const [key, value] of grouped) {
    if (!value.baseline || !value.subagents) {
      continue;
    }
    if (value.subagents.avgDurationMs <= 0) {
      continue;
    }
    const [model, taskId] = key.split("::");
    if (!model || !taskId) {
      continue;
    }
    speedups.push({
      model,
      taskId,
      baselineAvgDurationMs: value.baseline.avgDurationMs,
      subagentsAvgDurationMs: value.subagents.avgDurationMs,
      speedupRatio: value.baseline.avgDurationMs / value.subagents.avgDurationMs,
    });
  }

  speedups.sort((a, b) => {
    if (a.model !== b.model) {
      return a.model < b.model ? -1 : 1;
    }
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  return speedups;
}

function buildMarkdownReport(params: {
  runId: string;
  generatedAt: string;
  models: readonly string[];
  variants: readonly BenchmarkVariant[];
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
  const totalTiming = sumTimingBreakdowns(params.caseResults.map((entry) => entry.timing));
  const avgTiming = averageTimingBreakdown(
    params.caseResults.map((entry) => entry.timing),
    totalCases,
  );
  const phaseTiming = summarizeTimingPhases(params.caseResults);
  const totalSubagentCalls = params.caseResults.reduce(
    (acc, entry) => acc + entry.subagentUsage.totalSubagentCalls,
    0,
  );
  const staleCases = params.caseResults.filter((entry) => entry.staleDiagnostic.appearsStale);
  const runsUsingSubagents = params.caseResults.filter(
    (entry) => entry.subagentUsage.usedSubagents,
  ).length;
  const perTaskAcrossRuns = summarizeByModelTaskAcrossRuns({
    models: params.models,
    variants: params.variants,
    tasks: params.tasks,
    cases: params.caseResults,
  });
  const variantSpeedups = computeVariantSpeedups(perTaskAcrossRuns);

  const lines: string[] = [];
  lines.push("# Filesystem Agent Benchmark Report");
  lines.push("");
  lines.push(`- Run id: ${params.runId}`);
  lines.push(`- Generated at: ${params.generatedAt}`);
  lines.push(`- Models: ${params.models.join(", ")}`);
  lines.push(`- Variants: ${params.variants.join(", ")}`);
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
  lines.push(`- Observed subagent tool calls: ${formatInt(totalSubagentCalls)}`);
  lines.push(`- Cases that used subagents: ${runsUsingSubagents}/${totalCases}`);
  lines.push(`- Cases flagged stale: ${staleCases.length}/${totalCases}`);
  lines.push(`- Avg model queue wait/case: ${(avgTiming.modelQueueWaitMs / 1000).toFixed(2)}s`);
  lines.push(
    `- Avg model connection setup/case: ${(avgTiming.modelConnectionSetupMs / 1000).toFixed(2)}s`,
  );
  lines.push(
    `- Avg active model generation/case: ${(avgTiming.modelActiveGenerationMs / 1000).toFixed(2)}s`,
  );
  lines.push(`- Avg agent.run wall-clock/case: ${(avgTiming.agentWallClockMs / 1000).toFixed(2)}s`);
  lines.push(
    `- Avg grader.run wall-clock/case: ${(avgTiming.graderWallClockMs / 1000).toFixed(2)}s`,
  );
  lines.push(`- Avg tool execution/case: ${(avgTiming.toolExecutionMs / 1000).toFixed(2)}s`);
  lines.push(`- Avg wait-tool polling/case: ${(avgTiming.pollingWaitToolMs / 1000).toFixed(2)}s`);
  lines.push(
    `- Subagent spawn startup total/avg: ${formatInt(totalTiming.spawnStartupCount)} / ${(totalTiming.spawnStartupCount > 0 ? totalTiming.spawnStartupLatencyMs / totalTiming.spawnStartupCount : 0).toFixed(2)}ms`,
  );
  lines.push(
    `- Observed tokens (in/cached/out): ${formatInt(totalUsage.promptTokens)}/${formatInt(totalUsage.cachedTokens)}/${formatInt(totalUsage.responseTokens)}`,
  );
  lines.push(`- Observed thinking tokens: ${formatInt(totalUsage.thinkingTokens)}`);
  lines.push(`- Observed total tokens: ${formatInt(totalUsage.totalTokens)}`);
  lines.push("");

  lines.push("## Stale-Phase Diagnostics");
  lines.push("");
  if (staleCases.length === 0) {
    lines.push("- No stale/hanging phases detected.");
  } else {
    for (const caseResult of staleCases) {
      lines.push(
        `- ${caseResult.model} / ${caseResult.variant} / ${caseResult.taskId} / run ${caseResult.runIndex}: bottleneck=${caseResult.staleDiagnostic.bottleneckStage}, max_call=${(caseResult.staleDiagnostic.maxCallDurationMs / 1000).toFixed(2)}s`,
      );
      for (const note of caseResult.staleDiagnostic.notes) {
        lines.push(`  - note: ${note}`);
      }
      for (const fix of caseResult.staleDiagnostic.suggestedFixes) {
        lines.push(`  - fix: ${fix}`);
      }
    }
  }
  lines.push("");

  lines.push("## Phase Timing");
  lines.push("");
  if (phaseTiming.length === 0) {
    lines.push("- No phase timing events captured.");
  } else {
    lines.push("| Phase | Samples | Success | Avg duration (s) | Total duration (s) |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const phase of phaseTiming) {
      lines.push(
        `| ${phase.phase} | ${phase.count} | ${phase.successCount}/${phase.count} | ${(phase.avgDurationMs / 1000).toFixed(2)} | ${(phase.totalDurationMs / 1000).toFixed(2)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Source Papers");
  lines.push("");
  for (const task of params.tasks) {
    lines.push(`- ${task.id}: ${task.sourceTitle} (${task.sourceUrl})`);
  }
  lines.push("");

  lines.push("## Cost Projection Inputs");
  lines.push("");
  lines.push(`- Variants: ${params.variants.join(", ")}`);
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
    "| Model | Variant | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Queue (s) | Conn setup (s) | Active gen (s) | Tool exec (s) | Wait tool (s) | Tool calls | Subagent calls | Runs using subagents | Total cost (USD) | In tokens | Cached tokens | Out tokens |",
  );
  lines.push(
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const model of params.models) {
    for (const variant of params.variants) {
      const summary = summarizeByModelVariant(model, variant, params.caseResults);
      if (summary.cases === 0) {
        continue;
      }
      lines.push(
        `| ${summary.model} | ${summary.variant} | ${summary.success}/${summary.cases} | ${summary.schemaPass}/${summary.cases} | ${summary.toolPass}/${summary.cases} | ${summary.graderPass}/${summary.cases} | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelQueueWaitMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelConnectionSetupMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelActiveGenerationMs / 1000).toFixed(2)} | ${(summary.avgTiming.toolExecutionMs / 1000).toFixed(2)} | ${(summary.avgTiming.pollingWaitToolMs / 1000).toFixed(2)} | ${summary.totalToolCalls} | ${summary.totalSubagentCalls} | ${summary.runsUsingSubagents}/${summary.cases} | ${formatUsd(summary.totalCostUsd)} | ${formatInt(summary.totalUsage.promptTokens)} | ${formatInt(summary.totalUsage.cachedTokens)} | ${formatInt(summary.totalUsage.responseTokens)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-Task Across Runs (Best + Average)");
  lines.push("");
  lines.push(
    "| Model | Variant | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Avg queue (s) | Avg conn setup (s) | Avg active gen (s) | Avg tool exec (s) | Avg wait tool (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls | Avg subagent calls | Best subagent calls | Runs using subagents |",
  );
  lines.push(
    "|---|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const summary of perTaskAcrossRuns) {
    lines.push(
      `| ${summary.model} | ${summary.variant} | ${summary.taskId} | ${summary.runs} | ${summary.bestSuccess ? "PASS" : "FAIL"} (run ${summary.bestRunIndex}) | ${summary.passCount}/${summary.runs} (${formatPercent(summary.passCount, summary.runs)}) | ${summary.schemaPassCount}/${summary.runs} (${formatPercent(summary.schemaPassCount, summary.runs)}) | ${summary.toolPassCount}/${summary.runs} (${formatPercent(summary.toolPassCount, summary.runs)}) | ${summary.graderPassCount}/${summary.runs} (${formatPercent(summary.graderPassCount, summary.runs)}) | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelQueueWaitMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelConnectionSetupMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelActiveGenerationMs / 1000).toFixed(2)} | ${(summary.avgTiming.toolExecutionMs / 1000).toFixed(2)} | ${(summary.avgTiming.pollingWaitToolMs / 1000).toFixed(2)} | ${(summary.bestDurationMs / 1000).toFixed(2)} | ${formatUsd(summary.avgCostUsd)} | ${formatUsd(summary.bestCostUsd)} | ${summary.avgToolCalls.toFixed(2)} | ${summary.bestToolCalls} | ${summary.avgSubagentCalls.toFixed(2)} | ${summary.bestSubagentCalls} | ${summary.runsUsingSubagents}/${summary.runs} |`,
    );
  }
  lines.push("");

  lines.push("## Baseline vs Subagents Speedup");
  lines.push("");
  if (variantSpeedups.length === 0) {
    lines.push("- Not enough paired baseline/subagents data to compute speedups.");
  } else {
    lines.push(
      "| Model | Task | Baseline avg latency (s) | Subagents avg latency (s) | Speedup (baseline/subagents) |",
    );
    lines.push("|---|---|---:|---:|---:|");
    for (const speedup of variantSpeedups) {
      lines.push(
        `| ${speedup.model} | ${speedup.taskId} | ${(speedup.baselineAvgDurationMs / 1000).toFixed(2)} | ${(speedup.subagentsAvgDurationMs / 1000).toFixed(2)} | ${speedup.speedupRatio.toFixed(2)}x |`,
      );
    }
  }
  lines.push("");

  lines.push("## Case Matrix");
  lines.push("");
  lines.push(
    "| Model | Variant | Task | Run | Reasoning | Status | Schema | Tool trace | Grader | Latency (s) | Queue (s) | Conn setup (s) | Active gen (s) | Tool exec (s) | Wait tool (s) | Spawn startup avg (ms) | Tool calls | Subagent calls (spawn/send/wait/close) | Used subagents | Cost (USD) | In tokens | Cached tokens | Out tokens |",
  );
  lines.push(
    "|---|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---:|---:|",
  );
  for (const result of params.caseResults) {
    const spawnStartupAvgMs =
      result.timing.spawnStartupCount > 0
        ? result.timing.spawnStartupLatencyMs / result.timing.spawnStartupCount
        : 0;
    lines.push(
      `| ${result.model} | ${result.variant} | ${result.taskId} | ${result.runIndex} | ${result.agentReasoning} | ${result.success ? "PASS" : "FAIL"} | ${result.schemaPass ? "pass" : "fail"} | ${result.toolTracePass ? "pass" : "fail"} | ${result.graderPass ? "pass" : "fail"} | ${(result.durationMs / 1000).toFixed(2)} | ${(result.timing.modelQueueWaitMs / 1000).toFixed(2)} | ${(result.timing.modelConnectionSetupMs / 1000).toFixed(2)} | ${(result.timing.modelActiveGenerationMs / 1000).toFixed(2)} | ${(result.timing.toolExecutionMs / 1000).toFixed(2)} | ${(result.timing.pollingWaitToolMs / 1000).toFixed(2)} | ${spawnStartupAvgMs.toFixed(2)} | ${result.toolTrace.totalCalls} | ${result.subagentUsage.spawnAgentCalls}/${result.subagentUsage.sendInputCalls}/${result.subagentUsage.waitCalls}/${result.subagentUsage.closeAgentCalls} | ${result.subagentUsage.usedSubagents ? "yes" : "no"} | ${formatUsd(result.totalCostUsd)} | ${formatInt(result.totalUsage.promptTokens)} | ${formatInt(result.totalUsage.cachedTokens)} | ${formatInt(result.totalUsage.responseTokens)} |`,
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
      if (!failure.subagentPolicyPass) {
        reasons.push(
          `subagent_policy_failed(first_spawn_step=${failure.firstSubagentSpawnStep ?? "none"}, total_calls=${failure.subagentUsage.totalSubagentCalls})`,
        );
      }
      if (!failure.graderPass) {
        reasons.push(
          failure.grader.error
            ? `grader_error=${failure.grader.error}`
            : `grader_verdict=${failure.grader.value?.verdict ?? "missing"}`,
        );
      }
      if (failure.staleDiagnostic.appearsStale) {
        reasons.push(
          `stale_phase=${failure.staleDiagnostic.bottleneckStage}@${(failure.staleDiagnostic.maxCallDurationMs / 1000).toFixed(2)}s`,
        );
      }
      lines.push(
        `- ${failure.model} / ${failure.variant} / ${failure.taskId} / run ${failure.runIndex}: ${reasons.join(" | ")}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildLatestResultsMarkdown(params: {
  runId: string;
  generatedAt: string;
  models: readonly string[];
  variants: readonly BenchmarkVariant[];
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
  const totalTiming = sumTimingBreakdowns(params.caseResults.map((entry) => entry.timing));
  const avgTiming = averageTimingBreakdown(
    params.caseResults.map((entry) => entry.timing),
    totalCases,
  );
  const phaseTiming = summarizeTimingPhases(params.caseResults);
  const totalSubagentCalls = params.caseResults.reduce(
    (acc, entry) => acc + entry.subagentUsage.totalSubagentCalls,
    0,
  );
  const staleCases = params.caseResults.filter((entry) => entry.staleDiagnostic.appearsStale);
  const runsUsingSubagents = params.caseResults.filter(
    (entry) => entry.subagentUsage.usedSubagents,
  ).length;
  const perTaskAcrossRuns = summarizeByModelTaskAcrossRuns({
    models: params.models,
    variants: params.variants,
    tasks: params.tasks,
    cases: params.caseResults,
  });
  const variantSpeedups = computeVariantSpeedups(perTaskAcrossRuns);

  const lines: string[] = [];
  lines.push("# Latest Agent Benchmark Results");
  lines.push("");
  lines.push("This file is auto-generated from the latest benchmark run.");
  lines.push("");
  lines.push(`- Run id: \`${params.runId}\``);
  lines.push(`- Generated at: \`${params.generatedAt}\``);
  lines.push(`- Tasks: ${params.tasks.map((task) => `\`${task.id}\``).join(", ")}`);
  lines.push(`- Models: ${params.models.map((model) => `\`${model}\``).join(", ")}`);
  lines.push(`- Variants: ${params.variants.map((variant) => `\`${variant}\``).join(", ")}`);
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
  lines.push(`- Subagent tool calls: ${formatInt(totalSubagentCalls)}`);
  lines.push(`- Cases that used subagents: ${runsUsingSubagents}/${totalCases}`);
  lines.push(`- Cases flagged stale: ${staleCases.length}/${totalCases}`);
  lines.push(`- Avg model queue wait/case: ${(avgTiming.modelQueueWaitMs / 1000).toFixed(2)}s`);
  lines.push(
    `- Avg model connection setup/case: ${(avgTiming.modelConnectionSetupMs / 1000).toFixed(2)}s`,
  );
  lines.push(
    `- Avg active model generation/case: ${(avgTiming.modelActiveGenerationMs / 1000).toFixed(2)}s`,
  );
  lines.push(`- Avg agent.run wall-clock/case: ${(avgTiming.agentWallClockMs / 1000).toFixed(2)}s`);
  lines.push(
    `- Avg grader.run wall-clock/case: ${(avgTiming.graderWallClockMs / 1000).toFixed(2)}s`,
  );
  lines.push(`- Avg tool execution/case: ${(avgTiming.toolExecutionMs / 1000).toFixed(2)}s`);
  lines.push(`- Avg wait-tool polling/case: ${(avgTiming.pollingWaitToolMs / 1000).toFixed(2)}s`);
  lines.push(
    `- Subagent spawn startup total/avg: ${formatInt(totalTiming.spawnStartupCount)} / ${(totalTiming.spawnStartupCount > 0 ? totalTiming.spawnStartupLatencyMs / totalTiming.spawnStartupCount : 0).toFixed(2)}ms`,
  );
  lines.push(
    `- Tokens (in/cached/out): ${formatInt(totalUsage.promptTokens)}/${formatInt(totalUsage.cachedTokens)}/${formatInt(totalUsage.responseTokens)}`,
  );
  lines.push(`- Thinking tokens: ${formatInt(totalUsage.thinkingTokens)}`);
  lines.push(`- Total tokens: ${formatInt(totalUsage.totalTokens)}`);
  lines.push("");

  lines.push("## Phase Timing");
  lines.push("");
  if (phaseTiming.length === 0) {
    lines.push("- No phase timing events captured.");
  } else {
    lines.push("| Phase | Samples | Success | Avg duration (s) | Total duration (s) |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const phase of phaseTiming) {
      lines.push(
        `| \`${phase.phase}\` | ${phase.count} | ${phase.successCount}/${phase.count} | ${(phase.avgDurationMs / 1000).toFixed(2)} | ${(phase.totalDurationMs / 1000).toFixed(2)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Outcome");
  lines.push("");
  lines.push(
    "| Model | Variant | Overall | Schema | Tool Trace | Grader | Avg latency (s) | Queue (s) | Conn setup (s) | Active gen (s) | Tool exec (s) | Wait tool (s) | Tool Calls | Subagent Calls | Used subagents | Cost (USD) | In tokens | Cached tokens | Out tokens |",
  );
  lines.push(
    "|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|",
  );
  for (const model of params.models) {
    for (const variant of params.variants) {
      const summary = summarizeByModelVariant(model, variant, params.caseResults);
      if (summary.cases === 0) {
        continue;
      }
      const overall = summary.success === summary.cases ? "PASS" : "FAIL";
      lines.push(
        `| \`${summary.model}\` | \`${summary.variant}\` | ${overall} | ${summary.schemaPass}/${summary.cases} | ${summary.toolPass}/${summary.cases} | ${summary.graderPass}/${summary.cases} | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelQueueWaitMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelConnectionSetupMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelActiveGenerationMs / 1000).toFixed(2)} | ${(summary.avgTiming.toolExecutionMs / 1000).toFixed(2)} | ${(summary.avgTiming.pollingWaitToolMs / 1000).toFixed(2)} | ${summary.totalToolCalls} | ${summary.totalSubagentCalls} | ${summary.runsUsingSubagents}/${summary.cases} | ${formatUsd(summary.totalCostUsd)} | ${formatInt(summary.totalUsage.promptTokens)} | ${formatInt(summary.totalUsage.cachedTokens)} | ${formatInt(summary.totalUsage.responseTokens)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-Task Across Runs (Best + Average)");
  lines.push("");
  lines.push(
    "| Model | Variant | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Avg queue (s) | Avg conn setup (s) | Avg active gen (s) | Avg tool exec (s) | Avg wait tool (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls | Avg subagent calls | Best subagent calls | Runs using subagents |",
  );
  lines.push(
    "|---|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const summary of perTaskAcrossRuns) {
    lines.push(
      `| \`${summary.model}\` | \`${summary.variant}\` | \`${summary.taskId}\` | ${summary.runs} | ${summary.bestSuccess ? "PASS" : "FAIL"} (run ${summary.bestRunIndex}) | ${summary.passCount}/${summary.runs} (${formatPercent(summary.passCount, summary.runs)}) | ${summary.schemaPassCount}/${summary.runs} (${formatPercent(summary.schemaPassCount, summary.runs)}) | ${summary.toolPassCount}/${summary.runs} (${formatPercent(summary.toolPassCount, summary.runs)}) | ${summary.graderPassCount}/${summary.runs} (${formatPercent(summary.graderPassCount, summary.runs)}) | ${(summary.avgDurationMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelQueueWaitMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelConnectionSetupMs / 1000).toFixed(2)} | ${(summary.avgTiming.modelActiveGenerationMs / 1000).toFixed(2)} | ${(summary.avgTiming.toolExecutionMs / 1000).toFixed(2)} | ${(summary.avgTiming.pollingWaitToolMs / 1000).toFixed(2)} | ${(summary.bestDurationMs / 1000).toFixed(2)} | ${formatUsd(summary.avgCostUsd)} | ${formatUsd(summary.bestCostUsd)} | ${summary.avgToolCalls.toFixed(2)} | ${summary.bestToolCalls} | ${summary.avgSubagentCalls.toFixed(2)} | ${summary.bestSubagentCalls} | ${summary.runsUsingSubagents}/${summary.runs} |`,
    );
  }
  lines.push("");

  lines.push("## Baseline vs Subagents Speedup");
  lines.push("");
  if (variantSpeedups.length === 0) {
    lines.push("- Not enough paired baseline/subagents data to compute speedups.");
  } else {
    lines.push(
      "| Model | Task | Baseline avg latency (s) | Subagents avg latency (s) | Speedup (baseline/subagents) |",
    );
    lines.push("|---|---|---:|---:|---:|");
    for (const speedup of variantSpeedups) {
      lines.push(
        `| \`${speedup.model}\` | \`${speedup.taskId}\` | ${(speedup.baselineAvgDurationMs / 1000).toFixed(2)} | ${(speedup.subagentsAvgDurationMs / 1000).toFixed(2)} | ${speedup.speedupRatio.toFixed(2)}x |`,
      );
    }
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

function caseResultKey(
  value: Pick<CaseResult, "model" | "variant" | "taskId" | "runIndex">,
): string {
  return `${value.model}::${value.variant}::${value.taskId}::${value.runIndex}`;
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

function parseLlmCallTraces(value: unknown): readonly LlmCallTraceRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const traces: LlmCallTraceRecord[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const source = record.source === "agent" || record.source === "grader" ? record.source : null;
    const stage = typeof record.stage === "string" ? record.stage : "";
    const model = typeof record.model === "string" ? record.model : "";
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : "";
    const completedAt = typeof record.completedAt === "string" ? record.completedAt : "";
    if (!source || !stage || !model || !startedAt || !completedAt) {
      continue;
    }
    traces.push({
      source,
      stage,
      model,
      startedAt,
      completedAt,
      durationMs: toNonNegativeNumber(record.durationMs),
      requestSummary: asJsonRecord(record.requestSummary) ?? {},
      responseSummary: asJsonRecord(record.responseSummary) ?? {},
    });
  }
  return traces;
}

function parseStaleDiagnostic(value: unknown): StalePhaseDiagnostic {
  if (typeof value !== "object" || value === null) {
    return emptyStalePhaseDiagnostic();
  }
  const record = value as Record<string, unknown>;
  return {
    appearsStale: record.appearsStale === true,
    bottleneckStage:
      typeof record.bottleneckStage === "string" ? record.bottleneckStage : "none",
    maxCallDurationMs: toNonNegativeNumber(record.maxCallDurationMs),
    notes: Array.isArray(record.notes)
      ? record.notes.filter((entry): entry is string => typeof entry === "string")
      : [],
    suggestedFixes: Array.isArray(record.suggestedFixes)
      ? record.suggestedFixes.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseGraderAspectRuns(value: unknown): readonly GraderAspectRun[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const runs: GraderAspectRun[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const aspectId = typeof record.aspectId === "string" ? record.aspectId : "";
    const aspectName = typeof record.aspectName === "string" ? record.aspectName : "";
    const criteria = typeof record.criteria === "string" ? record.criteria : "";
    if (!aspectId || !aspectName || !criteria) {
      continue;
    }
    const parsedVerdict = GraderSchema.safeParse(record.value);
    runs.push({
      aspectId,
      aspectName,
      criteria,
      ...(parsedVerdict.success ? { value: parsedVerdict.data } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      costUsd: toNonNegativeNumber(record.costUsd),
      usage: summarizeUsage(record.usage),
      startedAt:
        typeof record.startedAt === "string" ? record.startedAt : new Date(0).toISOString(),
      completedAt:
        typeof record.completedAt === "string" ? record.completedAt : new Date(0).toISOString(),
      durationMs: toNonNegativeNumber(record.durationMs),
      requestSummary: asJsonRecord(record.requestSummary) ?? {},
      responseSummary: asJsonRecord(record.responseSummary) ?? {},
    });
  }
  return runs;
}

function parseCaseResults(value: unknown): CaseResult[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const entry = item as Partial<CaseResult> & Record<string, unknown>;
    if (
      typeof entry.model !== "string" ||
      typeof entry.taskId !== "string" ||
      typeof entry.runIndex !== "number"
    ) {
      return [];
    }

    const variantRaw = typeof entry.variant === "string" ? entry.variant : "baseline";
    const variant = isBenchmarkVariant(variantRaw) ? variantRaw : "baseline";

    return [
      {
        ...(entry as CaseResult),
        model: entry.model,
        variant,
        taskId: entry.taskId,
        runIndex: entry.runIndex,
        subagentUsage: parseSubagentUsageSummary(entry.subagentUsage),
        subagentPolicyPass:
          typeof entry.subagentPolicyPass === "boolean" ? entry.subagentPolicyPass : true,
        firstSubagentSpawnStep:
          typeof entry.firstSubagentSpawnStep === "number" &&
          Number.isFinite(entry.firstSubagentSpawnStep)
            ? entry.firstSubagentSpawnStep
            : null,
        llmCallTraces: parseLlmCallTraces(entry.llmCallTraces),
        staleDiagnostic: parseStaleDiagnostic(entry.staleDiagnostic),
        timing: parseCaseTimingBreakdown(entry.timing),
        timingEvents: parseTimingEvents(entry.timingEvents),
        grader: {
          ...(typeof entry.grader === "object" && entry.grader !== null
            ? (entry.grader as CaseResult["grader"])
            : { model: "" }),
          model:
            typeof (entry.grader as { model?: unknown } | undefined)?.model === "string"
              ? ((entry.grader as { model: string }).model ?? "")
              : "",
          aspects: parseGraderAspectRuns(
            (entry.grader as { aspects?: unknown } | undefined)?.aspects,
          ),
        },
      },
    ];
  });
}

function parseBenchmarkVariantsFromUnknown(value: unknown): readonly BenchmarkVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: BenchmarkVariant[] = [];
  const seen = new Set<BenchmarkVariant>();
  for (const entry of value) {
    if (typeof entry !== "string" || !isBenchmarkVariant(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    parsed.push(entry);
  }
  return parsed;
}

function inferVariantsFromCaseResults(
  caseResults: readonly CaseResult[],
): readonly BenchmarkVariant[] {
  const present = new Set(caseResults.map((result) => result.variant));
  const ordered = BENCHMARK_VARIANTS.filter((variant) => present.has(variant));
  if (ordered.length > 0) {
    return ordered;
  }
  return ["baseline"];
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
  const variantsRaw = parseBenchmarkVariantsFromUnknown(parsed.variants);
  const variants = variantsRaw.length > 0 ? variantsRaw : inferVariantsFromCaseResults(caseResults);

  return {
    models,
    variants,
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

function mergeVariants(params: {
  existingVariants: readonly BenchmarkVariant[];
  currentVariants: readonly BenchmarkVariant[];
  caseResults: readonly CaseResult[];
}): readonly BenchmarkVariant[] {
  const ordered: BenchmarkVariant[] = [];
  const seen = new Set<BenchmarkVariant>();
  const add = (value: BenchmarkVariant) => {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    ordered.push(value);
  };

  for (const variant of params.existingVariants) {
    add(variant);
  }
  for (const variant of params.currentVariants) {
    add(variant);
  }
  for (const result of params.caseResults) {
    add(result.variant);
  }
  if (ordered.length === 0) {
    return ["baseline"];
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
  variants: readonly BenchmarkVariant[];
  tasks: readonly BenchmarkTaskSummary[];
}): readonly CaseResult[] {
  const modelOrder = new Map(params.models.map((model, index) => [model, index]));
  const variantOrder = new Map(params.variants.map((variant, index) => [variant, index]));
  const taskOrder = new Map(params.tasks.map((task, index) => [task.id, index]));
  return [...params.caseResults].sort((a, b) => {
    const aModel = modelOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER;
    const bModel = modelOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER;
    if (aModel !== bModel) {
      return aModel - bModel;
    }
    const aVariant = variantOrder.get(a.variant) ?? Number.MAX_SAFE_INTEGER;
    const bVariant = variantOrder.get(b.variant) ?? Number.MAX_SAFE_INTEGER;
    if (aVariant !== bVariant) {
      return aVariant - bVariant;
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
      variants: { type: "string", default: BENCHMARK_VARIANTS.join(",") },
      variant: { type: "string" },
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
  const variants = parseBenchmarkVariants(
    values.variant ?? values.variants ?? BENCHMARK_VARIANTS.join(","),
  );
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
    variantCount: variants.length,
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
  console.log(`Variants: ${variants.join(", ")}`);
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
  const defaultPromptTemplates = await loadPromptTemplates(benchmarkRoot);
  const taskPromptTemplatesById = new Map<string, PromptTemplates>(
    await Promise.all(
      tasks.map(async (task) =>
        [
          task.id,
          await resolveTaskPromptTemplates({
            benchmarkRoot,
            task,
            defaults: defaultPromptTemplates,
          }),
        ] as const,
      ),
    ),
  );
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
        for (const variant of variants) {
          for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
            const taskPromptTemplates =
              taskPromptTemplatesById.get(task.id) ?? defaultPromptTemplates;
            const result = await runCase({
              model,
              variant,
              agentReasoning,
              task,
              runIndex,
              outRoot: runRoot,
              benchmarkRoot,
              reasoning,
              graderModel,
              maxSteps,
              promptTemplates: taskPromptTemplates,
            });
            modelResults.push(result);

            const status = result.success ? "PASS" : "FAIL";
            const reason = result.success
              ? ""
              : [
                  result.agentError ? `agent=${result.agentError}` : undefined,
                  !result.schemaPass ? "schema" : undefined,
                  !result.toolTracePass ? "tools" : undefined,
                  !result.subagentPolicyPass ? "subagent-policy" : undefined,
                  !result.graderPass
                    ? result.grader.error
                      ? `grader=${result.grader.error}`
                      : `grader=${result.grader.value?.verdict ?? "missing"}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" | ");

            console.log(
              `[${status}] ${model} / ${variant} / ${task.id} / run ${runIndex} | ${(result.durationMs / 1000).toFixed(2)}s | $${formatUsd(result.totalCostUsd)} | subagents=${result.subagentUsage.totalSubagentCalls}${reason ? ` | ${reason}` : ""}`,
            );
          }
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
    variants,
    tasks: taskSummaries,
  });

  const markdown = buildMarkdownReport({
    runId,
    generatedAt,
    models,
    variants,
    tasks: taskSummaries,
    runs,
    reasoning,
    graderModel,
    projection,
    caseResults: orderedRunCaseResults,
  });

  const buildSummaryPayload = (params: {
    models: readonly string[];
    variants: readonly BenchmarkVariant[];
    tasks: readonly BenchmarkTaskSummary[];
    runs: number;
    reasoning: ReasoningEffort;
    graderModel: string;
    projection: Projection;
    caseResults: readonly CaseResult[];
  }) => {
    const perModelTask = summarizeByModelTaskAcrossRuns({
      models: params.models,
      variants: params.variants,
      tasks: params.tasks,
      cases: params.caseResults,
    });
    const speedups = computeVariantSpeedups(perModelTask);

    return {
      runId,
      generatedAt,
      models: params.models,
      variants: params.variants,
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
        timing: {
          total: sumTimingBreakdowns(params.caseResults.map((entry) => entry.timing)),
          average: averageTimingBreakdown(
            params.caseResults.map((entry) => entry.timing),
            params.caseResults.length,
          ),
        },
        phaseTiming: summarizeTimingPhases(params.caseResults),
        subagentUsage: {
          totalCalls: params.caseResults.reduce(
            (acc, entry) => acc + entry.subagentUsage.totalSubagentCalls,
            0,
          ),
          casesUsingSubagents: params.caseResults.filter(
            (entry) => entry.subagentUsage.usedSubagents,
          ).length,
          byAction: {
            spawnAgentCalls: params.caseResults.reduce(
              (acc, entry) => acc + entry.subagentUsage.spawnAgentCalls,
              0,
            ),
            sendInputCalls: params.caseResults.reduce(
              (acc, entry) => acc + entry.subagentUsage.sendInputCalls,
              0,
            ),
            waitCalls: params.caseResults.reduce(
              (acc, entry) => acc + entry.subagentUsage.waitCalls,
              0,
            ),
            closeAgentCalls: params.caseResults.reduce(
              (acc, entry) => acc + entry.subagentUsage.closeAgentCalls,
              0,
            ),
          },
        },
        perModelTask,
        variantSpeedups: speedups,
      },
      results: params.caseResults,
    };
  };

  const summary = buildSummaryPayload({
    models,
    variants,
    tasks: taskSummaries,
    runs,
    reasoning,
    graderModel,
    projection,
    caseResults: orderedRunCaseResults,
  });

  let latestModels: readonly string[] = models;
  let latestVariants: readonly BenchmarkVariant[] = variants;
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
      latestVariants = mergeVariants({
        existingVariants: existingSnapshot.variants,
        currentVariants: variants,
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
    variants: latestVariants,
    tasks: latestTasks,
  });

  const latestProjection = estimateProjection({
    models: latestModels,
    taskCount: latestTasks.length,
    variantCount: latestVariants.length,
    runs: latestRuns,
    graderModel: latestGraderModel,
    agentPromptTokens: projection.agentPromptTokens,
    agentResponseTokens: projection.agentResponseTokens,
    graderPromptTokens: projection.graderPromptTokens,
    graderResponseTokens: projection.graderResponseTokens,
  });

  const latestSummary = buildSummaryPayload({
    models: latestModels,
    variants: latestVariants,
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
    variants: latestVariants,
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
    variants: latestVariants,
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
          `${result.model}/${result.variant}/${result.taskId}/run ${result.runIndex}: ${result.grader.error ?? "missing grader JSON verdict"}`,
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
