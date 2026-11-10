#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, open } from "node:fs/promises";
import { appendFileSync, constants } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  isLlmTextModelId,
  loadLocalEnv,
  resolveModelRef,
  resolveThinkingLevel,
  runToolLoop,
  type LlmSpeed,
  type LlmStreamEvent,
  type LlmTextModelSelection,
  type LlmThinkingLevel,
} from "@ljoukov/llm";
import { startBridge, type BrowserBridge } from "./bridge.js";
import { connectBridge } from "./bridge-client.js";
import { BrowserSession } from "./browser.js";
import { parseBrowserAction, createBrowserTools, describeBrowserTool } from "./tool.js";
import { runInteractive } from "./interactive.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultState = path.join(packageRoot, ".local", "bridge.json");

const help = `llm-browser-agent — browser agent CLI using @ljoukov/llm

  llm-browser-agent [chat]              # interactive tasks and local slash commands
  llm-browser-agent bridge [--port 3219] [--state <file>]
  llm-browser-agent status [--state <file>]
  llm-browser-agent call '<browser action JSON>' [--state <file>]
  llm-browser-agent session [--state <file>]   # JSONL in/out, persistent element refs
  llm-browser-agent run '<task>' [--model openai:subscription:gpt-6.1-sol]
  llm-browser-agent prompt [--instructions <file>]

Options:
  --instructions <file>  Replace the complete harness instruction text
  --task-file <file|->   Read a task from a UTF-8 file or stdin
  --speed <value>        standard, fast, or ultrafast (validated by llm)
  --thinking <level>     low, medium, high, xhigh, max, or ultra
  --max-steps <number>   Maximum model turns (default 40)
  --audit <file>         JSONL audit file (default artifacts/<timestamp>.jsonl)
  --state <file>         Local bridge connection file (contains a pairing secret)

Load extension/ through chrome://extensions (Load unpacked), then paste the
pairing URL printed by chat or bridge into the extension popup. Chrome's normal
installation/debugger UI still applies. No per-domain confirmation layer is added.
Interactive chat starts a bridge automatically when needed.
`;

type State = { version: 1; port: number; token: string };

async function readState(filename: string): Promise<State> {
  let state: unknown;
  try {
    state = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new Error("No valid bridge state. Start `llm-browser-agent bridge` first.");
  }
  if (
    !state ||
    typeof state !== "object" ||
    !("version" in state) ||
    state.version !== 1 ||
    !("port" in state) ||
    !Number.isSafeInteger(state.port) ||
    Number(state.port) < 1 ||
    Number(state.port) > 65535 ||
    !("token" in state) ||
    typeof state.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.token)
  ) {
    throw new Error("Invalid bridge state. Remove it and start `llm-browser-agent bridge` again.");
  }
  return state as State;
}

function clientUrl(state: State) {
  return `ws://127.0.0.1:${state.port}/client?token=${state.token}`;
}

function positiveInteger(value: string, label: string, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`${label} must be a positive integer <= ${max}.`);
  return number;
}

async function launchBridge(stateFile: string, requestedPort?: string): Promise<BrowserBridge> {
  let previous: State | undefined;
  try {
    previous = await readState(stateFile);
  } catch {
    /* First pairing. */
  }
  const bridge = await startBridge({
    port: requestedPort
      ? positiveInteger(requestedPort, "--port", 65535)
      : (previous?.port ?? 3219),
    token: previous?.token ?? randomBytes(32).toString("hex"),
    requestTimeoutMs: 45_000,
  });
  try {
    await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const stateHandle = await open(
      stateFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await stateHandle.chmod(0o600);
      await stateHandle.writeFile(
        `${JSON.stringify({ version: 1, port: bridge.port, token: bridge.token })}\n`,
      );
    } finally {
      await stateHandle.close();
    }
    return bridge;
  } catch (error) {
    await bridge.close();
    throw error;
  }
}

function printPairing(bridge: { extensionUrl: string; port: number }) {
  process.stdout.write(
    `Bridge listening on 127.0.0.1:${bridge.port}\nExtension: ${path.join(packageRoot, "extension")}\nPaste this pairing URL into the extension popup (keep it private):\n${bridge.extensionUrl}\n`,
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      state: { type: "string", default: defaultState },
      port: { type: "string" },
      instructions: { type: "string" },
      model: { type: "string", default: "openai:subscription:gpt-6.1-sol" },
      speed: { type: "string" },
      thinking: { type: "string" },
      "max-steps": { type: "string", default: "40" },
      "task-file": { type: "string" },
      audit: { type: "string" },
    },
  });
  const [requestedCommand, ...args] = positionals;
  const command = requestedCommand ?? "chat";
  if (values.help) return process.stdout.write(help);
  const stateFile = path.resolve(values.state);

  if (command === "bridge") {
    const bridge = await launchBridge(stateFile, values.port);
    try {
      printPairing(bridge);
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } finally {
      await bridge.close();
    }
    return;
  }

  const instructions = (
    await readFile(values.instructions ?? path.join(packageRoot, "prompts", "browser.md"), "utf8")
  ).trim();
  if (!instructions)
    throw new Error("Instructions must be nonblank (llm supplies a fallback when blank).");
  if (command === "prompt") {
    process.stdout.write(
      `${JSON.stringify({ instructions, tools: [describeBrowserTool()], scope: "Harness-authored inputs; llm serialization and model-provider behavior are separate." }, null, 2)}\n`,
    );
    return;
  }
  if (!["run", "call", "session", "status", "chat"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  let ownedBridge: BrowserBridge | undefined;
  let client: Awaited<ReturnType<typeof connectBridge>>;
  try {
    client = await connectBridge(clientUrl(await readState(stateFile)), {
      requestTimeoutMs: 50_000,
    });
  } catch (error) {
    if (command !== "chat") throw error;
    ownedBridge = await launchBridge(stateFile, values.port);
    try {
      client = await connectBridge(ownedBridge.clientUrl, { requestTimeoutMs: 50_000 });
    } catch (connectionError) {
      await ownedBridge.close();
      throw connectionError;
    }
  }
  try {
    const status = await client.request<{ connected: boolean }>("browser.status");
    if (command === "status") return process.stdout.write(`${JSON.stringify(status)}\n`);
    if (!status.connected && command !== "chat")
      throw new Error(
        "Chrome extension is disconnected. Pair it using the URL printed by `llm-browser-agent bridge`.",
      );
    const session = new BrowserSession(client);
    if (command === "chat") {
      if (!status.connected) {
        const state = await readState(stateFile);
        printPairing({
          port: state.port,
          extensionUrl: `ws://127.0.0.1:${state.port}/extension?token=${state.token}`,
        });
      }
      loadLocalEnv();
      const selection = resolveModelRef({
        model: values.model,
        speed: values.speed as LlmSpeed | undefined,
      });
      if (!isLlmTextModelId(selection.model))
        throw new Error("--model must select a supported text model.");
      const thinkingLevel = values.thinking as LlmThinkingLevel | undefined;
      resolveThinkingLevel({ ...selection, thinkingLevel, thinkingLevelPolicy: "strict" });
      const auditFile = path.resolve(
        values.audit ??
          path.join(
            packageRoot,
            "artifacts",
            `chat-${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
          ),
      );
      await mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
      const audit = await open(auditFile, "wx", 0o600);
      try {
        process.stderr.write(`Audit: ${auditFile}\n`);
        await runInteractive({
          session,
          client,
          instructions,
          selection: selection as LlmTextModelSelection,
          thinkingLevel,
          maxSteps: positiveInteger(values["max-steps"], "--max-steps", 1000),
          settingsPath: path.join(path.dirname(stateFile), "settings.json"),
          explicitSelection: process.argv.some(
            (arg) =>
              arg === "--model" ||
              arg.startsWith("--model=") ||
              arg === "--speed" ||
              arg.startsWith("--speed="),
          ),
          explicitThinking: process.argv.some(
            (arg) => arg === "--thinking" || arg.startsWith("--thinking="),
          ),
          audit: (entry) => appendFileSync(audit.fd, `${JSON.stringify(entry)}\n`),
        });
      } finally {
        await audit.close();
      }
      return;
    }

    if (command === "session") {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let id: string | number | null = null;
        try {
          const request: unknown = JSON.parse(line);
          if (
            request &&
            typeof request === "object" &&
            "id" in request &&
            (typeof request.id === "string" || typeof request.id === "number")
          )
            id = request.id;
          const result = await session.execute(parseBrowserAction(request));
          process.stdout.write(`${JSON.stringify({ id, result })}\n`);
        } catch (error) {
          process.stdout.write(
            `${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`,
          );
        }
      }
      return;
    }
    if (command === "call") {
      const input = parseBrowserAction(JSON.parse(args.join(" ")));
      const result = await session.execute(input);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const task = values["task-file"]
      ? values["task-file"] === "-"
        ? await readStdin()
        : await readFile(values["task-file"], "utf8")
      : args.join(" ");
    if (!task.trim()) throw new Error("Supply a task or --task-file.");
    const maxSteps = positiveInteger(values["max-steps"], "--max-steps", 1000);
    if (values.speed && !["standard", "fast", "ultrafast"].includes(values.speed))
      throw new Error("Invalid --speed.");
    const selection = resolveModelRef({
      model: values.model,
      speed: values.speed as LlmSpeed | undefined,
    });
    if (!isLlmTextModelId(selection.model))
      throw new Error("--model must select a supported text model.");
    const thinkingLevel = values.thinking as LlmThinkingLevel | undefined;
    resolveThinkingLevel({ ...selection, thinkingLevel, thinkingLevelPolicy: "strict" });
    // Uses llm's current-directory environment/auth conventions. No key creation or copying.
    loadLocalEnv();
    const auditFile = path.resolve(
      values.audit ??
        path.join(
          packageRoot,
          "artifacts",
          `${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
        ),
    );
    await mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    const audit = await open(auditFile, "wx", 0o600);
    const record = (entry: unknown) => {
      // Preserve event order and fail immediately if an audit record cannot be written.
      appendFileSync(audit.fd, `${JSON.stringify(entry)}\n`);
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      record({
        type: "harness_input",
        at: new Date().toISOString(),
        selection,
        instructions,
        input: task,
        maxSteps,
        tools: [describeBrowserTool()],
      });
      process.stderr.write(`Audit: ${auditFile}\n`);
      const result = await runToolLoop({
        ...(selection as LlmTextModelSelection),
        instructions,
        input: task,
        thinkingLevel,
        thinkingLevelPolicy: "strict",
        tools: createBrowserTools(session),
        maxSteps,
        signal: controller.signal,
        onEvent: (event: LlmStreamEvent) => {
          record({ type: "model_event", at: new Date().toISOString(), event });
          if (event.type === "tool_call" && event.phase === "started") {
            // Avoid writing page text, form values, expressions or URLs to terminal logs.
            const action =
              typeof event.input === "object" && event.input && "action" in event.input
                ? event.input.action
                : "tool";
            process.stderr.write(`[browser ${String(action)}]\n`);
          }
        },
      });
      record({ type: "result", at: new Date().toISOString(), result });
      process.stdout.write(`${result.text}\n`);
    } catch (error) {
      record({
        type: "failure",
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      await audit.close();
    }
  } finally {
    try {
      await client.close();
    } finally {
      await ownedBridge?.close();
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
