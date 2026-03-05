import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  createGeminiReadFileTool,
  createGlobTool,
  createListDirectoryTool,
  createWriteFileTool,
  isLlmTextModelId,
  LLM_TEXT_MODEL_IDS,
  loadLocalEnv,
  runAgentLoop,
  streamText,
  tool,
  type LlmTextModelId,
  type LlmStreamEvent,
} from "../../src/index.js";

const BENCH_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(BENCH_ROOT, "..", "..");
const WORKSPACES_ROOT = resolve(BENCH_ROOT, "workspaces");
const FIXTURE_IMAGE_PATH = resolve(BENCH_ROOT, "input", "rome-colosseum.jpg");
const AGENT_OUTPUT_ROOT = resolve(
  REPO_ROOT,
  "output",
  "benchmark-view-image",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const DEFAULT_MODELS = [...LLM_TEXT_MODEL_IDS] as const;

type BenchmarkCaseResult = {
  readonly model: string;
  readonly workspace: string;
  readonly success: boolean;
  readonly parsed?: {
    country_code_2_letter?: unknown;
    city?: unknown;
  };
  readonly error?: string;
};

function toModelList(raw: string | undefined): LlmTextModelId[] {
  const candidates = (
    raw
      ? raw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [...DEFAULT_MODELS]
  ) as string[];

  const invalid = candidates.filter((model) => !isLlmTextModelId(model));
  if (invalid.length > 0) {
    throw new Error(`Unsupported model ids: ${invalid.join(", ")}`);
  }

  return [...new Set(candidates)] as LlmTextModelId[];
}

function toRepoRelativePath(absolutePath: string): string {
  const relativePath = path.relative(REPO_ROOT, absolutePath);
  return relativePath.replaceAll(path.sep, "/");
}

function detectImageMimeType(buffer: Buffer, filePath: string): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return undefined;
}

function logEvent(model: string, event: LlmStreamEvent): void {
  if (event.type === "delta") {
    console.log(`[${model}] delta:${event.channel} ${event.text}`);
    return;
  }
  if (event.type === "tool_call") {
    if (event.phase === "started") {
      console.log(
        `[${model}] tool:start ${event.toolName} turn=${event.turn} idx=${event.toolIndex} input=${JSON.stringify(event.input)}`,
      );
    } else {
      console.log(
        `[${model}] tool:end ${event.toolName} turn=${event.turn} idx=${event.toolIndex} error=${event.error ?? "none"}`,
      );
    }
    return;
  }
  if (event.type === "usage") {
    console.log(
      `[${model}] usage total=${event.usage.totalTokens} prompt=${event.usage.promptTokens} response=${event.usage.responseTokens}`,
    );
    return;
  }
  if (event.type === "model") {
    console.log(`[${model}] model ${event.modelVersion}`);
  }
}

async function runSingleModel(model: LlmTextModelId): Promise<BenchmarkCaseResult> {
  const workspace = resolve(WORKSPACES_ROOT, model);
  const workspaceRel = toRepoRelativePath(workspace);
  await mkdir(workspace, { recursive: true });

  const taskPath = resolve(workspace, "task.md");
  const imagePath = resolve(workspace, "image.jpg");
  const outputPath = resolve(workspace, "result.json");

  const task = [
    "Find image files in the current directory.",
    "Use view_image to inspect each image.",
    "Identify the city shown.",
    "Write result.json using write_file.",
    "Write JSON to result.json with exactly this shape:",
    '{"country_code_2_letter":"XX","city":"..."}',
    "country_code_2_letter must be uppercase 2-letter ISO code.",
    "Use city name in English.",
    "After writing result.json, send a short done message.",
  ].join("\n");

  await cp(FIXTURE_IMAGE_PATH, imagePath);
  await writeFile(taskPath, task, "utf8");

  try {
    const result = await runAgentLoop({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a strict benchmark agent. Execute task.md exactly using tools and modify files in workspace.",
        },
        {
          role: "user",
          content: "Read task.md and follow it exactly.",
        },
      ],
      tools: {
        read_file: createGeminiReadFileTool({ cwd: workspace }),
        list_directory: createListDirectoryTool({ cwd: workspace }),
        glob: createGlobTool({ cwd: workspace }),
        write_file: createWriteFileTool({ cwd: workspace }),
        view_image: tool({
          description: "Inspect a local image and return a concise city/country description.",
          inputSchema: z.object({ path: z.string().min(1) }).strict(),
          execute: async (input) => {
            const targetPath = path.isAbsolute(input.path)
              ? input.path
              : resolve(workspace, input.path);
            const bytes = await readFile(targetPath);
            const mimeType = detectImageMimeType(bytes, targetPath);
            if (!mimeType) {
              throw new Error(`Unsupported image format: ${targetPath}`);
            }
            const imageUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
            const inspection = await streamText({
              model,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: [
                        "Identify the city and country code shown in this image.",
                        "Reply with one short sentence.",
                      ].join(" "),
                    },
                    {
                      type: "inlineData",
                      data: imageUrl.replace(/^data:[^;]+;base64,/, ""),
                      mimeType,
                    },
                  ],
                },
              ],
              thinkingLevel: "low",
            }).result;
            return inspection.text;
          },
        }),
      },
      maxSteps: 20,
      thinkingLevel: "low",
      onEvent: (event) => logEvent(model, event),
      logging: {
        workspaceDir: AGENT_OUTPUT_ROOT,
        mirrorToConsole: false,
      },
    });

    const outputRaw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(outputRaw) as { country_code_2_letter?: unknown; city?: unknown };

    await writeFile(
      resolve(workspace, "agent-run.json"),
      `${JSON.stringify(
        {
          model,
          workspace: workspaceRel,
          outputRaw,
          parsed,
          finalText: result.text,
          steps: result.steps,
          totalCostUsd: result.totalCostUsd,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const success = parsed.country_code_2_letter === "IT" && parsed.city === "Rome";
    console.log(`[${model}] workspace: ${workspaceRel}`);
    console.log(`[${model}] benchmark ${success ? "PASS" : "FAIL"}`);

    return {
      model,
      workspace: workspaceRel,
      success,
      parsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(resolve(workspace, "agent-run-error.txt"), `${message}\n`, "utf8");
    console.log(`[${model}] workspace: ${workspaceRel}`);
    console.log(`[${model}] benchmark ERROR: ${message}`);
    return {
      model,
      workspace: workspaceRel,
      success: false,
      error: message,
    };
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  const { values } = parseArgs({
    options: {
      models: {
        type: "string",
      },
    },
  });

  const models = toModelList(values.models);
  if (models.length === 0) {
    throw new Error("No models selected.");
  }

  await rm(WORKSPACES_ROOT, { recursive: true, force: true });
  await mkdir(WORKSPACES_ROOT, { recursive: true });

  const results = await Promise.all(
    models.map(async (model) => {
      console.log(`\\n=== Running view_image benchmark for ${model} ===`);
      return await runSingleModel(model);
    }),
  );

  const passCount = results.filter((result) => result.success).length;
  console.log("\\n=== Benchmark summary ===");
  for (const result of results) {
    console.log(
      `${result.model}: ${result.success ? "PASS" : "FAIL"} workspace=${result.workspace}`,
    );
  }
  console.log(`pass=${passCount}/${results.length}`);
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
