import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserSession,
  validateBrowserUrl,
  type BrowserSnapshot,
  type BrowserTransport,
} from "../src/browser.js";

test("wait deadline also bounds a predicate that never resolves", async () => {
  const mock = new ChromeMock();
  mock.override = (method) => (method === "Runtime.evaluate" ? new Promise(() => {}) : undefined);
  const session = new BrowserSession(mock);
  const started = Date.now();
  await assert.rejects(
    session.execute({
      action: "wait",
      tabId: 1,
      expression: "new Promise(() => {})",
      timeoutMs: 10,
    }),
    /within 10ms/,
  );
  assert(Date.now() - started < 500, "Local wait must not wait for the bridge's longer timeout");
});

class ChromeMock implements BrowserTransport {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  loaderId = "loader-1";
  url = "https://example.test/";
  nodes: unknown[] = [
    {
      nodeId: "1",
      backendDOMNodeId: 1,
      role: { value: "RootWebArea" },
      name: { value: "Test page" },
      childIds: ["2", "3"],
    },
    { nodeId: "2", backendDOMNodeId: 2, role: { value: "button" }, name: { value: "Save" } },
    {
      nodeId: "3",
      backendDOMNodeId: 3,
      role: { value: "textbox" },
      name: { value: "Name" },
      value: { value: "Before" },
    },
  ];
  override?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "tabs.list") return [{ id: 1, url: this.url, title: "Test page", active: true }];
    if (method === "tabs.create") {
      this.url = String(params.url);
      return { id: 1 };
    }
    if (method === "tabs.close" || method === "tabs.activate") return { ok: true };
    if (method === "page.read" || method === "page.fill") {
      const overridden = await this.override?.(method, params);
      if (overridden !== undefined) return overridden;
      if (method === "page.fill") return { filled: true };
      if (params.field === "title") return "Test page";
      if (params.field === "readyState") return "complete";
      if (params.field === "viewport") return { width: 1000, height: 800, scrollX: 0, scrollY: 0 };
      if (params.field === "navigation")
        return { id: "main", loaderId: this.loaderId, url: this.url };
      throw new Error(`Unknown page field ${params.field}`);
    }
    assert.equal(method, "cdp.send");
    const command = String(params.method);
    const args = params.params as Record<string, unknown>;
    const overridden = await this.override?.(command, args);
    if (overridden !== undefined) return overridden;
    switch (command) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", loaderId: this.loaderId, url: this.url } } };
      case "Accessibility.getFullAXTree":
        return { nodes: this.nodes };
      case "Runtime.evaluate": {
        const expression = String(args.expression);
        if (expression === "document.title")
          return { result: { type: "string", value: "Test page" } };
        if (expression === "document.readyState")
          return { result: { type: "string", value: "complete" } };
        if (expression.includes("innerWidth"))
          return { result: { type: "object", value: { width: 1000, height: 800 } } };
        return { result: { type: "boolean", value: true } };
      }
      case "DOM.getBoxModel":
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
      case "DOM.resolveNode":
        return { object: { type: "object", objectId: "editable-3" } };
      case "Runtime.callFunctionOn":
        return { result: { type: "object", value: { filled: true } } };
      case "Page.captureScreenshot":
        return { data: "aW1hZ2U=" };
      case "Page.navigate":
        this.url = String(args.url);
        this.loaderId = "loader-2";
        return { loaderId: this.loaderId };
      case "Page.reload":
        this.loaderId = "loader-reload";
        return {};
      default:
        return {};
    }
  }
}

function commands(mock: ChromeMock, name: string) {
  return mock.calls
    .filter((call) => call.params.method === name)
    .map((call) => call.params.params as Record<string, unknown>);
}

test("navigation accepts any HTTP(S) hostname without a domain list", () => {
  assert.equal(
    validateBrowserUrl("https://any.internal.example/a?q=b"),
    "https://any.internal.example/a?q=b",
  );
  assert.equal(validateBrowserUrl("http://127.0.0.1:8080/test"), "http://127.0.0.1:8080/test");
  assert.equal(validateBrowserUrl("about:blank"), "about:blank");
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "chrome://settings",
    "relative/path",
  ]) {
    assert.throws(() => validateBrowserUrl(url), /HTTP/);
  }
});

test("snapshot exposes accessible names, roles, values and stable backend references", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  const first = (await browser.execute({ action: "snapshot", tabId: 1 })) as BrowserSnapshot;
  assert.equal(first.url, "https://example.test/");
  assert.equal(first.title, "Test page");
  assert.equal(first.documentId, "main:loader-1");
  assert.equal(first.truncated, false);
  assert.match(first.text, /\[e2\] button "Save"/);
  assert.match(first.text, /\[e3\] textbox "Name" value="Before"/);
  const second = (await browser.execute({ action: "snapshot", tabId: 1 })) as BrowserSnapshot;
  assert.equal(second.text, first.text);
});

test("snapshot bounds oversized output and does not expose clipped references", async () => {
  const mock = new ChromeMock();
  mock.nodes = [
    {
      nodeId: "1",
      backendDOMNodeId: 1,
      role: { value: "button" },
      name: { value: "x".repeat(5000) },
    },
  ];
  const browser = new BrowserSession(mock);
  const snapshot = (await browser.execute({
    action: "snapshot",
    tabId: 1,
    maxChars: 256,
  })) as BrowserSnapshot;
  assert.ok(snapshot.text.length <= 256);
  assert.equal(snapshot.truncated, true);
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e1" }),
    /Unknown or expired/,
  );
});

test("snapshot exposes an observed HTTP link target for direct product navigation", async () => {
  const mock = new ChromeMock();
  const target = "https://www.example.com/products/widget?variant=pcb&source=search";
  mock.nodes = [
    {
      nodeId: "1",
      backendDOMNodeId: 1,
      role: { value: "link" },
      name: { value: "Second DIY PCB kit" },
      properties: [{ name: "url", value: { type: "string", value: target } }],
    },
  ];
  const browser = new BrowserSession(mock);
  const snapshot = (await browser.execute({ action: "snapshot", tabId: 1 })) as BrowserSnapshot;
  assert.match(snapshot.text, /link "Second DIY PCB kit"/);
  assert.ok(snapshot.text.includes(`url=${JSON.stringify(target)}`));
  assert.equal(
    mock.calls.some((call) => call.method === "page.read" && call.params.field !== "title"),
    false,
  );
});

test("snapshot omits unsafe, invalid and oversized link metadata rather than truncating a target", async () => {
  const mock = new ChromeMock();
  const metadata = [
    "javascript:alert('not a navigation target')",
    "data:text/html,unsafe",
    "/relative/product",
    `https://example.test/${"x".repeat(4096)}`,
    "about:blank",
  ];
  mock.nodes = metadata.map((url, index) => ({
    nodeId: String(index),
    backendDOMNodeId: index + 1,
    role: { value: "link" },
    name: { value: `Product ${index}` },
    properties: [{ name: "url", value: { value: url } }],
  }));
  const browser = new BrowserSession(mock);
  const snapshot = (await browser.execute({ action: "snapshot", tabId: 1 })) as BrowserSnapshot;
  assert.ok(!snapshot.text.includes("url="));
  assert.ok(!snapshot.text.includes("javascript:"));
  assert.ok(!snapshot.text.includes("…"));
  assert.equal(snapshot.truncated, false);
});

test("snapshot omits a whole link URL when the remaining text budget cannot fit it", async () => {
  const mock = new ChromeMock();
  mock.nodes = [
    {
      nodeId: "1",
      backendDOMNodeId: 1,
      role: { value: "link" },
      name: { value: "Observed product" },
      properties: [
        { name: "url", value: { value: `https://example.test/item?q=${"x".repeat(300)}` } },
      ],
    },
  ];
  const browser = new BrowserSession(mock);
  const snapshot = (await browser.execute({
    action: "snapshot",
    tabId: 1,
    maxChars: 256,
  })) as BrowserSnapshot;
  assert.match(snapshot.text, /link "Observed product"/);
  assert.ok(!snapshot.text.includes("url="));
  assert.equal(snapshot.truncated, true);
});

test("stale reference is rejected before a DOM action after document navigation", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  mock.loaderId = "other-document";
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2" }),
    /stale after navigation/,
  );
  assert.equal(commands(mock, "DOM.getBoxModel").length, 0);
});

test("click scrolls a referenced node and dispatches coordinates through CDP", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  await browser.execute({ action: "click", tabId: 1, ref: "e2" });
  assert.deepEqual(commands(mock, "DOM.scrollIntoViewIfNeeded"), [{ backendNodeId: 2 }]);
  const mouse = commands(mock, "Input.dispatchMouseEvent");
  assert.deepEqual(
    mouse.map((event) => event.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.equal(mouse[1]!.x, 60);
  assert.equal(mouse[1]!.y, 40);
});

test("coordinate click rejects missing or conflicting coordinates", async () => {
  const browser = new BrowserSession(new ChromeMock());
  await assert.rejects(browser.execute({ action: "click", tabId: 1, x: 5 }), /y must be a finite/);
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2", x: 5, y: 5 }),
    /either ref or/,
  );
});

test("fill delegates its referenced backend node and text to the fixed extension helper", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  await browser.execute({ action: "fill", tabId: 1, ref: "e3", text: "After" });
  assert.deepEqual(
    mock.calls.filter((call) => call.method === "page.fill"),
    [{ method: "page.fill", params: { tabId: 1, backendNodeId: 3, text: "After" } }],
  );
  assert.equal(commands(mock, "Runtime.callFunctionOn").length, 0);
});

test("fill surfaces validation errors from the extension helper", async () => {
  const mock = new ChromeMock();
  mock.override = (method) => {
    if (method === "page.fill") throw new Error("not editable");
    return undefined;
  };
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  await assert.rejects(
    browser.execute({ action: "fill", tabId: 1, ref: "e3", text: "After" }),
    /not editable/,
  );
  assert.equal(mock.calls.filter((call) => call.method === "page.fill").length, 1);
  assert.equal(commands(mock, "Runtime.callFunctionOn").length, 0);
});

test("fixed browser operations use extension helpers without arbitrary JavaScript", async () => {
  const mock = new ChromeMock();
  mock.override = (method) => {
    if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
      throw new Error("Domain policy: arbitrary JavaScript is disabled.");
    }
    return undefined;
  };
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  await browser.execute({ action: "fill", tabId: 1, ref: "e3", text: "After" });
  await browser.execute({ action: "scroll", tabId: 1, x: 0, y: 100 });
  await browser.execute({ action: "wait", tabId: 1 });
  await browser.execute({ action: "open", url: "https://allowed.test/" });
  await browser.execute({ action: "navigate", tabId: 1, url: "https://allowed.test/next" });
  assert.equal(commands(mock, "Runtime.evaluate").length, 0);
  assert.equal(commands(mock, "Runtime.callFunctionOn").length, 0);
  const fields = new Set(
    mock.calls.filter((call) => call.method === "page.read").map((call) => call.params.field),
  );
  assert.deepEqual(fields, new Set(["title", "viewport", "readyState"]));
});

test("default wait bounds a stalled ready-state helper without falling back to evaluation", async () => {
  const mock = new ChromeMock();
  mock.override = (method) => (method === "page.read" ? new Promise(() => {}) : undefined);
  const browser = new BrowserSession(mock);
  await assert.rejects(browser.execute({ action: "wait", tabId: 1, timeoutMs: 5 }), /within 5ms/);
  assert.equal(commands(mock, "Runtime.evaluate").length, 0);
});

test("navigation readiness propagates domain-policy denials immediately", async () => {
  const mock = new ChromeMock();
  mock.override = (method) => {
    if (method === "page.read") throw new Error("Domain policy: page access is denied.");
    return undefined;
  };
  const browser = new BrowserSession(mock);
  await assert.rejects(
    browser.execute({ action: "open", url: "https://blocked.test/" }),
    /^Error: Domain policy:/,
  );
  assert.equal(mock.calls.filter((call) => call.method === "page.read").length, 1);
});

test("evaluate and expression waits surface domain policy errors without helper fallback", async () => {
  const mock = new ChromeMock();
  mock.override = (method) => {
    if (method === "Runtime.evaluate")
      throw new Error("Domain policy: arbitrary JavaScript is disabled.");
    return undefined;
  };
  const browser = new BrowserSession(mock);
  await assert.rejects(
    browser.execute({ action: "evaluate", tabId: 1, expression: "document.title" }),
    /^Error: Domain policy:/,
  );
  await assert.rejects(
    browser.execute({ action: "wait", tabId: 1, expression: "document.readyState === 'complete'" }),
    /^Error: Domain policy:/,
  );
  assert.equal(commands(mock, "Runtime.evaluate").length, 2);
  assert.equal(mock.calls.filter((call) => call.method === "page.read").length, 0);
});

test("reset expires references and a new snapshot issues fresh references", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  browser.reset();
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2" }),
    /Unknown or expired/,
  );
  const refreshed = (await browser.execute({ action: "snapshot", tabId: 1 })) as BrowserSnapshot;
  assert.match(refreshed.text, /\[e5\] button/);
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2" }),
    /Unknown or expired/,
  );
  await browser.execute({ action: "click", tabId: 1, ref: "e5" });
});

test("reset during an in-flight snapshot prevents publishing old references", async () => {
  const mock = new ChromeMock();
  let release!: () => void;
  mock.override = async (method) => {
    if (method !== "page.read") return undefined;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "Test page";
  };
  const browser = new BrowserSession(mock);
  const snapshot = browser.execute({ action: "snapshot", tabId: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  browser.reset();
  release();
  await assert.rejects(snapshot, /permissions changed while taking a snapshot/);
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2" }),
    /Unknown or expired/,
  );
});

test("screenshot is a bounded JPEG image tool-output content block", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  assert.deepEqual(await browser.execute({ action: "screenshot", tabId: 1 }), [
    { type: "input_image", image_url: "data:image/jpeg;base64,aW1hZ2U=", filename: "browser.jpg" },
  ]);
  assert.deepEqual(commands(mock, "Page.captureScreenshot"), [
    { format: "jpeg", quality: 70, captureBeyondViewport: false },
  ]);
});

test("oversized screenshot scales the current scrolled viewport and counts its data-URL header", async () => {
  const mock = new ChromeMock();
  let captures = 0;
  mock.override = (method, params) => {
    if (method === "page.read" && params.field === "viewport") {
      return { width: 1000, height: 800, scrollX: 120, scrollY: 240 };
    }
    if (method === "Page.captureScreenshot") {
      captures++;
      // The base64 alone fits 700k, but its data-URL header would cross the limit.
      return {
        data:
          captures === 1 ? "x".repeat(700000 - "data:image/jpeg;base64,".length + 1) : "c21hbGw=",
      };
    }
    return undefined;
  };
  const browser = new BrowserSession(mock);
  assert.deepEqual(await browser.execute({ action: "screenshot", tabId: 1 }), [
    { type: "input_image", image_url: "data:image/jpeg;base64,c21hbGw=", filename: "browser.jpg" },
  ]);
  const requests = commands(mock, "Page.captureScreenshot");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], {
    format: "jpeg",
    quality: 70,
    captureBeyondViewport: false,
    clip: { x: 120, y: 240, width: 1000, height: 800, scale: 0.75 },
  });
});

test("screenshot retries are bounded and an oversized result fails rather than returning a file", async () => {
  const mock = new ChromeMock();
  mock.override = (method) =>
    method === "Page.captureScreenshot" ? { data: "x".repeat(700001) } : undefined;
  const browser = new BrowserSession(mock);
  await assert.rejects(
    browser.execute({ action: "screenshot", tabId: 1 }),
    /too large for inline image output after six captures/,
  );
  const requests = commands(mock, "Page.captureScreenshot");
  assert.equal(requests.length, 6);
  assert.deepEqual(
    requests.map((params) => (params.clip ? (params.clip as { scale: number }).scale : 1)),
    [1, 0.75, 0.5, 0.35, 0.25, 0.125],
  );
});

test("screenshot model-run budget cannot exceed 8 MiB and can be reset independently of references", async () => {
  const mock = new ChromeMock();
  const data = "x".repeat(700000 - "data:image/jpeg;base64,".length);
  mock.override = (method) => (method === "Page.captureScreenshot" ? { data } : undefined);
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  for (let index = 0; index < 11; index++)
    await browser.execute({ action: "screenshot", tabId: 1 });
  await assert.rejects(
    browser.execute({ action: "screenshot", tabId: 1 }),
    /remaining inline image budget/,
  );
  browser.resetMediaBudget();
  await browser.execute({ action: "screenshot", tabId: 1 });
  await browser.execute({ action: "click", tabId: 1, ref: "e2" });
  for (let index = 0; index < 10; index++)
    await browser.execute({ action: "screenshot", tabId: 1 });
  await assert.rejects(
    browser.execute({ action: "screenshot", tabId: 1 }),
    /remaining inline image budget/,
  );
  browser.reset();
  await browser.execute({ action: "screenshot", tabId: 1 });
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2" }),
    /Unknown or expired/,
  );
});

test("evaluate surfaces JavaScript exception details", async () => {
  const mock = new ChromeMock();
  mock.override = (method) =>
    method === "Runtime.evaluate"
      ? {
          result: { type: "undefined" },
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: bad script" } },
        }
      : undefined;
  const browser = new BrowserSession(mock);
  await assert.rejects(
    browser.execute({ action: "evaluate", tabId: 1, expression: "throw Error('bad script')" }),
    /bad script/,
  );
});

test("keyboard shortcut uses modifier bits without inserting literal text", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "press", tabId: 1, key: "Control+a" });
  const [down, up] = commands(mock, "Input.dispatchKeyEvent");
  assert.equal(down!.modifiers, 2);
  assert.equal(down!.type, "rawKeyDown");
  assert.equal(down!.text, undefined);
  assert.equal(up!.type, "keyUp");
  await browser.execute({ action: "press", tabId: 1, key: "Enter" });
  assert.equal(commands(mock, "Input.dispatchKeyEvent")[2]!.text, "\r");
});

test("macOS editing shortcuts dispatch explicit Blink editing commands", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock, { platform: "darwin" });
  const shortcuts = [
    ["Meta+A", "selectAll"],
    ["Meta+C", "copy"],
    ["Meta+V", "paste"],
    ["Meta+X", "cut"],
    ["Meta+Z", "undo"],
    ["Meta+Shift+Z", "redo"],
  ] as const;
  for (const [shortcut, command] of shortcuts) {
    await browser.execute({ action: "press", tabId: 1, key: shortcut });
    const events = commands(mock, "Input.dispatchKeyEvent");
    const down = events.at(-2);
    const up = events.at(-1);
    assert.deepEqual(down?.commands, [command], shortcut);
    assert.equal(down?.text, undefined, shortcut);
    assert.equal(up?.commands, undefined, shortcut);
  }
  await browser.execute({ action: "press", tabId: 1, key: "Control+A" });
  assert.equal(commands(mock, "Input.dispatchKeyEvent").at(-2)?.commands, undefined);
});

test("non-macOS editing shortcuts use Control instead of Meta", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock, { platform: "linux" });
  const shortcuts = [
    ["Control+A", "selectAll"],
    ["Control+Z", "undo"],
    ["Control+Shift+Z", "redo"],
    ["Control+Y", "redo"],
  ] as const;
  for (const [shortcut, command] of shortcuts) {
    await browser.execute({ action: "press", tabId: 1, key: shortcut });
    assert.deepEqual(commands(mock, "Input.dispatchKeyEvent").at(-2)?.commands, [command]);
  }
  await browser.execute({ action: "press", tabId: 1, key: "Meta+A" });
  assert.equal(commands(mock, "Input.dispatchKeyEvent").at(-2)?.commands, undefined);
});

test("scroll sends wheel deltas at the viewport center", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "scroll", tabId: 1, x: 0, y: 400 });
  assert.deepEqual(commands(mock, "Input.dispatchMouseEvent"), [
    { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 400 },
  ]);
});

test("navigate awaits the new loader and produces fresh references", async () => {
  const mock = new ChromeMock();
  const browser = new BrowserSession(mock);
  await browser.execute({ action: "snapshot", tabId: 1 });
  const result = (await browser.execute({
    action: "navigate",
    tabId: 1,
    url: "https://other.test/",
  })) as BrowserSnapshot;
  assert.equal(result.documentId, "main:loader-2");
  assert.equal(result.url, "https://other.test/");
  await assert.rejects(
    browser.execute({ action: "click", tabId: 1, ref: "e2" }),
    /Unknown or expired/,
  );
});

test("navigation errors surface the Chrome error", async () => {
  const mock = new ChromeMock();
  mock.override = (method) =>
    method === "Page.navigate" ? { errorText: "net::ERR_NAME_NOT_RESOLVED" } : undefined;
  const browser = new BrowserSession(mock);
  await assert.rejects(
    browser.execute({ action: "navigate", tabId: 1, url: "https://missing.test/" }),
    /ERR_NAME_NOT_RESOLVED/,
  );
});

test("reload can replace an allowed main document whose old child fails the frame policy", async () => {
  const mock = new ChromeMock();
  let reloadSent = false;
  let postReloadMarkers = 0;
  let oldFrameReads = 0;
  mock.override = (method, params) => {
    if (method === "Page.reload") {
      reloadSent = true;
      return {};
    }
    if (method === "page.read" && params.field === "navigation" && reloadSent) {
      postReloadMarkers++;
      if (postReloadMarkers > 1) mock.loaderId = "reloaded-allowed-document";
      return { id: "main", loaderId: mock.loaderId, url: mock.url };
    }
    if (method === "Page.getFrameTree" && mock.loaderId === "loader-1") {
      oldFrameReads++;
      throw new Error("Domain policy: blocked child frame.");
    }
    return undefined;
  };
  const browser = new BrowserSession(mock);
  const result = (await browser.execute({ action: "reload", tabId: 1 })) as BrowserSnapshot;
  assert.equal(reloadSent, true);
  assert.ok(
    postReloadMarkers >= 2,
    "Reload waits until the new main loader replaces the old child tree.",
  );
  assert.equal(oldFrameReads, 0, "Full content checks run only after reload commits.");
  assert.ok(
    commands(mock, "Page.getFrameTree").length > 0,
    "New document still receives full frame-policy checks.",
  );
  assert.equal(result.documentId, "main:reloaded-allowed-document");
});

test("reload does not bypass a policy denial on the main document", async () => {
  const mock = new ChromeMock();
  mock.override = (method, params) => {
    if (method === "page.read" && params.field === "navigation")
      throw new Error("Domain policy: main document is blocked.");
    return undefined;
  };
  const browser = new BrowserSession(mock);
  await assert.rejects(browser.execute({ action: "reload", tabId: 1 }), /^Error: Domain policy:/);
  assert.equal(commands(mock, "Page.reload").length, 0);
});

test("execute serializes stateful calls, and failure does not poison the queue", async () => {
  const mock = new ChromeMock();
  const started: string[] = [];
  let release!: () => void;
  mock.override = async (method, params) => {
    if (method !== "Runtime.evaluate") return undefined;
    started.push(String(params.expression));
    if (params.expression === "first")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (params.expression === "second") throw new Error("second failed");
    return { result: { type: "boolean", value: true } };
  };
  const browser = new BrowserSession(mock);
  const first = browser.execute({ action: "evaluate", tabId: 1, expression: "first" });
  const second = browser.execute({ action: "evaluate", tabId: 1, expression: "second" });
  const third = browser.execute({ action: "evaluate", tabId: 1, expression: "third" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  release();
  await first;
  await assert.rejects(second, /second failed/);
  assert.equal(await third, true);
  assert.deepEqual(started, ["first", "second", "third"]);
});

test("wait polls a predicate and reports bounded timeout", async () => {
  const mock = new ChromeMock();
  mock.override = (method) =>
    method === "Runtime.evaluate" ? { result: { type: "boolean", value: false } } : undefined;
  const browser = new BrowserSession(mock);
  await assert.rejects(
    browser.execute({ action: "wait", tabId: 1, expression: "false", timeoutMs: 2 }),
    /within 2ms/,
  );
  await assert.rejects(
    browser.execute({ action: "wait", tabId: 1, timeoutMs: 30001 }),
    /between 1 and 30000/,
  );
});
