import assert from "node:assert/strict";
import test from "node:test";

type Policy = { mode: "all" | "allowlist"; allow: string[]; block: string[] };
type Rule = {
  id: number;
  priority: number;
  action: { type: string };
  condition: {
    tabIds: number[];
    resourceTypes: string[];
    regexFilter?: string;
    urlFilter?: string;
  };
};
type Tab = {
  id: number;
  url: string;
  pendingUrl?: string;
  title: string;
  active: boolean;
  openerTabId?: number;
};
type FrameTree = { frame: Record<string, unknown>; childFrames?: FrameTree[] };
type Dispatcher = {
  dispatch(request: {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<unknown>;
  detachAll(): Promise<void>;
  onTabCreated(tab: Tab): Promise<void>;
  onEvent(source: { tabId: number }, method: string, params: Record<string, unknown>): void;
};

const policyModule = (await import(
  new URL("../extension/domain-policy.js", import.meta.url).href
)) as {
  normalizeDomainPolicy(value: unknown): Policy;
  policyAllowsUrl(policy: Policy, url: unknown): boolean;
  buildNavigationRules(policy: Policy, tabIds: number[]): Rule[];
};
const { createDispatcher } = (await import(
  new URL("../extension/protocol.js", import.meta.url).href
)) as {
  createDispatcher(browser: unknown): Dispatcher;
};

const allowOrigin = "https://allowed.test";
const deniedOrigin = "https://denied.test";
const restricted: Policy = { mode: "allowlist", allow: [allowOrigin], block: [] };

class ChromePolicyMock {
  saved: { domainPolicy?: Policy } = {};
  rules: Rule[] = [];
  events: string[] = [];
  commands: { tabId: number; method: string; params: Record<string, unknown> }[] = [];
  navigationCounter = 0;
  readyState = "complete";
  reloadChangesLoader = true;
  onNavigation?: (tabId: number, frame: Record<string, unknown>, type: string) => void;
  tabsById = new Map<number, Tab>([
    [1, { id: 1, url: `${allowOrigin}/page`, title: "Allowed", active: true }],
    [2, { id: 2, url: `${deniedOrigin}/secret`, title: "Private blocked title", active: false }],
  ]);
  frameTree: FrameTree = {
    frame: { id: "main", loaderId: "preexisting-loader", url: `${allowOrigin}/page` },
  };
  frameOwnerAttributes = new Map<string, string[]>();
  history = [
    { id: 10, url: `${deniedOrigin}/secret`, title: "Private blocked title" },
    { id: 11, url: `${allowOrigin}/page`, title: "Allowed" },
  ];
  storage = {
    local: {
      get: async () => structuredClone(this.saved),
      set: async (value: { domainPolicy: Policy }) => {
        this.saved = structuredClone(value);
      },
    },
  };
  declarativeNetRequest = {
    getSessionRules: async () => structuredClone(this.rules),
    updateSessionRules: async (value: { removeRuleIds: number[]; addRules: Rule[] }) => {
      this.events.push("rules");
      this.rules = [
        ...this.rules.filter((rule) => !value.removeRuleIds.includes(rule.id)),
        ...structuredClone(value.addRules),
      ];
    },
  };
  tabs = {
    query: async () => [...this.tabsById.values()].map((tab) => ({ ...tab })),
    get: async (tabId: number) => {
      const tab = this.tabsById.get(tabId);
      assert.ok(tab);
      return { ...tab };
    },
    create: async ({ url }: { url: string }) => {
      this.events.push(`create:${url}`);
      const tab = { id: 3, url, title: "", active: true };
      this.tabsById.set(3, tab);
      this.frameTree = {
        frame: { id: "main", loaderId: `blank-${this.navigationCounter++}`, url },
      };
      return { ...tab };
    },
    update: async (tabId: number, changes: { url?: string; active?: boolean }) => {
      this.events.push(`update:${tabId}:${changes.url ?? "activate"}`);
      const tab = this.tabsById.get(tabId);
      assert.ok(tab);
      Object.assign(tab, changes);
      if (changes.url) {
        this.frameTree = {
          frame: {
            id: "main",
            loaderId: `navigation-${this.navigationCounter++}`,
            url: changes.url,
          },
        };
        this.onNavigation?.(tabId, this.frameTree.frame, "Navigation");
      }
      return { ...tab };
    },
    remove: async (tabId: number) => {
      this.events.push(`remove:${tabId}`);
      this.tabsById.delete(tabId);
    },
  };
  debugger = {
    attach: async ({ tabId }: { tabId: number }) => {
      this.events.push(`attach:${tabId}`);
    },
    detach: async ({ tabId }: { tabId: number }) => {
      this.events.push(`detach:${tabId}`);
    },
    sendCommand: async (
      { tabId }: { tabId: number },
      method: string,
      params: Record<string, unknown>,
    ) => {
      this.commands.push({ tabId, method, params });
      if (method === "Page.navigate") {
        const loaderId = `navigation-${this.navigationCounter++}`;
        this.frameTree = { frame: { id: "main", loaderId, url: String(params.url) } };
        const tab = this.tabsById.get(tabId);
        if (tab) tab.url = String(params.url);
        this.onNavigation?.(tabId, this.frameTree.frame, "Navigation");
        return { loaderId };
      }
      if (method === "Page.reload") {
        if (this.reloadChangesLoader) {
          this.frameTree.frame.loaderId = `reload-${this.navigationCounter++}`;
          this.onNavigation?.(tabId, this.frameTree.frame, "Navigation");
        }
        return {};
      }
      if (method === "Page.getFrameTree") return { frameTree: structuredClone(this.frameTree) };
      if (method === "Page.getNavigationHistory")
        return { currentIndex: 1, entries: structuredClone(this.history) };
      if (method === "DOM.resolveNode") return { object: { objectId: "editable" } };
      if (method === "DOM.getFrameOwner") {
        const index = [...this.frameOwnerAttributes.keys()].indexOf(String(params.frameId));
        if (index < 0) throw new Error("No frame owner.");
        return { backendNodeId: index + 500 };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            localName: "iframe",
            attributes: [...this.frameOwnerAttributes.values()][Number(params.backendNodeId) - 500],
          },
        };
      }
      if (method === "Runtime.callFunctionOn") return { result: { value: { filled: true } } };
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value:
              params.expression === "document.title"
                ? "Allowed"
                : params.expression === "document.readyState"
                  ? this.readyState
                  : { width: 800, height: 600, scrollX: 12, scrollY: 34 },
          },
        };
      }
      return {};
    },
  };
}

let nextRequest = 0;
function request(dispatcher: Dispatcher, method: string, params: Record<string, unknown> = {}) {
  return dispatcher.dispatch({ id: `domain-${nextRequest++}`, method, params });
}
async function setup(fresh = true) {
  const chrome = new ChromePolicyMock();
  const dispatcher = createDispatcher(chrome);
  chrome.onNavigation = (tabId, frame, type) =>
    dispatcher.onEvent({ tabId }, "Page.frameNavigated", { frame, type });
  await request(dispatcher, "policy.set", { policy: restricted });
  if (fresh) {
    await request(dispatcher, "cdp.send", {
      tabId: 1,
      method: "Page.navigate",
      params: { url: `${allowOrigin}/page` },
    });
    await request(dispatcher, "page.read", { tabId: 1, field: "readyState" });
  }
  chrome.commands.length = 0;
  chrome.events.length = 0;
  return { chrome, dispatcher };
}

test("exact origin policy normalizes ports and deny overrides allow", () => {
  const policy = policyModule.normalizeDomainPolicy({
    mode: "allowlist",
    allow: ["https://ALLOWED.test:443/", allowOrigin],
    block: [allowOrigin],
  });
  assert.deepEqual(policy.allow, [allowOrigin]);
  assert.equal(policyModule.policyAllowsUrl(policy, `${allowOrigin}/page`), false);
  assert.equal(policyModule.policyAllowsUrl(restricted, `${allowOrigin}/page`), true);
  for (const url of [
    "http://allowed.test/",
    "https://sub.allowed.test/",
    "https://allowed.test:444/",
    "https://allowed.test.evil.test/",
    "data:text/plain,hello",
    "about:srcdoc",
  ]) {
    assert.equal(policyModule.policyAllowsUrl(restricted, url), false, url);
  }
  assert.equal(policyModule.policyAllowsUrl(restricted, "about:blank"), true);
  for (const origin of [
    "allowed.test",
    "https://allowed.test/path",
    "https://user@allowed.test/",
    "https://allowed.test/?query=1",
  ]) {
    assert.throws(() =>
      policyModule.normalizeDomainPolicy({ mode: "all", allow: [origin], block: [] }),
    );
  }
});

test("navigation rules cover documents on controlled tabs and leave site resources alone", () => {
  const rules = policyModule.buildNavigationRules({ ...restricted, block: [allowOrigin] }, [7, 3]);
  assert.ok(rules.every((rule) => JSON.stringify(rule.condition.tabIds) === "[3,7]"));
  assert.ok(
    rules.every(
      (rule) => JSON.stringify(rule.condition.resourceTypes) === '["main_frame","sub_frame"]',
    ),
  );
  const defaultDeny = rules.find((rule) => rule.condition.regexFilter);
  const allow = rules.find((rule) => rule.action.type === "allow");
  const deny = rules.find((rule) => rule.action.type === "block" && rule !== defaultDeny);
  assert.ok(defaultDeny && allow && deny);
  assert.ok(deny.priority > allow.priority && allow.priority > defaultDeny.priority);
  assert.ok(new RegExp(allow.condition.regexFilter ?? "").test(`${allowOrigin}/path`));
  assert.equal(
    new RegExp(allow.condition.regexFilter ?? "").test("https://sub.allowed.test/path"),
    false,
  );
  assert.deepEqual(
    policyModule.buildNavigationRules({ mode: "all", allow: [], block: [] }, [1]),
    [],
  );
});

test("wildcard origins include apex and proper-label subdomains without widening exact entries", () => {
  const policy = policyModule.normalizeDomainPolicy({
    mode: "allowlist",
    allow: ["https://*.EXAMPLE.com:443/"],
    block: [],
  });
  assert.deepEqual(policy.allow, ["https://*.example.com"]);
  for (const url of [
    "https://example.com/",
    "https://www.example.com/products/widget",
    "https://a.b.example.com/",
  ]) {
    assert.equal(policyModule.policyAllowsUrl(policy, url), true, url);
  }
  for (const url of [
    "http://www.example.com/",
    "https://www.example.com:444/",
    "https://example.com.evil.test/",
    "https://evilexample.com/",
    "https://-bad.example.com/",
    "https://bad-.example.com/",
    "https://a..example.com/",
  ]) {
    assert.equal(policyModule.policyAllowsUrl(policy, url), false, url);
  }
  const exact: Policy = { mode: "allowlist", allow: ["https://www.example.com"], block: [] };
  assert.equal(policyModule.policyAllowsUrl(exact, "https://www.example.com/"), true);
  assert.equal(policyModule.policyAllowsUrl(exact, "https://example.com/"), false);
  assert.equal(policyModule.policyAllowsUrl(exact, "https://nested.www.example.com/"), false);
});

test("wildcard patterns preserve scheme and nondefault port and denied patterns override allowed patterns", () => {
  const policy: Policy = {
    mode: "allowlist",
    allow: ["http://*.example.test:8080"],
    block: ["http://*.private.example.test:8080"],
  };
  assert.equal(policyModule.policyAllowsUrl(policy, "http://example.test:8080/"), true);
  assert.equal(policyModule.policyAllowsUrl(policy, "http://public.example.test:8080/"), true);
  for (const url of [
    "http://private.example.test:8080/",
    "http://a.private.example.test:8080/",
    "https://public.example.test:8080/",
    "http://public.example.test/",
    "http://public.example.test:8081/",
  ]) {
    assert.equal(policyModule.policyAllowsUrl(policy, url), false, url);
  }
  const denyWildcard: Policy = {
    mode: "all",
    allow: ["https://shop.example.test"],
    block: ["https://*.example.test"],
  };
  assert.equal(policyModule.policyAllowsUrl(denyWildcard, "https://shop.example.test/"), false);
  assert.equal(policyModule.policyAllowsUrl(denyWildcard, "https://example.test/"), false);
  assert.equal(policyModule.policyAllowsUrl(denyWildcard, "https://other.test/"), true);
});

test("wildcard validation rejects broad, partial, encoded and IP wildcard patterns", () => {
  for (const entry of [
    "https://*.com",
    "https://*.localhost",
    "https://*.127.0.0.1",
    "https://*.[::1]",
    "https://*.0x7f000001",
    "https://*example.com",
    "https://www.*.example.com",
    "https://*.*.example.com",
    "https://*.example.com/path",
    "https://%2A.example.com",
    "https://*.user@example.com",
    "https://*.a_.example.com",
    "https://*.-bad.example.com",
  ]) {
    assert.throws(
      () => policyModule.normalizeDomainPolicy({ mode: "allowlist", allow: [entry], block: [] }),
      /Domain policy:/,
      entry,
    );
  }
});

test("DNR wildcard regex uses full origin boundaries and the same apex, label, scheme and port semantics", () => {
  const policy: Policy = {
    mode: "allowlist",
    allow: ["http://*.example.test:8080"],
    block: ["http://*.private.example.test:8080"],
  };
  const rules = policyModule.buildNavigationRules(policy, [12]);
  const allow = rules.find((rule) => rule.action.type === "allow");
  const deny = rules.find((rule) => rule.priority > (allow?.priority ?? Infinity));
  assert.ok(allow?.condition.regexFilter && deny?.condition.regexFilter);
  const matches = (rule: Rule, url: string) =>
    new RegExp(rule.condition.regexFilter ?? "", "i").test(new URL(url).href);
  assert.equal(matches(allow, "http://example.test:8080/path"), true);
  assert.equal(matches(allow, "http://www.a.example.test:8080/path"), true);
  assert.equal(matches(deny, "http://private.example.test:8080/path"), true);
  assert.equal(matches(deny, "http://a.private.example.test:8080/path"), true);
  for (const url of [
    "http://example.test.evil:8080/",
    "http://evilexample.test:8080/",
    "http://-bad.example.test:8080/",
    "http://bad-.example.test:8080/",
    "http://a..example.test:8080/",
    "http://www.example.test:8081/",
    "https://www.example.test:8080/",
  ]) {
    assert.equal(matches(allow, url), false, url);
  }
  assert.ok(deny.priority > allow.priority);
});

test("trusted wildcard matching additionally rejects overlong DNS labels", () => {
  const policy: Policy = { mode: "allowlist", allow: ["https://*.example.test"], block: [] };
  assert.equal(
    policyModule.policyAllowsUrl(policy, `https://${"a".repeat(63)}.example.test/`),
    true,
  );
  assert.equal(
    policyModule.policyAllowsUrl(policy, `https://${"a".repeat(64)}.example.test/`),
    false,
  );
});

test("policy persists, filters tab metadata and refuses blocked interaction", async () => {
  const { chrome, dispatcher } = await setup();
  assert.deepEqual(await request(dispatcher, "policy.get"), restricted);
  assert.deepEqual(chrome.saved.domainPolicy, restricted);
  assert.deepEqual(await request(dispatcher, "tabs.list"), [
    { id: 1, url: `${allowOrigin}/page`, title: "Allowed", active: true },
  ]);
  await assert.rejects(
    request(dispatcher, "tabs.activate", { tabId: 2 }),
    /^Error: Domain policy:/,
  );
  await assert.rejects(request(dispatcher, "tabs.close", { tabId: 2 }), /^Error: Domain policy:/);
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 2, field: "title" }),
    /^Error: Domain policy:/,
  );
  assert.equal(
    chrome.events.some((event) => event.includes(":2")),
    false,
  );
  const restarted = createDispatcher(chrome);
  assert.deepEqual(await request(restarted, "policy.get"), restricted);
});

test("new tabs receive rules while blank before their requested navigation", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.events.length = 0;
  await request(dispatcher, "tabs.create", { url: `${allowOrigin}/new` });
  assert.deepEqual(chrome.events, [
    "create:about:blank",
    "rules",
    "attach:3",
    `update:3:${allowOrigin}/new`,
  ]);
  assert.ok(chrome.rules.every((rule) => rule.condition.tabIds.includes(3)));
  await assert.rejects(
    request(dispatcher, "tabs.create", { url: `${deniedOrigin}/new` }),
    /Domain policy:/,
  );
  assert.equal(chrome.events.filter((event) => event.startsWith("create:")).length, 1);
  await dispatcher.detachAll();
  assert.deepEqual(chrome.rules, []);
});

test("current and pending origins, navigation targets and history remain guarded", async () => {
  const { chrome, dispatcher } = await setup();
  await assert.rejects(
    request(dispatcher, "cdp.send", {
      tabId: 1,
      method: "Page.navigate",
      params: { url: `${deniedOrigin}/redirect` },
    }),
    /Domain policy:/,
  );
  await assert.rejects(
    request(dispatcher, "cdp.send", {
      tabId: 1,
      method: "Page.navigateToHistoryEntry",
      params: { entryId: 10 },
    }),
    /Domain policy:/,
  );
  const history = await request(dispatcher, "cdp.send", {
    tabId: 1,
    method: "Page.getNavigationHistory",
    params: {},
  });
  assert.deepEqual(history, { currentIndex: 0, entries: [chrome.history[1]] });
  const tab = chrome.tabsById.get(1);
  assert.ok(tab);
  tab.pendingUrl = `${deniedOrigin}/redirect`;
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  assert.deepEqual(await request(dispatcher, "tabs.list"), []);
  assert.equal(
    chrome.commands.some((command) => command.method === "Page.navigateToHistoryEntry"),
    false,
  );
});

test("loaded blocked frames prevent reads while Chrome error placeholders are sanitized", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree.childFrames = [{ frame: { id: "child", url: `${deniedOrigin}/secret` } }];
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy: this tab contains a loaded frame/,
  );
  assert.equal(
    chrome.commands.some((command) => command.method === "Runtime.evaluate"),
    false,
  );
  chrome.frameTree.childFrames = [
    {
      frame: {
        id: "child",
        url: "chrome-error://chromewebdata/",
        unreachableUrl: `${deniedOrigin}/secret`,
        securityOrigin: deniedOrigin,
      },
    },
  ];
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
  const tree = await request(dispatcher, "cdp.send", {
    tabId: 1,
    method: "Page.getFrameTree",
    params: {},
  });
  assert.equal(JSON.stringify(tree).includes(deniedOrigin), false);
  assert.ok(
    chrome.commands.some(
      (command) =>
        command.method === "Network.setBypassServiceWorker" && command.params.bypass === true,
    ),
  );
});

test("empty opaque frame URLs fail closed rather than being treated as neutral error pages", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree.childFrames = [{ frame: { id: "child", url: "", securityOrigin: "://" } }];
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  await assert.rejects(
    request(dispatcher, "cdp.send", { tabId: 1, method: "Page.captureScreenshot", params: {} }),
    /Domain policy:/,
  );
  assert.equal(
    chrome.commands.some(
      (command) =>
        command.method === "Runtime.evaluate" || command.method === "Page.captureScreenshot",
    ),
    false,
  );
});

test("navigation helper exposes only allowed main-frame identity so reload can recover from forbidden children", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree = {
    frame: {
      id: "allowed-main",
      loaderId: "allowed-loader",
      url: `${allowOrigin}/page`,
      securityOrigin: allowOrigin,
    },
    childFrames: [
      {
        frame: {
          id: "private-child",
          loaderId: "private-loader",
          url: `${deniedOrigin}/secret`,
          securityOrigin: deniedOrigin,
        },
      },
    ],
  };
  assert.deepEqual(await request(dispatcher, "page.read", { tabId: 1, field: "navigation" }), {
    id: "allowed-main",
    loaderId: "allowed-loader",
    url: `${allowOrigin}/page`,
  });
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  assert.equal(
    chrome.commands.some((command) => command.method === "Runtime.evaluate"),
    false,
  );
  chrome.frameTree.frame = { id: "main", url: "about:blank", securityOrigin: deniedOrigin };
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "navigation" }),
    /Domain policy:/,
  );
});

test("operator frame diagnostics reveal origins only, including opaque iframe src origins", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree = {
    frame: {
      id: "main",
      url: `${allowOrigin}/private-path?session=PRIVATE_QUERY`,
      securityOrigin: allowOrigin,
    },
    childFrames: [
      {
        frame: {
          id: "known-child",
          parentId: "main",
          url: `${deniedOrigin}/private-document?token=PRIVATE_QUERY`,
          securityOrigin: deniedOrigin,
          name: "PRIVATE_CONTENT",
        },
      },
      { frame: { id: "opaque-child", parentId: "main", url: "", securityOrigin: "://" } },
      { frame: { id: "relative-child", parentId: "main", url: "", securityOrigin: "://" } },
    ],
  };
  chrome.frameOwnerAttributes.set("opaque-child", [
    "src",
    "https://login.support.test/private-path?auth=PRIVATE_QUERY",
    "srcdoc",
    "PRIVATE_CONTENT",
    "data-private",
    "PRIVATE_CONTENT",
  ]);
  chrome.frameOwnerAttributes.set("relative-child", [
    "src",
    "/relative-private-path?auth=PRIVATE_QUERY",
  ]);
  const diagnostic = await request(dispatcher, "policy.inspect", { tabId: 1 });
  assert.deepEqual(diagnostic, {
    topOrigin: allowOrigin,
    frames: [
      {
        frameId: "main",
        origin: allowOrigin,
        allowed: true,
        kind: "document",
        source: "frame-url",
      },
      {
        frameId: "known-child",
        parentFrameId: "main",
        origin: deniedOrigin,
        allowed: false,
        kind: "document",
        source: "frame-url",
      },
      {
        frameId: "opaque-child",
        parentFrameId: "main",
        origin: "https://login.support.test",
        allowed: false,
        kind: "opaque",
        source: "iframe-src",
      },
      {
        frameId: "relative-child",
        parentFrameId: "main",
        origin: allowOrigin,
        allowed: true,
        kind: "opaque",
        source: "iframe-src",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /PRIVATE_QUERY|PRIVATE_CONTENT|private-path|private-document|srcdoc|attributes/,
  );
  assert.equal(
    chrome.commands.some(
      (command) =>
        command.method === "Runtime.evaluate" || command.method === "Runtime.callFunctionOn",
    ),
    false,
  );
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
});

test("operator frame diagnostics cannot inspect a forbidden top-level tab", async () => {
  const { chrome, dispatcher } = await setup();
  await assert.rejects(request(dispatcher, "policy.inspect", { tabId: 2 }), /Domain policy:/);
  assert.equal(chrome.commands.length, 0);
});

test("about:blank cannot reveal a denied inherited origin or unverified tab title", async () => {
  const { chrome, dispatcher } = await setup();
  const blank = {
    id: 9,
    url: "about:blank",
    title: "Private inherited document title",
    active: false,
  };
  chrome.tabsById.set(9, blank);
  assert.equal(JSON.stringify(await request(dispatcher, "tabs.list")).includes(blank.title), false);
  chrome.frameTree = { frame: { id: "main", url: "about:blank", securityOrigin: deniedOrigin } };
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 9, field: "title" }),
    /Domain policy:/,
  );
  await assert.rejects(request(dispatcher, "tabs.activate", { tabId: 9 }), /Domain policy:/);
  await assert.rejects(request(dispatcher, "tabs.close", { tabId: 9 }), /Domain policy:/);
  assert.equal(JSON.stringify(await request(dispatcher, "tabs.list")).includes(blank.title), false);
  chrome.frameTree = {
    frame: { id: "main", url: `${allowOrigin}/page`, securityOrigin: allowOrigin },
    childFrames: [{ frame: { id: "child", url: "about:blank", securityOrigin: deniedOrigin } }],
  };
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  chrome.frameTree = { frame: { id: "main", url: "about:blank", securityOrigin: "://" } };
  await request(dispatcher, "cdp.send", { tabId: 9, method: "Page.reload", params: {} });
  await request(dispatcher, "page.read", { tabId: 9, field: "title" });
  assert.ok(JSON.stringify(await request(dispatcher, "tabs.list")).includes(blank.title));
  await request(dispatcher, "policy.set", { policy: restricted });
  assert.equal(JSON.stringify(await request(dispatcher, "tabs.list")).includes(blank.title), false);
});

test("same-origin srcdoc frames use their effective origin while denied and opaque srcdoc stay unreadable", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree.childFrames = [
    { frame: { id: "child", url: "about:srcdoc", securityOrigin: allowOrigin } },
  ];
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
  for (const securityOrigin of [deniedOrigin, "://"]) {
    chrome.frameTree.childFrames = [
      { frame: { id: "child", url: "about:srcdoc", securityOrigin } },
    ];
    await assert.rejects(
      request(dispatcher, "page.read", { tabId: 1, field: "title" }),
      /Domain policy:/,
    );
  }
});

test("verified sandbox srcdoc inherits allowed creator scope without exposing inline markup", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree.childFrames = [
    { frame: { id: "inline-child", parentId: "main", url: "about:srcdoc", securityOrigin: "://" } },
  ];
  chrome.frameOwnerAttributes.set("inline-child", [
    "sandbox",
    "allow-scripts",
    "srcdoc",
    "PRIVATE_INLINE_MARKUP",
  ]);
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
  const diagnostic = await request(dispatcher, "policy.inspect", { tabId: 1 });
  assert.deepEqual(diagnostic, {
    topOrigin: allowOrigin,
    frames: [
      {
        frameId: "main",
        origin: allowOrigin,
        allowed: true,
        kind: "document",
        source: "frame-url",
      },
      {
        frameId: "inline-child",
        parentFrameId: "main",
        origin: allowOrigin,
        allowed: true,
        kind: "srcdoc",
        source: "inline-parent",
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_INLINE_MARKUP/);
});

test("opaque srcdoc remains forbidden without owner proof, with a mismatched parent, or beneath a forbidden ancestor", async () => {
  const { chrome, dispatcher } = await setup();
  const inline = {
    frame: { id: "inline-child", parentId: "main", url: "about:srcdoc", securityOrigin: "://" },
  };
  chrome.frameTree.childFrames = [inline];
  chrome.frameOwnerAttributes.set("inline-child", [
    "src",
    `${allowOrigin}/permitted-but-not-inline`,
  ]);
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  chrome.frameOwnerAttributes.set("inline-child", ["srcdoc", "PRIVATE_INLINE_MARKUP"]);
  inline.frame.parentId = "different-parent";
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  inline.frame.parentId = "forbidden-parent";
  chrome.frameTree.childFrames = [
    {
      frame: {
        id: "forbidden-parent",
        parentId: "main",
        url: `${deniedOrigin}/page`,
        securityOrigin: deniedOrigin,
      },
      childFrames: [inline],
    },
  ];
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
  const diagnostic = (await request(dispatcher, "policy.inspect", { tabId: 1 })) as {
    frames: Array<{ frameId: string; allowed: boolean; origin: string | null; source: string }>;
  };
  const child = diagnostic.frames.find((frame) => frame.frameId === "inline-child");
  assert.deepEqual(
    child && { allowed: child.allowed, origin: child.origin, source: child.source },
    { allowed: false, origin: null, source: "unavailable" },
  );
});

test("verified nested opaque srcdoc frames inherit only an already validated allowed inline ancestor", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree.childFrames = [
    {
      frame: { id: "inline-one", parentId: "main", url: "about:srcdoc", securityOrigin: "://" },
      childFrames: [
        {
          frame: {
            id: "inline-two",
            parentId: "inline-one",
            url: "about:srcdoc",
            securityOrigin: "://",
          },
        },
      ],
    },
  ];
  chrome.frameOwnerAttributes.set("inline-one", ["srcdoc", "PRIVATE_ONE"]);
  chrome.frameOwnerAttributes.set("inline-two", ["srcdoc", "PRIVATE_TWO"]);
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
});

test("allowed-origin blob frames remain readable without authorizing denied blob documents", async () => {
  const { chrome, dispatcher } = await setup();
  chrome.frameTree.childFrames = [
    { frame: { id: "child", url: `blob:${allowOrigin}/uuid`, securityOrigin: allowOrigin } },
  ];
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
  chrome.frameTree.childFrames = [
    { frame: { id: "child", url: `blob:${deniedOrigin}/uuid`, securityOrigin: deniedOrigin } },
  ];
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:/,
  );
});

test("restricted mode rejects supplied JavaScript and unsafe CDP but accepts owned helpers", async () => {
  const { chrome, dispatcher } = await setup();
  for (const method of [
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "DOM.setOuterHTML",
    "Network.getResponseBody",
  ]) {
    await assert.rejects(
      request(dispatcher, "cdp.send", { tabId: 1, method, params: {} }),
      /Domain policy:/,
    );
  }
  assert.deepEqual(await request(dispatcher, "page.read", { tabId: 1, field: "viewport" }), {
    width: 800,
    height: 600,
    scrollX: 12,
    scrollY: 34,
  });
  assert.ok(
    chrome.commands.some(
      (command) =>
        command.method === "Runtime.evaluate" &&
        command.params.expression === "({width:innerWidth,height:innerHeight,scrollX,scrollY})",
    ),
  );
  assert.deepEqual(
    await request(dispatcher, "page.fill", {
      tabId: 1,
      backendNodeId: 7,
      text: "'); fetch('https://denied.test'); ('",
    }),
    { filled: true },
  );
  const fill = chrome.commands.find((command) => command.method === "Runtime.callFunctionOn");
  assert.ok(fill);
  assert.equal(String(fill.params.functionDeclaration).includes(deniedOrigin), false);
  assert.deepEqual(fill.params.arguments, [{ value: "'); fetch('https://denied.test'); ('" }]);
  await request(dispatcher, "policy.set", { policy: { mode: "all", allow: [], block: [] } });
  await request(dispatcher, "cdp.send", {
    tabId: 1,
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
  });
});

test("popups from a controlled tab are adopted, blocked contents stay hidden, unrelated tabs remain untouched", async () => {
  const { chrome, dispatcher } = await setup();
  await request(dispatcher, "page.read", { tabId: 1, field: "title" });
  const popup: Tab = {
    id: 8,
    openerTabId: 1,
    url: `${deniedOrigin}/popup`,
    title: "Private popup",
    active: false,
  };
  chrome.tabsById.set(8, popup);
  await dispatcher.onTabCreated(popup);
  assert.equal(chrome.tabsById.has(8), false);
  assert.equal(chrome.tabsById.has(2), true);
  assert.ok(
    chrome.rules.every(
      (rule) => !rule.condition.tabIds.includes(2) && !rule.condition.tabIds.includes(8),
    ),
  );
});

test("invalid saved policy fails closed instead of silently reverting to all sites", async () => {
  const chrome = new ChromePolicyMock();
  chrome.saved.domainPolicy = { mode: "wrong" as "all", allow: [], block: [] };
  const dispatcher = createDispatcher(chrome);
  assert.deepEqual(await request(dispatcher, "policy.get"), {
    mode: "allowlist",
    allow: [],
    block: [],
  });
  assert.deepEqual(await request(dispatcher, "tabs.list"), []);
});

test("pre-existing documents with omitted OOP frame metadata cannot be read or acted on before explicit fresh navigation", async () => {
  const { chrome, dispatcher } = await setup(false);
  assert.equal(chrome.frameTree.childFrames, undefined);
  for (const [method, params] of [
    ["page.read", { tabId: 1, field: "title" }],
    ["cdp.send", { tabId: 1, method: "Page.captureScreenshot", params: {} }],
    [
      "cdp.send",
      {
        tabId: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 1, y: 1 },
      },
    ],
  ] as const)
    await assert.rejects(
      request(dispatcher, method, params),
      /Domain policy: explicitly reload or navigate/,
    );
  assert.equal(
    chrome.commands.some((command) =>
      [
        "Page.reload",
        "Runtime.evaluate",
        "Page.captureScreenshot",
        "Input.dispatchMouseEvent",
      ].includes(command.method),
    ),
    false,
  );
  await request(dispatcher, "cdp.send", {
    tabId: 1,
    method: "Page.navigate",
    params: { url: `${allowOrigin}/fresh` },
  });
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
});

test("explicit reload waits for a new real navigation loader instead of trusting the old document", async () => {
  const { chrome, dispatcher } = await setup(false);
  chrome.reloadChangesLoader = false;
  await request(dispatcher, "cdp.send", { tabId: 1, method: "Page.reload", params: {} });
  dispatcher.onEvent({ tabId: 1 }, "Page.frameNavigated", {
    frame: chrome.frameTree.frame,
    type: "Navigation",
  });
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "readyState" }),
    /refresh is still in progress/,
  );
  chrome.frameTree.frame.loaderId = "fresh-reload-loader";
  dispatcher.onEvent({ tabId: 1 }, "Page.frameNavigated", {
    frame: chrome.frameTree.frame,
    type: "Navigation",
  });
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
});

test("policy changes revoke document trust in allow-by-default blocked-site mode without automatic reloads", async () => {
  const { chrome, dispatcher } = await setup();
  await request(dispatcher, "policy.set", {
    policy: { mode: "all", allow: [], block: ["https://*.google.com", "https://*.gmail.com"] },
  });
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy: explicitly reload or navigate/,
  );
  assert.equal(
    chrome.commands.some((command) => command.method === "Page.reload"),
    false,
  );
  await request(dispatcher, "cdp.send", { tabId: 1, method: "Page.reload", params: {} });
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
});

test("normal subsequent navigations stay usable but unknown BFCache restores require a fresh reload", async () => {
  const { chrome, dispatcher } = await setup();
  const knownLoader = chrome.frameTree.frame.loaderId;
  chrome.frameTree.frame.loaderId = "fresh-link-navigation";
  dispatcher.onEvent({ tabId: 1 }, "Page.frameNavigated", {
    frame: chrome.frameTree.frame,
    type: "Navigation",
  });
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
  chrome.frameTree.frame.loaderId = "preexisting-loader";
  dispatcher.onEvent({ tabId: 1 }, "Page.frameNavigated", {
    frame: chrome.frameTree.frame,
    type: "BackForwardCacheRestore",
  });
  dispatcher.onEvent({ tabId: 1 }, "Page.frameNavigated", {
    frame: chrome.frameTree.frame,
    type: "Navigation",
  });
  await assert.rejects(
    request(dispatcher, "page.read", { tabId: 1, field: "title" }),
    /Domain policy:.*explicit reload/,
  );
  chrome.frameTree.frame.loaderId = knownLoader;
  dispatcher.onEvent({ tabId: 1 }, "Page.frameNavigated", {
    frame: chrome.frameTree.frame,
    type: "BackForwardCacheRestore",
  });
  assert.equal(await request(dispatcher, "page.read", { tabId: 1, field: "title" }), "Allowed");
});

test("new restricted tabs install navigation rules and service-worker bypass before their first site request", async () => {
  const { chrome, dispatcher } = await setup(false);
  await request(dispatcher, "tabs.create", { url: `${allowOrigin}/new` });
  assert.equal(await request(dispatcher, "page.read", { tabId: 3, field: "title" }), "Allowed");
  assert.ok(
    chrome.events.indexOf("rules") <
      chrome.events.findIndex((event) => event.startsWith("update:3:")),
  );
  assert.ok(
    chrome.commands.some(
      (command) =>
        command.tabId === 3 &&
        command.method === "Network.setBypassServiceWorker" &&
        command.params.bypass === true,
    ),
  );
});
