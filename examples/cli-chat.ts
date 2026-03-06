#!/usr/bin/env tsx

import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import {
  createNodeAgentFilesystem,
  isLlmTextModelId,
  loadLocalEnv,
  streamAgentLoop,
  type AgentLoopStream,
  type LlmInputMessage,
  type LlmThinkingLevel,
  type LlmStreamEvent,
  type LlmTextModelId,
} from "../src/index.js";

const DEFAULT_MODEL: LlmTextModelId = "chatgpt-gpt-5.4-fast";
const DEFAULT_THINKING_LEVEL: LlmThinkingLevel = "high";
const DEFAULT_MODEL_TOOLS = [
  { type: "web-search", mode: "live" },
  { type: "code-execution" },
] as const;
const CLI_OPTIONS = resolveCliOptions(process.argv.slice(2));
const MODEL = CLI_OPTIONS.model;
const THINKING_LEVEL = CLI_OPTIONS.thinkingLevel;
const EXAMPLES_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXAMPLES_DIR, "..");
const RUN_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "output",
  "cli-chat",
  new Date().toISOString().replace(/[:.]/g, "-"),
);

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  italic: "\u001B[3m",
  cyan: "\u001B[36m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
};

const INPUT_BG = "\u001B[48;5;238m";
const INPUT_FG = "\u001B[38;5;255m";
const USER_LABEL = " › ";
const STEER_LABEL = " steer› ";

const interactiveTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

type ActiveRunState = {
  call: AgentLoopStream;
  done: Promise<void>;
  pendingDeltaChannel: "thought" | "response" | null;
  pendingDeltaText: string;
  sawThoughtDelta: boolean;
  sawResponseDelta: boolean;
  sawAbort: boolean;
  sawModel: boolean;
};

const history: LlmInputMessage[] = [];
let activeRun: ActiveRunState | null = null;
let shuttingDown = false;
let rawModeEnabled = false;
let inputBuffer = "";
let composerRendered = false;

function isThinkingLevel(value: string): value is LlmThinkingLevel {
  return value === "low" || value === "medium" || value === "high";
}

function resolveCliOptions(args: readonly string[]): {
  readonly model: LlmTextModelId;
  readonly thinkingLevel: LlmThinkingLevel;
} {
  const program = new Command()
    .name("cli-chat")
    .description("Interactive local CLI chat with tool loop telemetry.")
    .option("--model <id>", "Model id to run.")
    .option(
      "--thinking-level <level>",
      "Thinking level: low, medium, high.",
      DEFAULT_THINKING_LEVEL,
    )
    .showHelpAfterError();

  program.parse(args, { from: "user" });
  const options = program.opts<{ model?: string; thinkingLevel?: string }>();

  const modelRaw = options.model?.trim() ?? DEFAULT_MODEL;
  if (!isLlmTextModelId(modelRaw)) {
    process.stderr.write(`Unsupported --model value: ${modelRaw}\n`);
    process.exit(1);
  }

  const thinkingLevelRaw = options.thinkingLevel?.trim().toLowerCase() ?? DEFAULT_THINKING_LEVEL;
  if (!isThinkingLevel(thinkingLevelRaw)) {
    process.stderr.write(`Unsupported --thinking-level value: ${thinkingLevelRaw}\n`);
    process.exit(1);
  }

  return {
    model: modelRaw,
    thinkingLevel: thinkingLevelRaw,
  };
}

loadLocalEnv();

let fallbackReadline: readline.Interface | null = null;

if (interactiveTty) {
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  rawModeEnabled = true;
  process.stdin.on("data", (chunk: string) => {
    handleInputChunk(chunk);
  });
} else {
  fallbackReadline = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  fallbackReadline.on("line", (line) => {
    void handleSubmittedLine(line);
  });
  fallbackReadline.on("close", () => {
    void shutdown();
  });
}

process.on("SIGINT", () => {
  if (activeRun) {
    activeRun.sawAbort = true;
    activeRun.call.abort();
    printSystem("Interrupt requested (Ctrl+C).");
    renderComposer();
    return;
  }
  void shutdown();
});

printBanner();
renderComposer();

function handleInputChunk(chunk: string): void {
  if (!interactiveTty || shuttingDown || chunk.length === 0) {
    return;
  }

  if (chunk === "\u0003") {
    if (activeRun) {
      activeRun.sawAbort = true;
      activeRun.call.abort();
      printSystem("Interrupt requested (Ctrl+C).");
      renderComposer();
    } else {
      void shutdown();
    }
    return;
  }

  if (chunk === "\u001b") {
    if (activeRun) {
      activeRun.sawAbort = true;
      activeRun.call.abort();
      printSystem("Interrupt requested (Esc).");
      renderComposer();
    }
    return;
  }

  if (chunk.startsWith("\u001b[") || chunk.startsWith("\u001bO")) {
    return;
  }

  for (const char of chunk) {
    if (char === "\u0003") {
      if (activeRun) {
        activeRun.sawAbort = true;
        activeRun.call.abort();
        printSystem("Interrupt requested (Ctrl+C).");
        renderComposer();
      } else {
        void shutdown();
      }
      continue;
    }

    if (char === "\u001b") {
      if (activeRun) {
        activeRun.sawAbort = true;
        activeRun.call.abort();
        printSystem("Interrupt requested (Esc).");
        renderComposer();
      }
      continue;
    }

    if (char === "\u007f" || char === "\b") {
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1);
        renderComposer();
      }
      continue;
    }

    if (char === "\r" || char === "\n") {
      const submitted = inputBuffer;
      inputBuffer = "";
      renderComposer();
      void handleSubmittedLine(submitted);
      continue;
    }

    if (char < " ") {
      continue;
    }

    inputBuffer += char;
    renderComposer();
  }
}

async function handleSubmittedLine(rawLine: string): Promise<void> {
  const line = rawLine.trim();
  if (line.length === 0) {
    renderComposer();
    return;
  }

  if (line === "/help") {
    printHelp();
    renderComposer();
    return;
  }

  if (line === "/exit" || line === "/quit") {
    await shutdown();
    return;
  }

  if (line === "/stop") {
    if (activeRun) {
      activeRun.sawAbort = true;
      activeRun.call.abort();
      printSystem("Interrupt requested (/stop).");
    } else {
      printSystem("No active run to stop.");
    }
    renderComposer();
    return;
  }

  if (activeRun) {
    renderUser(line, true);
    history.push({ role: "user", content: line });
    const appendResult = activeRun.call.append(line);
    if (!appendResult.accepted) {
      printWarning("Steering was not accepted.");
    }
    renderComposer();
    return;
  }

  renderUser(line, false);
  history.push({ role: "user", content: line });
  startRun();
}

function startRun(): void {
  const call = streamAgentLoop({
    model: MODEL,
    input: history,
    thinkingLevel: THINKING_LEVEL,
    modelTools: DEFAULT_MODEL_TOOLS,
    filesystemTool: {
      profile: "auto",
      options: {
        cwd: process.cwd(),
        fs: createNodeAgentFilesystem(),
        allowOutsideCwd: false,
      },
    },
    subagentTool: {
      enabled: true,
      model: MODEL,
    },
    logging: {
      workspaceDir: RUN_OUTPUT_DIR,
      mirrorToConsole: false,
    },
    maxSteps: 100,
  });

  const runState: ActiveRunState = {
    call,
    done: Promise.resolve(),
    pendingDeltaChannel: null,
    pendingDeltaText: "",
    sawThoughtDelta: false,
    sawResponseDelta: false,
    sawAbort: false,
    sawModel: false,
  };

  runState.done = consumeRun(runState);
  activeRun = runState;
  printSystem("Running... (Esc to interrupt, Enter to send steering)");
  renderComposer();
}

async function consumeRun(state: ActiveRunState): Promise<void> {
  try {
    for await (const event of state.call.events) {
      renderEvent(state, event);
    }

    flushPendingDeltaBuffer(state);
    const result = await state.call.result;
    if (!state.sawThoughtDelta && result.thoughts.trim().length > 0) {
      const thoughtLines = normaliseThoughtText(result.thoughts).split("\n");
      for (const line of thoughtLines) {
        writeUiLine(`${ANSI.dim}${ANSI.italic}• ${line}${ANSI.reset}`);
      }
    }

    if (result.text.trim().length > 0) {
      history.push({ role: "assistant", content: result.text });
    }

    if (state.sawResponseDelta) {
      writeUiLine("");
    }

    printSystem(
      `Completed in ${result.steps.length} step(s), total cost ~$${result.totalCostUsd.toFixed(6)}.`,
    );
  } catch (error) {
    await state.call.result.catch(() => undefined);
    flushPendingDeltaBuffer(state);
    const message = error instanceof Error ? error.message : String(error);
    if (state.sawAbort || message.toLowerCase().includes("abort")) {
      printWarning("Run interrupted.");
    } else {
      printError(message);
    }
  } finally {
    if (activeRun === state) {
      activeRun = null;
    }
    renderComposer();
  }
}

function renderEvent(state: ActiveRunState, event: LlmStreamEvent): void {
  if (event.type === "delta") {
    appendDeltaChunk(state, event.channel, event.text);
    return;
  }

  flushPendingDeltaBuffer(state);

  if (event.type === "blocked") {
    printWarning("Response was blocked.");
    return;
  }

  if (event.type === "model" && !state.sawModel) {
    state.sawModel = true;
    printSystem(`Model: ${event.modelVersion}`);
    return;
  }

  if (event.type === "tool_call") {
    if (event.phase === "started") {
      printSystem(`tool ${event.toolName} started`);
    } else {
      const status = event.error ? `error: ${event.error}` : "ok";
      const duration =
        typeof event.durationMs === "number"
          ? ` (${Math.max(0, Math.round(event.durationMs))}ms)`
          : "";
      printSystem(`tool ${event.toolName} ${status}${duration}`);
    }
    return;
  }

  if (event.type === "usage") {
    printSystem(
      `usage prompt=${event.usage.promptTokens ?? 0} response=${event.usage.responseTokens ?? 0} total=${event.usage.totalTokens ?? 0}`,
    );
    return;
  }
}

function appendDeltaChunk(
  state: ActiveRunState,
  channel: "thought" | "response",
  chunk: string,
): void {
  if (!chunk) {
    return;
  }
  if (channel === "thought") {
    state.sawThoughtDelta = true;
  } else if (!state.sawResponseDelta) {
    state.sawResponseDelta = true;
    writeUiLine("");
  }

  if (state.pendingDeltaChannel && state.pendingDeltaChannel !== channel) {
    flushPendingDeltaBuffer(state);
  }
  state.pendingDeltaChannel = channel;
  const normalisedChunk =
    channel === "thought"
      ? normaliseThoughtText(chunk)
      : chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  state.pendingDeltaText += normalisedChunk;

  while (true) {
    const newlineIndex = state.pendingDeltaText.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }
    const line = state.pendingDeltaText.slice(0, newlineIndex);
    emitDeltaLine(channel, line);
    state.pendingDeltaText = state.pendingDeltaText.slice(newlineIndex + 1);
  }

  if (shouldFlushPartialDelta(state.pendingDeltaText)) {
    emitDeltaLine(channel, state.pendingDeltaText);
    state.pendingDeltaText = "";
  }
}

function normaliseThoughtText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function shouldFlushPartialDelta(text: string): boolean {
  if (text.length < 36) {
    return false;
  }
  return /[\s.,!?;:)\]]$/u.test(text);
}

function flushPendingDeltaBuffer(state: ActiveRunState): void {
  if (state.pendingDeltaChannel && state.pendingDeltaText.length > 0) {
    emitDeltaLine(state.pendingDeltaChannel, state.pendingDeltaText);
  }
  state.pendingDeltaChannel = null;
  state.pendingDeltaText = "";
}

function emitDeltaLine(channel: "thought" | "response", text: string): void {
  if (text.length === 0) {
    return;
  }
  if (channel === "thought") {
    writeUiLine(`${ANSI.dim}${ANSI.italic}• ${text}${ANSI.reset}`);
  } else {
    writeUiLine(text);
  }
}

function renderUser(text: string, steering: boolean): void {
  const steeringTag = steering ? `${ANSI.dim}(steer)${ANSI.reset} ` : "";
  writeUiLine("");
  writeUiLine(`${ANSI.cyan}${ANSI.bold}›${ANSI.reset} ${steeringTag}${text}`);
  writeUiLine("");
}

function printBanner(): void {
  process.stdout.write(
    `${ANSI.bold}CLI Chat Steering Example${ANSI.reset}\n` +
      `${ANSI.dim}model:${ANSI.reset} ${MODEL}  ` +
      `${ANSI.dim}thinking:${ANSI.reset} ${THINKING_LEVEL}  ` +
      `${ANSI.dim}cwd:${ANSI.reset} ${process.cwd()}\n` +
      `${ANSI.dim}filesystem:${ANSI.reset} current directory and below\n` +
      `${ANSI.dim}subagents:${ANSI.reset} enabled (${MODEL})\n\n`,
  );
  printHelp(false);
}

function printHelp(usePromptAwareOutput = true): void {
  const help =
    `${ANSI.dim}Commands:${ANSI.reset}\n` +
    `${ANSI.dim}  /help${ANSI.reset} show help\n` +
    `${ANSI.dim}  /stop${ANSI.reset} stop active run\n` +
    `${ANSI.dim}  /exit${ANSI.reset} quit\n` +
    `${ANSI.dim}Startup flags:${ANSI.reset}\n` +
    `${ANSI.dim}  --model <id>${ANSI.reset} choose model (default: ${DEFAULT_MODEL})\n` +
    `${ANSI.dim}  --thinking-level <level>${ANSI.reset} low|medium|high (default: ${DEFAULT_THINKING_LEVEL})\n` +
    `${ANSI.dim}During a run: type a message and press Enter to append steering without interrupting.${ANSI.reset}\n`;

  if (!usePromptAwareOutput || !interactiveTty || shuttingDown) {
    process.stdout.write(`${help}\n`);
    return;
  }

  writeUiBlock(`${help}\n`);
}

function printSystem(message: string): void {
  writeUiLine(`${ANSI.dim}${message}${ANSI.reset}`);
}

function printWarning(message: string): void {
  writeUiLine(`${ANSI.yellow}${message}${ANSI.reset}`);
}

function printError(message: string): void {
  writeUiLine(`${ANSI.red}${message}${ANSI.reset}`);
}

function writeUiLine(line: string): void {
  if (!interactiveTty || shuttingDown) {
    process.stdout.write(`${ANSI.reset}${line}${ANSI.reset}\n`);
    return;
  }

  withComposerHidden(() => {
    process.stdout.write(`${ANSI.reset}${line}${ANSI.reset}\n`);
  });
}

function writeUiBlock(text: string): void {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    writeUiLine(line);
  }
}

function withComposerHidden(fn: () => void): void {
  if (!interactiveTty || shuttingDown) {
    fn();
    return;
  }

  if (composerRendered) {
    clearComposer();
  }

  fn();

  if (!shuttingDown) {
    renderComposer();
  }
}

function clearComposer(): void {
  if (!interactiveTty || !composerRendered) {
    return;
  }

  readline.cursorTo(process.stdout, 0);
  readline.moveCursor(process.stdout, 0, -1);

  for (let i = 0; i < 3; i += 1) {
    readline.clearLine(process.stdout, 0);
    if (i < 2) {
      readline.moveCursor(process.stdout, 0, 1);
    }
  }

  readline.cursorTo(process.stdout, 0);
  readline.moveCursor(process.stdout, 0, -2);
  composerRendered = false;
}

function renderComposer(): void {
  if (!interactiveTty || shuttingDown) {
    return;
  }

  const columns = Math.max(20, process.stdout.columns ?? 80);
  const label = activeRun ? STEER_LABEL : USER_LABEL;
  const maxInputChars = Math.max(0, columns - label.length);
  const displayInput = tailToWidth(inputBuffer, maxInputChars);
  const promptPadding = " ".repeat(Math.max(0, columns - label.length - displayInput.length));

  const spacerLine = `${INPUT_BG}${" ".repeat(columns)}${ANSI.reset}`;
  const labelStyled = activeRun
    ? `${ANSI.italic}${label}${ANSI.reset}${INPUT_BG}${INPUT_FG}`
    : `${ANSI.bold}${label}${ANSI.reset}${INPUT_BG}${INPUT_FG}`;
  const promptLine = `${INPUT_BG}${INPUT_FG}${labelStyled}${displayInput}${promptPadding}${ANSI.reset}`;

  if (composerRendered) {
    readline.cursorTo(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -1);
    process.stdout.write(`${spacerLine}\n${promptLine}\n${spacerLine}`);
  } else {
    process.stdout.write(`${spacerLine}\n${promptLine}\n${spacerLine}`);
  }

  readline.cursorTo(process.stdout, Math.min(columns - 1, label.length + displayInput.length));
  readline.moveCursor(process.stdout, 0, -1);
  composerRendered = true;
}

function tailToWidth(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  return value.slice(value.length - width);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (activeRun) {
    activeRun.call.abort();
    await activeRun.done.catch(() => undefined);
  }

  if (interactiveTty && composerRendered) {
    clearComposer();
  }

  if (fallbackReadline) {
    const rl = fallbackReadline;
    fallbackReadline = null;
    rl.close();
  }

  if (process.stdin.isTTY && rawModeEnabled) {
    process.stdin.setRawMode(false);
    rawModeEnabled = false;
  }

  process.stdout.write(`\n${ANSI.dim}Bye.${ANSI.reset}\n`);
  process.exit(0);
}
