import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  OPENAI_SUBSCRIPTION_MODEL_IDS,
  isLlmTextModelId,
  resolveModelRef,
  resolveThinkingLevel,
  runToolLoop,
  type LlmInputMessage,
  type LlmThinkingLevel,
  type LlmTextModelSelection,
  type LlmToolLoopResult,
} from "@ljoukov/llm";
import type { BridgeClient } from "./bridge-client.js";
import type { BrowserSession } from "./browser.js";
import { createBrowserTools, describeBrowserTool } from "./tool.js";

export type DomainPolicy = {
  mode: "all" | "allowlist";
  allow: string[];
  block: string[];
};

export type InteractiveOptions = {
  session: BrowserSession;
  client: BridgeClient;
  instructions: string;
  selection: LlmTextModelSelection;
  thinkingLevel?: LlmThinkingLevel;
  explicitSelection?: boolean;
  explicitThinking?: boolean;
  maxSteps: number;
  settingsPath: string;
  audit: (entry: unknown) => void;
  input?: Readable;
  output?: Writable;
  error?: Writable;
  runner?: typeof runToolLoop;
};

type Settings = {
  version: 1;
  selection: LlmTextModelSelection;
  thinkingLevel?: LlmThinkingLevel;
  policy?: DomainPolicy;
};

const thinkingLevels: readonly LlmThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const modelChoices = OPENAI_SUBSCRIPTION_MODEL_IDS.map((model) => `openai:subscription:${model}`);
const help = `Commands (handled locally):
  /domains                       Show browser permissions
  /domains inspect <tabId>       Show frame-origin permission diagnostics
  /domains allow <host|origin>    Add an origin or *.domain wildcard; enables allowlist mode
  /domains block <host|origin>    Block an origin or *.domain wildcard
  /domains remove <host|origin>   Remove an exact rule or wildcard pattern
  /domains only <origins,...>     Replace the allowlist
  /domains clear                 Allow no websites
  /domains all                   Allow all websites and remove rules
  /model                         Select model and thinking level
  /model <model> [thinking]       Set a canonical provider:access:model
  /thinking <level|default>       Set thinking independently
  /speed <standard|fast|ultrafast|default>
  /usage                         Show measured session usage and cost
  /cancel                        Cancel a running task or selection menu
  /quit                          Cancel any active task and exit
  /help                          Show these commands
Host shorthand means https://host. Use an explicit http:// origin for local HTTP sites.
*.example.com includes example.com and its subdomains, with the same scheme and port.
Domain rules govern agent access, including frame navigations; they do not restrict every site resource.
`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOrigin(value: string): string {
  if (!value) throw new Error("Use an HTTP(S) origin or a leftmost *.domain wildcard.");
  const source = value.includes("://") ? value : `https://${value}`;
  const wildcard = /^[a-z][a-z0-9+.-]*:\/\/\*\./i.test(source);
  const withoutWildcard = wildcard ? source.replace(/(:\/\/)\*\./, "$1") : source;
  if (withoutWildcard.includes("*")) {
    throw new Error("Only a single leftmost *.domain wildcard is supported.");
  }
  let url: URL;
  try {
    url = new URL(withoutWildcard);
  } catch {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Use an HTTP(S) origin without a path, credentials, query, or fragment: ${value}`,
    );
  }
  if (wildcard) {
    const labels = url.hostname.split(".");
    if (
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      labels.length < 2 ||
      !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    ) {
      throw new Error(
        "Wildcard rules require a DNS base with at least two labels, such as *.example.com; IP wildcards are not supported.",
      );
    }
    return `${url.protocol}//*.${url.host}`;
  }
  return url.origin;
}

function normalizePolicy(value: unknown): DomainPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    !("mode" in value) ||
    !["all", "allowlist"].includes(String(value.mode)) ||
    !("allow" in value) ||
    !Array.isArray(value.allow) ||
    !("block" in value) ||
    !Array.isArray(value.block)
  ) {
    throw new Error("Invalid domain policy returned or saved.");
  }
  const origins = (list: unknown[]) => [
    ...new Set(
      list.map((entry) => {
        if (typeof entry !== "string") throw new Error("Domain policy origins must be strings.");
        return normalizeOrigin(entry);
      }),
    ),
  ];
  return {
    mode: value.mode as DomainPolicy["mode"],
    allow: origins(value.allow),
    block: origins(value.block),
  };
}

function selectedModel(value: unknown): LlmTextModelSelection {
  if (!value || typeof value !== "object" || !("model" in value) || typeof value.model !== "string")
    throw new Error("Invalid saved model selection.");
  const resolved = resolveModelRef(value as Parameters<typeof resolveModelRef>[0]);
  if (!isLlmTextModelId(resolved.model)) throw new Error("Select a supported text model.");
  return resolved as LlmTextModelSelection;
}

function thinking(
  value: string | undefined,
  selection: LlmTextModelSelection,
): LlmThinkingLevel | undefined {
  if (value === undefined || value === "default" || value === "auto") return undefined;
  if (!(thinkingLevels as readonly string[]).includes(value))
    throw new Error(`Thinking must be one of ${thinkingLevels.join(", ")}, or default.`);
  const level = value as LlmThinkingLevel;
  resolveThinkingLevel({ ...selection, thinkingLevel: level, thinkingLevelPolicy: "strict" });
  return level;
}

function modelLabel(selection: LlmTextModelSelection): string {
  const resolved = resolveModelRef(selection);
  return `${resolved.provider}:${resolved.access}:${resolved.model}`;
}

async function readSettings(filename: string): Promise<Settings | undefined> {
  let content: string;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("selection" in parsed)
  )
    throw new Error("Invalid interactive settings file.");
  const selection = selectedModel(parsed.selection);
  const level =
    "thinkingLevel" in parsed && parsed.thinkingLevel !== undefined
      ? thinking(String(parsed.thinkingLevel), selection)
      : undefined;
  const policy =
    "policy" in parsed && parsed.policy !== undefined ? normalizePolicy(parsed.policy) : undefined;
  return { version: 1, selection, thinkingLevel: level, policy };
}

async function saveSettings(filename: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Interactive commands are trusted local control input, never model messages. */
export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errors = options.error ?? process.stderr;
  const runner = options.runner ?? runToolLoop;
  const write = (text: string) => {
    output.write(text);
  };
  const report = (error: unknown) => {
    errors.write(`${message(error)}\n`);
  };
  const audit = (entry: unknown) => {
    try {
      options.audit(entry);
    } catch (error) {
      errors.write(`Audit error: ${message(error)}\n`);
    }
  };
  const saved = await readSettings(options.settingsPath);
  let selection =
    options.explicitSelection || !saved ? selectedModel(options.selection) : saved.selection;
  let level =
    options.explicitThinking || !saved
      ? thinking(options.thinkingLevel, selection)
      : thinking(saved.thinkingLevel, selection);
  let policy: DomainPolicy | undefined = saved?.policy;
  let policyOwned = saved?.policy !== undefined;
  let policySynced = false;
  try {
    policy = policy
      ? normalizePolicy(await options.client.request("policy.set", { policy }))
      : normalizePolicy(await options.client.request("policy.get"));
    policySynced = true;
  } catch (error) {
    report(
      `Chrome policy unavailable: ${message(error)}. Pair the extension to use browser permissions.`,
    );
  }

  let history: LlmInputMessage[] = [];
  let generation = 0;
  let quitting = false;
  let inputClosed = false;
  let menu: { kind: "model" } | { kind: "thinking"; selection: LlmTextModelSelection } | undefined;
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  let commands = Promise.resolve();
  const totals = {
    tasks: 0,
    completed: 0,
    turns: 0,
    cancelled: 0,
    failed: 0,
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    total: 0,
    actual: 0,
    actualUnknown: 0,
    subscription: 0,
    equivalent: 0,
    equivalentKnown: 0,
    unreported: 0,
  };

  const settings = (next: Partial<Settings> = {}): Settings => ({
    version: 1,
    selection,
    thinkingLevel: level,
    policy: policyOwned ? policy : undefined,
    ...next,
  });
  const current = () => {
    const resolvedThinking = level
      ? resolveThinkingLevel({ ...selection, thinkingLevel: level, thinkingLevelPolicy: "strict" })
      : undefined;
    write(
      `Model: ${modelLabel(selection)}\nThinking: ${level ?? "provider default"}${resolvedThinking?.effectiveLevel && resolvedThinking.effectiveLevel !== level ? ` (effective ${resolvedThinking.effectiveLevel})` : ""}\nSpeed: ${selection.speed ?? "provider default"}\n`,
    );
  };
  const addUsage = (result: LlmToolLoopResult) => {
    totals.turns += result.steps.length;
    for (const step of result.steps) {
      if (step.usage) {
        totals.input += step.usage.promptTokens ?? 0;
        totals.output += step.usage.responseTokens ?? 0;
        totals.cached += step.usage.cachedTokens ?? 0;
        totals.reasoning += step.usage.thinkingTokens ?? 0;
        totals.total += step.usage.totalTokens ?? 0;
      } else totals.unreported += 1;
      if (typeof step.costUsd === "number") totals.actual += step.costUsd;
      else if (step.costSource === "subscription") totals.subscription += 1;
      else totals.actualUnknown += 1;
      if (typeof step.apiEquivalentCostUsd === "number") {
        totals.equivalent += step.apiEquivalentCostUsd;
        totals.equivalentKnown += 1;
      }
    }
  };
  const usage = () => {
    write(
      `Usage:\nTasks: ${totals.tasks}; completed: ${totals.completed}; model turns: ${totals.turns}; cancelled: ${totals.cancelled}; failed: ${totals.failed}${active ? "; one task running" : ""}\nInput tokens: ${totals.input}\nOutput tokens: ${totals.output}\nCached tokens: ${totals.cached}\nReasoning tokens: ${totals.reasoning}\nTotal tokens (provider-reported): ${totals.total}\nActual cost: $${totals.actual.toFixed(6)} known; ${totals.subscription} subscription turns covered; ${totals.actualUnknown} turns unknown\nAPI-equivalent: ${totals.equivalentKnown ? `$${totals.equivalent.toFixed(6)}` : "unreported"} (token-value estimate, not an additional subscription charge)\n`,
    );
    if (totals.unreported || totals.cancelled || totals.failed)
      write(
        `Usage can be incomplete: ${totals.unreported} completed turns lacked token data; failed/cancelled requests may have unreported usage.\n`,
      );
  };
  const cancel = async () => {
    const task = active;
    if (!task) return;
    task.controller.abort();
    await task.done;
  };

  const lines = createInterface({
    input,
    output,
    terminal: Boolean("isTTY" in input && input.isTTY && "isTTY" in output && output.isTTY),
    crlfDelay: Infinity,
  });
  const prompt = () => {
    if (!quitting && !inputClosed && "isTTY" in input && input.isTTY) {
      lines.setPrompt("> ");
      lines.prompt();
    }
  };
  const startTask = (task: string) => {
    if (active) {
      write("A task is running; use /cancel or wait.\n");
      return;
    }
    if (!policySynced && saved?.policy) {
      report(
        "Saved domain permissions have not reached Chrome. Use /domains to reconnect before running a task.",
      );
      return;
    }
    const controller = new AbortController();
    const requestHistory: LlmInputMessage[] = [
      ...history,
      { role: "user" as const, content: task },
    ].slice(-19);
    const taskGeneration = generation;
    const taskSelection = selection;
    const taskLevel = level;
    options.session.resetMediaBudget?.();
    const taskState = { controller, done: Promise.resolve() };
    active = taskState;
    totals.tasks += 1;
    taskState.done = (async () => {
      audit({
        type: "harness_input",
        at: new Date().toISOString(),
        selection: taskSelection,
        thinkingLevel: taskLevel,
        instructions: options.instructions,
        input: requestHistory,
        maxSteps: options.maxSteps,
        tools: [describeBrowserTool()],
      });
      try {
        const result = await runner({
          ...taskSelection,
          instructions: options.instructions,
          input: requestHistory,
          thinkingLevel: taskLevel,
          thinkingLevelPolicy: "strict",
          tools: createBrowserTools(options.session),
          maxSteps: options.maxSteps,
          signal: controller.signal,
          onEvent(event) {
            audit({ type: "model_event", at: new Date().toISOString(), event });
            if (event.type === "tool_call" && event.phase === "started") {
              const action =
                event.input && typeof event.input === "object" && "action" in event.input
                  ? event.input.action
                  : "tool";
              write(`[browser ${String(action)}]\n`);
            }
          },
        });
        addUsage(result);
        if (!controller.signal.aborted && taskGeneration === generation) {
          totals.completed += 1;
          history = [...requestHistory, { role: "assistant" as const, content: result.text }].slice(
            -20,
          );
          write(`${result.text}\n`);
        } else totals.cancelled += 1;
        audit({
          type: "result",
          at: new Date().toISOString(),
          result,
          cancelled: controller.signal.aborted,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          totals.cancelled += 1;
          write("Task cancelled.\n");
        } else {
          totals.failed += 1;
          report(error);
        }
        audit({
          type: "failure",
          at: new Date().toISOString(),
          message: message(error),
          cancelled: controller.signal.aborted,
        });
      } finally {
        if (active === taskState) active = undefined;
        prompt();
      }
    })();
  };

  const changeModel = async (
    nextSelection: LlmTextModelSelection,
    nextLevel: LlmThinkingLevel | undefined,
  ) => {
    thinking(nextLevel, nextSelection);
    await saveSettings(
      options.settingsPath,
      settings({ selection: nextSelection, thinkingLevel: nextLevel }),
    );
    selection = nextSelection;
    level = nextLevel;
    audit({
      type: "local_settings",
      at: new Date().toISOString(),
      selection,
      thinkingLevel: level,
    });
    current();
    if (active) write("New model settings apply to the next task.\n");
  };

  const domains = async (args: string[]) => {
    if (args[0] === "inspect") {
      const tabId = Number(args[1]);
      if (args.length !== 2 || !Number.isSafeInteger(tabId) || tabId <= 0)
        throw new Error("Use /domains inspect <positive tab ID>.");
      const inspection = await options.client.request("policy.inspect", { tabId });
      write(`${JSON.stringify(inspection, null, 2)}\n`);
      audit({ type: "local_policy_inspection", at: new Date().toISOString(), inspection });
      return;
    }
    if (!args.length) {
      try {
        policy = normalizePolicy(
          await options.client.request(
            !policySynced && policyOwned && policy ? "policy.set" : "policy.get",
            !policySynced && policyOwned && policy ? { policy } : {},
          ),
        );
        policySynced = true;
      } catch (error) {
        policySynced = false;
        report(`Chrome policy unavailable: ${message(error)}`);
      }
      write(
        `Domains: ${policySynced ? "" : "not confirmed in Chrome; "}${policy ? (policy.mode === "all" ? "all origins allowed except blocked rules" : "only allowlisted origins") : "unavailable"}\nAllowed: ${policy?.allow.join(", ") || "(none)"}\nBlocked: ${policy?.block.join(", ") || "(none)"}\nUse /domains allow|block|remove <host-or-origin>, /domains only <origins,...>, /domains all, or /domains clear.\n`,
      );
      return;
    }
    const action = args.shift();
    if (!["all", "clear", "allow", "block", "remove", "only"].includes(action ?? ""))
      throw new Error("Unknown /domains action. Use /domains for syntax.");
    const entries = args
      .join(" ")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(normalizeOrigin);
    if (["allow", "block", "remove", "only"].includes(action ?? "") && !entries.length)
      throw new Error("Supply at least one host or origin.");
    if (["all", "clear"].includes(action ?? "") && entries.length)
      throw new Error(`/domains ${action} takes no origins.`);
    const base = policy ?? normalizePolicy(await options.client.request("policy.get"));
    let next: DomainPolicy = { mode: base.mode, allow: [...base.allow], block: [...base.block] };
    if (action === "all") next = { mode: "all", allow: [], block: [] };
    if (action === "clear") next = { mode: "allowlist", allow: [], block: [] };
    if (action === "only") next = { mode: "allowlist", allow: [...new Set(entries)], block: [] };
    if (action === "allow")
      next = {
        mode: "allowlist",
        allow: [...new Set([...next.allow, ...entries])],
        block: next.block.filter((origin) => !entries.includes(origin)),
      };
    if (action === "block")
      next = {
        ...next,
        allow: next.allow.filter((origin) => !entries.includes(origin)),
        block: [...new Set([...next.block, ...entries])],
      };
    if (action === "remove")
      next = {
        ...next,
        allow: next.allow.filter((origin) => !entries.includes(origin)),
        block: next.block.filter((origin) => !entries.includes(origin)),
      };
    await cancel();
    generation += 1;
    history = [];
    const resettable = options.session as BrowserSession & { reset?: () => void };
    resettable.reset?.();
    const applied = normalizePolicy(await options.client.request("policy.set", { policy: next }));
    policy = applied;
    policyOwned = true;
    policySynced = true;
    await saveSettings(options.settingsPath, settings({ policy: applied }));
    audit({ type: "local_policy", at: new Date().toISOString(), policy: applied });
    write("Domains updated. Conversation history and element refs were cleared.\n");
  };

  const parseSelection = (model: string): LlmTextModelSelection =>
    selectedModel(resolveModelRef({ model, speed: selection.speed }));
  const handleLine = async (raw: string) => {
    const line = raw.trim();
    if (!line || quitting) return;
    if (line.startsWith("/")) {
      const [command, ...args] = line.split(/\s+/);
      audit({ type: "local_command", at: new Date().toISOString(), command: line });
      if (command === "/quit" || command === "/exit") {
        quitting = true;
        await cancel();
        lines.close();
        return;
      }
      if (command === "/cancel") {
        menu = undefined;
        if (active) await cancel();
        else write("No task running.\n");
        return;
      }
      if (command === "/help") {
        write(help);
        return;
      }
      if (command === "/usage") {
        usage();
        return;
      }
      if (command === "/domains") {
        await domains(args);
        return;
      }
      if (command === "/model") {
        if (args.length) {
          if (args.length > 2) throw new Error("Use /model <canonical-model> [thinking].");
          const next = parseSelection(args[0] ?? "");
          await changeModel(next, args[1] ? thinking(args[1], next) : thinking(level, next));
          menu = undefined;
        } else {
          current();
          write(
            `${modelChoices.map((model, index) => `${index + 1}. ${model}`).join("\n")}\nChoose a model number or canonical provider:access:model; /cancel closes the menu.\n`,
          );
          menu = { kind: "model" };
        }
        return;
      }
      if (command === "/thinking") {
        if (!args.length) {
          current();
          return;
        }
        if (args.length !== 1) throw new Error("Use /thinking <level|default>.");
        await changeModel(selection, thinking(args[0], selection));
        menu = undefined;
        return;
      }
      if (command === "/speed") {
        if (!args.length) {
          current();
          return;
        }
        if (
          args.length !== 1 ||
          !["standard", "fast", "ultrafast", "default"].includes(args[0] ?? "")
        )
          throw new Error("Use /speed standard|fast|ultrafast|default.");
        const next = selectedModel(
          resolveModelRef({
            model: modelLabel(selection),
            speed:
              args[0] === "default" ? undefined : (args[0] as "standard" | "fast" | "ultrafast"),
          }),
        );
        await changeModel(next, level);
        return;
      }
      throw new Error(`Unknown command ${command}. Type /help.`);
    }
    if (menu?.kind === "model") {
      const candidate = /^\d+$/.test(line) ? modelChoices[Number(line) - 1] : line;
      if (!candidate) throw new Error("Choose a listed model number or canonical model reference.");
      const next = parseSelection(candidate);
      const available = thinkingLevels.filter((value) => {
        try {
          thinking(value, next);
          return true;
        } catch {
          return false;
        }
      });
      menu = { kind: "thinking", selection: next };
      write(
        `Thinking for ${modelLabel(next)}: default, ${available.join(", ")}. Enter a level (or a number 1-${available.length}).\n`,
      );
      return;
    }
    if (menu?.kind === "thinking") {
      const available = thinkingLevels.filter((value) => {
        try {
          thinking(value, menu?.kind === "thinking" ? menu.selection : selection);
          return true;
        } catch {
          return false;
        }
      });
      const choice = /^\d+$/.test(line) ? available[Number(line) - 1] : line;
      if (!choice) throw new Error("Choose a listed thinking level or default.");
      await changeModel(menu.selection, thinking(choice, menu.selection));
      menu = undefined;
      return;
    }
    startTask(line);
  };

  write("Ready. Type /help for commands.\n");
  current();
  prompt();
  const onSignal = () => {
    commands = commands
      .then(async () => {
        if (active) await cancel();
        else {
          quitting = true;
          lines.close();
        }
      })
      .catch(report);
  };
  lines.on("SIGINT", onSignal);
  const processSignals = input === process.stdin;
  if (processSignals) process.on("SIGINT", onSignal);
  try {
    await new Promise<void>((resolve) => {
      lines.on("line", (line) => {
        commands = commands
          .then(() => handleLine(line))
          .catch(report)
          .then(prompt);
      });
      lines.once("close", () => {
        inputClosed = true;
        void (async () => {
          await commands;
          await active?.done;
          resolve();
        })();
      });
    });
  } finally {
    if (processSignals) process.off("SIGINT", onSignal);
    lines.off("SIGINT", onSignal);
    lines.close();
    await active?.done;
  }
}
