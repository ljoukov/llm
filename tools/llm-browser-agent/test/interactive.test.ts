import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { LlmToolLoopRequest, LlmToolLoopResult, runToolLoop } from "@ljoukov/llm";
import { BrowserSession } from "../src/browser.js";
import type { BridgeClient } from "../src/bridge-client.js";
import { runInteractive } from "../src/interactive.js";

type Policy = { mode: "all" | "allowlist"; allow: string[]; block: string[] };
type Runner = (request: LlmToolLoopRequest) => Promise<LlmToolLoopResult>;

function result(text: string, usage = true): LlmToolLoopResult {
  return {
    text,
    thoughts: "",
    steps: [
      {
        step: 1,
        modelVersion: "test-model",
        toolCalls: [],
        usage: usage
          ? { promptTokens: 100, responseTokens: 20, cachedTokens: 30, thinkingTokens: 5 }
          : undefined,
        costUsd: null,
        costSource: "subscription",
        apiEquivalentCostUsd: 0.001,
      },
    ],
    totalCostUsd: null,
  };
}

async function fixture(
  t: TestContext,
  handler?: Runner,
  options: {
    savedSettings?: unknown;
    explicitSelection?: boolean;
    explicitThinking?: boolean;
    disconnected?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-browser-agent-interactive-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const activity = new EventEmitter();
  const calls: LlmToolLoopRequest[] = [];
  const bridgeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const audits: unknown[] = [];
  let stdout = "";
  let stderr = "";
  let policy: Policy = { mode: "all", allow: [], block: [] };
  let connected = !options.disconnected;
  let settled = false;
  let failure: unknown;
  output.on("data", (chunk) => {
    stdout += String(chunk);
    activity.emit("change");
  });
  error.on("data", (chunk) => {
    stderr += String(chunk);
    activity.emit("change");
  });
  const client: BridgeClient = {
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      bridgeCalls.push({ method, params });
      if (!connected) throw new Error("Chrome extension disconnected.");
      if (method === "policy.get") return structuredClone(policy) as T;
      if (method === "policy.set") {
        policy = structuredClone(params.policy) as Policy;
        activity.emit("change");
        return structuredClone(policy) as T;
      }
      throw new Error(`Unexpected bridge operation: ${method}`);
    },
    async close() {},
  };
  const runner: Runner = async (request) => {
    calls.push(request);
    activity.emit("change");
    return handler ? handler(request) : result(`Answer ${calls.length}`);
  };
  const settingsPath = path.join(directory, "settings.json");
  if (options.savedSettings)
    await writeFile(settingsPath, JSON.stringify(options.savedSettings), { mode: 0o600 });
  const done = runInteractive({
    session: new BrowserSession(client),
    client,
    instructions: "Owned browser instructions.",
    selection: {
      provider: "openai",
      access: "subscription",
      model: "gpt-6.2-sol",
      speed: "standard",
    },
    thinkingLevel: "high",
    explicitSelection: options.explicitSelection,
    explicitThinking: options.explicitThinking,
    maxSteps: 8,
    settingsPath,
    audit(entry) {
      audits.push(entry);
      activity.emit("change");
    },
    input,
    output,
    error,
    runner: runner as typeof runToolLoop,
  }).then(
    () => {
      settled = true;
      activity.emit("change");
    },
    (cause) => {
      failure = cause;
      settled = true;
      activity.emit("change");
    },
  );
  const until = async (predicate: () => boolean, description: string) => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (failure) {
          cleanup();
          reject(failure);
        } else if (predicate()) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        activity.off("change", finish);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Timed out waiting for ${description}. stdout=${stdout}; stderr=${stderr}`),
        );
      }, 4_000);
      activity.on("change", finish);
      finish();
    });
  };
  t.after(async () => {
    if (!settled) input.write("/quit\n");
    input.end();
    await done;
    output.destroy();
    error.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => /Ready\./.test(stdout), "interactive readiness");
  return {
    input,
    output,
    error,
    calls,
    bridgeCalls,
    audits,
    settingsPath,
    done,
    until,
    stdout: () => stdout,
    stderr: () => stderr,
    settled: () => settled,
    policy: () => policy,
    connect: () => {
      connected = true;
    },
    send: (line: string) => input.write(`${line}\n`),
    quit: async () => {
      input.write("/quit\n");
      await until(() => settled, "quit");
      assert.equal(failure, undefined);
    },
  };
}

test("interactive slash commands stay local and invalid models do not reach the runner", async (t) => {
  const f = await fixture(t);
  f.send("/domains");
  f.send("/model definitely-not-a-model high");
  f.send("/usage");
  await f.until(
    () => /Usage:/i.test(f.stdout()) && /model|unsupported/i.test(f.stderr()),
    "local command output",
  );
  assert.equal(f.calls.length, 0);
  assert(f.bridgeCalls.some((call) => call.method === "policy.get"));
  await f.quit();
});

test("disconnected startup keeps local commands available without persisting an observed allow-all policy", async (t) => {
  const f = await fixture(t, undefined, { disconnected: true });
  f.send("/model openai:subscription:gpt-6-luna medium");
  await f.until(
    () => /Model: openai:subscription:gpt-6-luna/.test(f.stdout()),
    "local model selection while disconnected",
  );
  const saved = JSON.parse(await readFile(f.settingsPath, "utf8"));
  assert.equal(saved.policy, undefined);
  assert.match(f.stderr(), /Chrome policy unavailable/);
  f.send("/usage");
  await f.until(() => /Usage:/.test(f.stdout()), "local usage while disconnected");
  await f.quit();
});

test("pending saved restrictions block tasks and are reapplied after Chrome reconnects", async (t) => {
  const restricted = { mode: "allowlist", allow: ["https://example.com"], block: [] };
  const f = await fixture(t, undefined, {
    disconnected: true,
    savedSettings: {
      version: 1,
      selection: { provider: "openai", access: "subscription", model: "gpt-6.2-sol" },
      policy: restricted,
    },
  });
  f.send("Do not run before permissions synchronize");
  await f.until(() => /have not reached Chrome/.test(f.stderr()), "unsynchronized policy refusal");
  assert.equal(f.calls.length, 0);
  f.connect();
  f.send("/domains");
  await f.until(
    () => /Domains: only allowlisted origins/.test(f.stdout()),
    "policy reapplied after reconnect",
  );
  assert.deepEqual(f.policy(), restricted);
  f.send("Allowed task after synchronization");
  await f.until(() => /Answer 1/.test(f.stdout()), "task after policy synchronization");
  await f.quit();
});

test("operator model and thinking selection apply to the next task", async (t) => {
  const f = await fixture(t);
  f.send("/model openai:subscription:gpt-6-luna medium");
  await f.until(() => /Model: openai:subscription:gpt-6-luna/.test(f.stdout()), "model selection");
  f.send("Read the open page");
  await f.until(() => /Answer 1/.test(f.stdout()), "first task completion");
  assert.equal(f.calls[0]?.model, "gpt-6-luna");
  assert.equal(f.calls[0]?.provider, "openai");
  assert.equal(f.calls[0]?.access, "subscription");
  assert.equal(f.calls[0]?.thinkingLevel, "medium");
  assert.equal(f.calls[0]?.thinkingLevelPolicy, "strict");
  await f.quit();
});

test("model menu selects a listed model and thinking without sending menu choices to the model", async (t) => {
  const f = await fixture(t);
  f.send("/model");
  await f.until(() => /Choose a model number/.test(f.stdout()), "model menu");
  const solChoice = f.stdout().match(/^(\d+)\. openai:subscription:gpt-6\.2-sol$/m)?.[1];
  assert.ok(solChoice);
  f.send(solChoice);
  await f.until(
    () => /Thinking for openai:subscription:gpt-6\.2-sol/.test(f.stdout()),
    "thinking menu",
  );
  f.send("medium");
  await f.until(() => /Thinking: medium/.test(f.stdout()), "menu selection");
  assert.equal(f.calls.length, 0);
  f.send("Inspect a browser tab");
  await f.until(() => /Answer 1/.test(f.stdout()), "task after menu");
  assert.equal(f.calls[0]?.thinkingLevel, "medium");
  assert.deepEqual(f.calls[0]?.input, [{ role: "user", content: "Inspect a browser tab" }]);
  await f.quit();
});

test("saved model settings are restored unless explicit CLI selection and thinking override them", async (t) => {
  const savedSettings = {
    version: 1,
    selection: {
      provider: "openai",
      access: "subscription",
      model: "gpt-6-luna",
      speed: "standard",
    },
    thinkingLevel: "low",
    policy: { mode: "allowlist", allow: ["https://example.com"], block: [] },
  };
  const restored = await fixture(t, undefined, { savedSettings });
  restored.send("Task using saved settings");
  await restored.until(() => /Answer 1/.test(restored.stdout()), "restored task");
  assert.equal(restored.calls[0]?.model, "gpt-6-luna");
  assert.equal(restored.calls[0]?.thinkingLevel, "low");
  assert.deepEqual(restored.policy(), savedSettings.policy);
  await restored.quit();

  const explicit = await fixture(t, undefined, {
    savedSettings,
    explicitSelection: true,
    explicitThinking: true,
  });
  explicit.send("Task with explicit CLI settings");
  await explicit.until(() => /Answer 1/.test(explicit.stdout()), "explicit task");
  assert.equal(explicit.calls[0]?.model, "gpt-6.2-sol");
  assert.equal(explicit.calls[0]?.thinkingLevel, "high");
  assert.deepEqual(explicit.policy(), savedSettings.policy);
  await explicit.quit();
});

test("retired saved OpenAI models migrate without changing the route or domain restrictions", async (t) => {
  const savedSettings = {
    version: 1,
    selection: {
      provider: "openai",
      access: "subscription",
      model: "gpt-6.1-sol",
      speed: "fast",
    },
    thinkingLevel: "low",
    policy: {
      mode: "allowlist",
      allow: ["https://example.com"],
      block: ["https://blocked.example"],
    },
  };
  const f = await fixture(t, undefined, { savedSettings });
  f.send("Task using migrated settings");
  await f.until(() => /Answer 1/.test(f.stdout()), "migrated task");
  const selection = { ...savedSettings.selection, model: "gpt-6.2-sol" };
  const request = f.calls[0];
  assert.equal(request?.provider, selection.provider);
  assert.equal(request?.access, selection.access);
  assert.equal(request?.model, selection.model);
  assert.equal(request?.speed, selection.speed);
  assert.equal(request?.thinkingLevel, savedSettings.thinkingLevel);
  assert.deepEqual(f.policy(), savedSettings.policy);
  assert.deepEqual(JSON.parse(await readFile(f.settingsPath, "utf8")), {
    ...savedSettings,
    selection,
  });
  assert.match(f.stderr(), /Updated the saved OpenAI model to openai:subscription:gpt-6\.2-sol\./);
  await f.quit();
});

test("interactive history retains prior text and usage totals come from completed steps", async (t) => {
  const f = await fixture(t);
  f.send("First browser task");
  await f.until(() => /Answer 1/.test(f.stdout()), "first answer");
  f.send("Follow-up browser task");
  await f.until(() => /Answer 2/.test(f.stdout()), "follow-up answer");
  assert.deepEqual(f.calls[1]?.input, [
    { role: "user", content: "First browser task" },
    { role: "assistant", content: "Answer 1" },
    { role: "user", content: "Follow-up browser task" },
  ]);
  f.send("/usage");
  await f.until(() => /Usage:/i.test(f.stdout()), "usage report");
  assert.match(f.stdout(), /input\s+tokens[^\n]*200/i);
  assert.match(f.stdout(), /output\s+tokens[^\n]*40/i);
  assert.match(f.stdout(), /cached\s+tokens[^\n]*60/i);
  assert.match(f.stdout(), /reasoning\s+tokens[^\n]*10/i);
  assert.match(f.stdout(), /API-equivalent[^\n]*0\.002/i);
  assert.match(
    f.stdout(),
    /actual\s+cost[^\n]*(subscription|unknown|unavailable|not billed|n\/a)/i,
  );
  await f.quit();
});

test("long interactive conversations bound retained text history", async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 14; index += 1) {
    f.send(`Browser task ${index}`);
    await f.until(() => f.stdout().includes(`Answer ${index}\n`), `answer ${index}`);
  }
  const last = f.calls.at(-1)?.input;
  assert(Array.isArray(last));
  assert(last.length <= 21, "At most 20 historical messages plus the next user task are retained");
  assert(!last.some((message) => message.content === "Browser task 1"));
  await f.quit();
});

test("domain commands persist exact origins and clear prior model conversation", async (t) => {
  const f = await fixture(t);
  f.send("Read a page before changing access");
  await f.until(() => /Answer 1/.test(f.stdout()), "pre-policy answer");
  f.send("/domains only example.com,http://localhost:3210");
  await f.until(() => /Domains updated\./.test(f.stdout()), "domain update");
  assert.equal(f.policy().mode, "allowlist");
  assert.deepEqual(
    new Set(f.policy().allow),
    new Set(["https://example.com", "http://localhost:3210"]),
  );
  assert.deepEqual(f.policy().block, []);
  const saved = JSON.parse(await readFile(f.settingsPath, "utf8"));
  assert.deepEqual(saved.policy, f.policy());
  assert.equal((await stat(f.settingsPath)).mode & 0o777, 0o600);
  f.send("Read a page after changing access");
  await f.until(() => /Answer 2/.test(f.stdout()), "post-policy answer");
  assert.deepEqual(f.calls[1]?.input, [
    { role: "user", content: "Read a page after changing access" },
  ]);
  await f.quit();
});

test("wildcard allow commands normalize patterns and preserve existing allowed sites", async (t) => {
  const f = await fixture(t);
  f.send("/domains only existing.example.test");
  await f.until(() => /Domains updated\./.test(f.stdout()), "initial exact permission");
  f.send("/domains allow *.ExAmPlE.COM");
  await f.until(
    () => (f.stdout().match(/Domains updated\./g)?.length ?? 0) === 2,
    "wildcard permission",
  );
  assert.deepEqual(f.policy(), {
    mode: "allowlist",
    allow: ["https://existing.example.test", "https://*.example.com"],
    block: [],
  });
  const saved = JSON.parse(await readFile(f.settingsPath, "utf8"));
  assert.deepEqual(saved.policy, f.policy());
  f.send("/domains block http://*.Example.COM:8080");
  await f.until(
    () => (f.stdout().match(/Domains updated\./g)?.length ?? 0) === 3,
    "wildcard HTTP block",
  );
  assert.deepEqual(f.policy().block, ["http://*.example.com:8080"]);
  await f.quit();
});

test("saved wildcard settings restore canonical patterns without changing exact origins", async (t) => {
  const savedPolicy = {
    mode: "allowlist",
    allow: ["https://*.example.com", "https://existing.example.test"],
    block: ["http://*.example.com:8080"],
  };
  const f = await fixture(t, undefined, {
    savedSettings: {
      version: 1,
      selection: { provider: "openai", access: "subscription", model: "gpt-6.2-sol" },
      policy: savedPolicy,
    },
  });
  assert.deepEqual(f.policy(), savedPolicy);
  assert.deepEqual(f.bridgeCalls[0], { method: "policy.set", params: { policy: savedPolicy } });
  f.send("/help");
  await f.until(() => /includes example\.com and its subdomains/.test(f.stdout()), "wildcard help");
  await f.quit();
});

test("invalid wildcard forms are refused before any extension policy mutation", async (t) => {
  const f = await fixture(t);
  const invalid = [
    "*.com",
    "*.127.0.0.1",
    "*.[::1]",
    "*.*.example.com",
    "foo.*.example.com",
    "https://*.example.com/path",
    "https://user@*.example.com",
    "https://*.example.com?query=1",
    "https://*.example.com/#fragment",
    "https://*.example..com",
    "https://*.-example.com",
    "https://%2A.example.com",
  ];
  for (const entry of invalid) f.send(`/domains allow ${entry}`);
  f.send("/usage");
  await f.until(() => /Usage:/.test(f.stdout()), "all invalid commands processed");
  assert.equal(f.bridgeCalls.filter((entry) => entry.method === "policy.set").length, 0);
  assert.deepEqual(f.policy(), { mode: "all", allow: [], block: [] });
  assert.equal(f.stderr().trim().split("\n").length, invalid.length);
  await assert.rejects(readFile(f.settingsPath, "utf8"), /ENOENT/);
  await f.quit();
});

test("quit aborts an active task instead of waiting for an unbounded runner", async (t) => {
  let aborted = false;
  const f = await fixture(
    t,
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("Task cancelled"));
          },
          { once: true },
        );
      }),
  );
  f.send("A long-running browser task");
  await f.until(() => f.calls.length === 1, "runner start");
  await f.quit();
  assert.equal(aborted, true);
});

test("usage stays responsive during a task and extra task text is rejected while busy", async (t) => {
  let finish: ((value: LlmToolLoopResult) => void) | undefined;
  const f = await fixture(
    t,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.send("Long task");
  await f.until(() => f.calls.length === 1, "long task start");
  f.send("Do a second task concurrently");
  f.send("/usage");
  await f.until(
    () => /A task is running/.test(f.stdout() + f.stderr()) && /Usage:/.test(f.stdout()),
    "responsive local commands",
  );
  assert.equal(f.calls.length, 1);
  assert(finish);
  finish(result("Long task finished"));
  await f.until(() => /Long task finished/.test(f.stdout()), "long task completion");
  await f.quit();
});

test("a failed model task does not end the interactive session", async (t) => {
  let count = 0;
  const f = await fixture(t, async () => {
    count += 1;
    if (count === 1) throw new Error("Test provider failure");
    return result("Recovered answer");
  });
  f.send("Fail this task");
  await f.until(() => /Test provider failure/.test(f.stderr()), "failure report");
  assert.equal(f.settled(), false);
  f.send("Try another task");
  await f.until(() => /Recovered answer/.test(f.stdout()), "recovered task");
  await f.quit();
});

test("domain mutation cancels an active task before changing permissions", async (t) => {
  const order: string[] = [];
  const f = await fixture(
    t,
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            order.push("cancel");
            reject(new Error("Cancelled for policy change"));
          },
          { once: true },
        );
      }),
  );
  f.send("Read the currently allowed site");
  await f.until(() => f.calls.length === 1, "active task");
  f.send("/domains clear");
  await f.until(() => /Domains updated\./.test(f.stdout()), "policy revocation");
  assert.deepEqual(order, ["cancel"]);
  assert.deepEqual(f.policy(), { mode: "allowlist", allow: [], block: [] });
  await f.quit();
});
