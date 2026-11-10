import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const extensionOrigin = `chrome-extension://${"b".repeat(32)}`;

async function runCli(args: string[], stdin = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI subprocess did not finish within 15 seconds."));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-browser-agent-cli-"));
  const bridge = await startBridge({ port: 0, requestTimeoutMs: 1_000 });
  const stateFile = path.join(directory, "bridge.json");
  await writeFile(
    stateFile,
    JSON.stringify({ version: 1, port: bridge.port, token: bridge.token }),
    { mode: 0o600 },
  );
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { bridge, stateFile, directory };
}

async function mockExtension(url: string, t: TestContext) {
  const extension = new WebSocket(url, { origin: extensionOrigin });
  await once(extension, "open");
  t.after(() => extension.terminate());
  const operations: Array<{ method: string; params: Record<string, unknown> }> = [];
  let fieldValue = "";
  let policy: { mode: "all" | "allowlist"; allow: string[]; block: string[] } = {
    mode: "all",
    allow: [],
    block: [],
  };
  const tabs = [{ id: 7, title: "Local browser test", url: "https://example.test/", active: true }];
  extension.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as {
      id?: string;
      method: string;
      params?: Record<string, unknown>;
    };
    if (request.method === "ping") {
      extension.send(JSON.stringify({ method: "pong" }));
      return;
    }
    const params = request.params ?? {};
    operations.push({ method: request.method, params });
    let result: unknown;
    let error: string | undefined;
    if (request.method === "tabs.list") {
      result = tabs;
    } else if (request.method === "policy.get") {
      result = policy;
    } else if (request.method === "policy.set") {
      policy = params.policy as typeof policy;
      result = policy;
    } else if (request.method === "page.read") {
      if (params.field === "title") result = tabs[0]!.title;
      else if (params.field === "readyState") result = "complete";
      else if (params.field === "viewport") result = { width: 800, height: 600 };
      else error = `Unexpected fixed page read ${String(params.field)}`;
    } else if (request.method === "page.fill") {
      if (params.backendNodeId !== 101) error = "Unknown input node.";
      else {
        fieldValue = String(params.text);
        result = { filled: true };
      }
    } else if (request.method === "cdp.send") {
      const method = params.method;
      const cdpParams = (params.params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "Page.getFrameTree":
          result = {
            frameTree: { frame: { id: "frame", loaderId: "document", url: tabs[0]!.url } },
          };
          break;
        case "Accessibility.getFullAXTree":
          result = {
            nodes: [
              {
                nodeId: "input",
                backendDOMNodeId: 101,
                role: { value: "textbox" },
                name: { value: "Search" },
              },
            ],
          };
          break;
        case "Runtime.evaluate":
          if (cdpParams.expression === "fieldValue")
            result = { result: { type: "string", value: fieldValue } };
          else error = "Mock page evaluation failed.";
          break;
        case "DOM.getBoxModel":
          result = { model: { content: [0, 0, 100, 0, 100, 20, 0, 20] } };
          break;
        case "DOM.scrollIntoViewIfNeeded":
        case "Input.dispatchMouseEvent":
          result = {};
          break;
        default:
          error = `Unexpected mock CDP method ${String(method)}`;
      }
    } else {
      error = `Unexpected mock method ${request.method}`;
    }
    extension.send(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }));
  });
  return { operations, tabs };
}

test("CLI status reports extension disconnect and connection", async (t) => {
  const { bridge, stateFile } = await fixture(t);
  const disconnected = await runCli(["status", "--state", stateFile]);
  assert.equal(disconnected.code, 0, disconnected.stderr);
  assert.deepEqual(JSON.parse(disconnected.stdout), { connected: false });
  await mockExtension(bridge.extensionUrl, t);
  const connected = await runCli(["status", "--state", stateFile]);
  assert.equal(connected.code, 0, connected.stderr);
  assert.deepEqual(JSON.parse(connected.stdout), { connected: true });
  assert.equal(connected.stderr, "");
  assert.equal(connected.stdout.includes(bridge.token), false);
});

test("CLI call dispatches a browser action through the authenticated relay", async (t) => {
  const { bridge, stateFile } = await fixture(t);
  const mock = await mockExtension(bridge.extensionUrl, t);
  const result = await runCli(["call", JSON.stringify({ action: "tabs" }), "--state", stateFile]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), mock.tabs);
  assert.deepEqual(mock.operations, [{ method: "tabs.list", params: {} }]);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(bridge.token), false);
});

test("CLI JSONL session keeps refs, processes in order, and recovers after input and tool errors", async (t) => {
  const { bridge, stateFile } = await fixture(t);
  const mock = await mockExtension(bridge.extensionUrl, t);
  const input = [
    JSON.stringify({ id: "snapshot", action: "snapshot", tabId: 7 }),
    JSON.stringify({ id: 2, action: "fill", tabId: 7, ref: "e1", text: "typed through the CLI" }),
    "{invalid JSON",
    JSON.stringify({ id: "bad-input", action: "fill", tabId: 7, ref: "e1" }),
    JSON.stringify({
      id: "tool-error",
      action: "evaluate",
      tabId: 7,
      expression: "unknownExpression",
    }),
    JSON.stringify({ id: "click", action: "click", tabId: 7, ref: "e1" }),
    JSON.stringify({ id: "read", action: "evaluate", tabId: 7, expression: "fieldValue" }),
    JSON.stringify({ id: "tabs", action: "tabs" }),
  ].join("\n");
  const result = await runCli(["session", "--state", stateFile], `${input}\n`);
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.id),
    ["snapshot", 2, null, "bad-input", "tool-error", "click", "read", "tabs"],
  );
  assert.match(lines[0].result.text, /\[e1\] textbox "Search"/);
  assert.deepEqual(lines[1].result, { tabId: 7, filled: true });
  assert.equal(typeof lines[2].error, "string");
  assert.match(lines[3].error, /text is required/);
  assert.match(lines[4].error, /Mock page evaluation failed/);
  assert.deepEqual(lines[5].result, { tabId: 7, clicked: true });
  assert.equal(lines[6].result, "typed through the CLI");
  assert.deepEqual(lines[7].result, mock.tabs);
  const forwarded = mock.operations.map(({ method, params }) =>
    method === "cdp.send" ? params.method : method,
  );
  assert.ok(forwarded.indexOf("page.fill") < forwarded.indexOf("DOM.getBoxModel"));
  assert.deepEqual(mock.operations.find(({ method }) => method === "page.fill")?.params, {
    tabId: 7,
    backendNodeId: 101,
    text: "typed through the CLI",
  });
  assert.equal(forwarded.includes("Runtime.callFunctionOn"), false);
  assert.deepEqual(
    mock.operations
      .filter(({ params }) => params.method === "Input.dispatchMouseEvent")
      .map(({ params }) => (params.params as Record<string, unknown>).type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(bridge.token), false);
});

test("CLI prompt works without a running bridge or valid model and exposes only owned inputs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-browser-agent-prompt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "c".repeat(64);
  const stateFile = path.join(directory, "unused-state.json");
  const instructionsFile = path.join(directory, "instructions.txt");
  const instructions = "Use only these harness-authored browser instructions.";
  await writeFile(stateFile, JSON.stringify({ version: 1, port: 1, token }));
  await writeFile(instructionsFile, `${instructions}\n`);
  const result = await runCli([
    "prompt",
    "--state",
    stateFile,
    "--model",
    "not-a-model",
    "--instructions",
    instructionsFile,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(description.instructions, instructions);
  assert.equal(description.tools.length, 1);
  assert.equal(description.tools[0].name, "browser");
  assert.equal(description.tools[0].inputSchema.type, "object");
  assert.match(description.tools[0].description, /independent local extension/);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr, "");
});

test("CLI defaults to chat and handles slash commands locally with persistent model and domain settings", async (t) => {
  const { bridge, stateFile, directory } = await fixture(t);
  const mock = await mockExtension(bridge.extensionUrl, t);
  const auditFile = path.join(directory, "chat-audit.jsonl");
  const commands = [
    "/domains only example.com",
    "/model openai:subscription:gpt-6-luna high",
    "/usage",
    "/quit",
  ];
  const result = await runCli(
    ["--state", stateFile, "--audit", auditFile],
    `${commands.join("\n")}\n`,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Ready\. Type \/help for commands/);
  assert.match(result.stdout, /Domains updated/);
  assert.match(result.stdout, /Model: openai:subscription:gpt-6-luna/);
  assert.match(result.stdout, /Thinking: high/);
  assert.match(result.stdout, /Tasks: 0/);
  assert.match(result.stderr, /Audit:/);
  assert.equal(result.stdout.includes(bridge.token), false);
  assert.equal(result.stderr.includes(bridge.token), false);
  const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
  assert.equal(settings.version, 1);
  assert.equal(settings.selection.provider, "openai");
  assert.equal(settings.selection.access, "subscription");
  assert.equal(settings.selection.model, "gpt-6-luna");
  assert.equal(settings.thinkingLevel, "high");
  assert.deepEqual(settings.policy, {
    mode: "allowlist",
    allow: ["https://example.com"],
    block: [],
  });
  assert.deepEqual(mock.operations, [
    { method: "policy.get", params: {} },
    { method: "policy.set", params: { policy: settings.policy } },
  ]);
  const auditText = await readFile(auditFile, "utf8");
  const audit = auditText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    audit.filter((entry) => entry.type === "local_command").map((entry) => entry.command),
    commands,
  );
  assert.ok(
    audit.every((entry) =>
      ["local_command", "local_policy", "local_settings"].includes(entry.type),
    ),
  );
  assert.equal(auditText.includes(bridge.token), false);

  const restored = await runCli(
    ["chat", "--state", stateFile, "--audit", path.join(directory, "restored-audit.jsonl")],
    "/usage\n/quit\n",
  );
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /Model: openai:subscription:gpt-6-luna/);
  assert.match(restored.stdout, /Thinking: high/);
  assert.match(restored.stdout, /Tasks: 0/);
  assert.deepEqual(mock.operations.at(-1), {
    method: "policy.set",
    params: { policy: settings.policy },
  });
});
