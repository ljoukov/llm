// Real browser and optional subscription smoke. Uses an isolated Chrome profile.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { loadLocalEnv, type LlmToolLoopResult } from "@ljoukov/llm";
import { PassThrough } from "node:stream";
import { startBridge } from "../src/bridge.js";
import { connectBridge } from "../src/bridge-client.js";
import { BrowserSession } from "../src/browser.js";
import { runInteractive } from "../src/interactive.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.env.CHROME_EXECUTABLE;
assert(
  executablePath,
  "Set CHROME_EXECUTABLE to a Chrome binary supporting Extensions.loadUnpacked.",
);
const profile = await mkdtemp(path.join(os.tmpdir(), "llm-browser-agent-chrome-"));
const bridge = await startBridge({ port: 0, requestTimeoutMs: 45000 });
const fixture = createServer((request, response) => {
  if (request.url === "/redirect-blocked") {
    response.writeHead(302, {
      location: `http://${request.headers.host?.replace("127.0.0.1", "localhost")}/secret`,
    });
    response.end();
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/secret") {
    response.end("<title>Forbidden</title><h1>BLOCKED_SECRET</h1>");
    return;
  }
  if (request.url === "/frame") {
    response.end(
      `<title>Frame policy test</title><h1>Allowed parent</h1><iframe src="http://${request.headers.host?.replace("127.0.0.1", "localhost")}/secret"></iframe>`,
    );
    return;
  }
  if (request.url?.startsWith("/done")) {
    const name = new URL(request.url, "http://localhost").searchParams.get("name");
    response.end(
      `<title>Result</title><h1>Success</h1><p id="result">${name === "BROWSER_HARNESS_OK" ? "BROWSER_HARNESS_OK" : "unexpected"}</p>`,
    );
  } else {
    response.end(`<!doctype html><title>Harness fixture</title><h1>Chrome harness test</h1>
      <form action="/done"><label>Your name <input name="name"></label><button>Continue</button></form>
      <p>Verification code: ORBIT-742</p><button id="increment" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>`);
  }
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/`;
const events: unknown[] = [];
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
let client: Awaited<ReturnType<typeof connectBridge>> | undefined;
try {
  // Chrome's Extensions CDP domain explicitly requires this opt-in flag.
  // No normal profile, browser extension, or website permissions are modified.
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--no-first-run"],
  });
  const browser = context.browser();
  assert(browser, "Persistent Chrome context must expose its browser");
  const cdp = await browser.newBrowserCDPSession();
  const loaded = (await cdp.send("Extensions.loadUnpacked", {
    path: path.join(root, "extension"),
  })) as { id: string };
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${loaded.id}/popup.html`);
  await popup.locator("#bridge-url").fill(bridge.extensionUrl);
  await popup.getByRole("button", { name: "Connect", exact: true }).click();
  await popup.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Connected to the local bridge.",
  );
  client = await connectBridge(bridge.clientUrl, { requestTimeoutMs: 50000 });
  const session = new BrowserSession(client);
  const opened = (await session.execute({ action: "open", url })) as {
    tabId?: number;
    id?: number;
  };
  const tabId = opened.tabId ?? opened.id;
  assert(typeof tabId === "number");
  const snapshot = (await session.execute({ action: "snapshot", tabId })) as {
    text: string;
  };
  assert.match(snapshot.text, /Chrome harness test/);
  const inputRef = snapshot.text.match(/\[(e\d+)\] textbox/)?.[1];
  const buttonRef = snapshot.text.match(/\[(e\d+)\] button "Continue"/)?.[1];
  assert(inputRef && buttonRef, snapshot.text);
  await session.execute({
    action: "fill",
    tabId,
    ref: inputRef,
    text: "BROWSER_HARNESS_OK",
  });
  assert.equal(
    await session.execute({
      action: "evaluate",
      tabId,
      expression: "document.querySelector('input').value",
    }),
    "BROWSER_HARNESS_OK",
  );
  await session.execute({ action: "click", tabId, ref: buttonRef });
  await session.execute({
    action: "wait",
    tabId,
    expression: "document.querySelector('#result')?.textContent === 'BROWSER_HARNESS_OK'",
  });
  await assert.rejects(
    session.execute({ action: "click", tabId, ref: buttonRef }),
    /stale|expired|snapshot/,
  );
  const image = (await session.execute({ action: "screenshot", tabId })) as {
    type: string;
    image_url: string;
  }[];
  assert(
    image.some(
      (part) => part.type === "input_image" && part.image_url.startsWith("data:image/jpeg;base64,"),
    ),
  );
  const imagePart = image.find((part) => part.type === "input_image")!;
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(
    path.join(root, "artifacts", "chrome-smoke.jpg"),
    Buffer.from(imagePart.image_url.split(",")[1]!, "base64"),
  );
  const back = (await session.execute({ action: "back", tabId })) as { text: string };
  assert.match(back.text, /ORBIT-742/);
  const forward = (await session.execute({ action: "forward", tabId })) as { text: string };
  assert.match(forward.text, /BROWSER_HARNESS_OK/);
  const reload = (await session.execute({ action: "reload", tabId })) as { text: string };
  assert.match(reload.text, /BROWSER_HARNESS_OK/);
  // Cross-host navigation has no harness policy/confirmation step.
  await session.execute({
    action: "navigate",
    tabId,
    url: url.replace("127.0.0.1", "localhost"),
  });
  const crossHost = (await session.execute({ action: "snapshot", tabId })) as {
    url: string;
    text: string;
  };
  assert.match(crossHost.url, /localhost/);
  assert.match(crossHost.text, /ORBIT-742/);
  const freshInputRef = crossHost.text.match(/\[(e\d+)\] textbox/)?.[1];
  assert(freshInputRef);
  await session.execute({ action: "fill", tabId, ref: freshInputRef, text: "replace me" });
  await session.execute({
    action: "press",
    tabId,
    key: process.platform === "darwin" ? "Meta+A" : "Control+A",
  });
  await session.execute({ action: "press", tabId, key: "Z" });
  assert.equal(
    await session.execute({
      action: "evaluate",
      tabId,
      expression: "document.querySelector('input').value",
    }),
    "Z",
    "Select-all keyboard shortcut should replace the focused input",
  );

  const allowOrigin = new URL(url).origin;
  await client.request("policy.set", {
    policy: { mode: "allowlist", allow: [allowOrigin], block: [] },
  });
  await assert.rejects(session.execute({ action: "snapshot", tabId }), /Domain policy:/);
  const restricted = (await session.execute({ action: "open", url })) as {
    tabId: number;
    text: string;
  };
  await assert.rejects(
    session.execute({ action: "evaluate", tabId: restricted.tabId, expression: "document.title" }),
    /Domain policy:/,
  );
  await assert.rejects(
    session.execute({
      action: "wait",
      tabId: restricted.tabId,
      expression: "true",
      timeoutMs: 1000,
    }),
    /Domain policy:/,
  );
  await session.execute({ action: "wait", tabId: restricted.tabId });
  await assert.rejects(
    session.execute({
      action: "navigate",
      tabId: restricted.tabId,
      url: url.replace("127.0.0.1", "localhost"),
    }),
    /Domain policy:/,
  );
  const afterDenied = (await session.execute({ action: "snapshot", tabId: restricted.tabId })) as {
    text: string;
  };
  const restrictedInput = afterDenied.text.match(/\[(e\d+)\] textbox/)?.[1];
  assert(restrictedInput);
  await session.execute({
    action: "fill",
    tabId: restricted.tabId,
    ref: restrictedInput,
    text: "restricted form works",
  });
  const filled = (await session.execute({ action: "snapshot", tabId: restricted.tabId })) as {
    text: string;
  };
  assert.match(filled.text, /restricted form works/);
  try {
    const withFrame = (await session.execute({
      action: "navigate",
      tabId: restricted.tabId,
      url: `${url}frame`,
    })) as { text: string };
    assert.match(withFrame.text, /Allowed parent/);
    assert.doesNotMatch(withFrame.text, /BLOCKED_SECRET/);
  } catch (error) {
    // Chrome can hide an error subframe's URL. Refusing the entire read is a
    // conservative, supported result; never infer that an opaque frame is safe.
    assert.match(error instanceof Error ? error.message : String(error), /Domain policy:/);
  }
  await assert.rejects(
    session.execute({ action: "navigate", tabId: restricted.tabId, url: `${url}redirect-blocked` }),
    /Domain policy:|not become ready|net::ERR/,
  );
  await client.request("policy.set", { policy: { mode: "all", allow: [], block: [] } });
  await session.execute({ action: "close", tabId: restricted.tabId });
  session.reset();

  if (process.env.LLM_BROWSER_LIVE === "1") {
    loadLocalEnv();
    const instructions =
      "Use the browser tool to inspect and operate Chrome. Complete the user's task and report the observed result.";
    const input = `Use only tab ${tabId}. Take a screenshot, read its verification code, fill Your name with BROWSER_HARNESS_OK, click Continue, and verify the resulting page. Report the original verification code and the final result.`;
    await session.execute({ action: "navigate", tabId, url });
    const terminalInput = new PassThrough();
    const terminalOutput = new PassThrough();
    let printed = "";
    terminalOutput.on("data", (chunk) => {
      printed += chunk.toString();
    });
    let resolveResult!: (result: LlmToolLoopResult) => void;
    let rejectResult!: (error: Error) => void;
    const taskResult = new Promise<LlmToolLoopResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const interactive = runInteractive({
      session,
      client,
      instructions,
      maxSteps: 14,
      selection: {
        provider: "openai",
        access: "subscription",
        model: "gpt-6.1-sol",
        speed: "standard",
      },
      settingsPath: path.join(profile, "agent-settings.json"),
      input: terminalInput,
      output: terminalOutput,
      error: terminalOutput,
      audit(entry) {
        const record = entry as {
          type: string;
          event?: unknown;
          result?: LlmToolLoopResult;
          message?: string;
        };
        events.push(record.type === "model_event" ? record.event : entry);
        if (record.type === "result" && record.result) resolveResult(record.result);
        if (record.type === "failure") rejectResult(new Error(record.message));
      },
    });
    terminalInput.write(
      `/domains only ${allowOrigin}\n/model openai:subscription:gpt-6.1-sol medium\n${input} Use snapshot to verify text; do not use evaluate or expression-based wait.\n`,
    );
    const timer = setTimeout(
      () => rejectResult(new Error("Live interactive task timed out")),
      240000,
    );
    let result: LlmToolLoopResult;
    try {
      result = await taskResult;
    } finally {
      clearTimeout(timer);
      terminalInput.end("/usage\n/quit\n");
      await interactive;
    }
    assert.match(printed, /Domains updated/);
    assert.match(printed, /completed: 1/);
    assert.match(printed, /API-equivalent:/);
    assert.match(result.text, /ORBIT-742/);
    assert(
      events.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          "type" in entry &&
          entry.type === "tool_call" &&
          "phase" in entry &&
          entry.phase === "completed" &&
          "input" in entry &&
          entry.input &&
          typeof entry.input === "object" &&
          "action" in entry.input &&
          entry.input.action === "screenshot",
      ),
      "Model must receive a real screenshot tool result",
    );
    assert.deepEqual(
      events.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          "type" in entry &&
          entry.type === "tool_call" &&
          "error" in entry &&
          entry.error,
      ),
      [],
      "Model tool calls should execute without argument/schema errors",
    );
    const finalSnapshot = (await session.execute({ action: "snapshot", tabId })) as {
      text: string;
    };
    assert.match(finalSnapshot.text, /BROWSER_HARNESS_OK/);
    console.log(`Subscription smoke passed (${result.steps.length} model turns).`);
  }
  console.log(
    "Chrome extension smoke passed: pair, tabs, snapshot, fill, click, navigation, stale refs, screenshot, cross-host navigation.",
  );
} finally {
  if (events.length)
    await writeFile(
      path.join(root, "artifacts", "subscription-smoke.json"),
      JSON.stringify(events, null, 2),
      { mode: 0o600 },
    );
  await client?.close();
  await context?.close();
  await bridge.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(profile, { recursive: true, force: true });
}
