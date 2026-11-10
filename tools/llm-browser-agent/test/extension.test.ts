import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Script } from "node:vm";

type Request = { id: string; method: string; params: Record<string, unknown> };
type Dispatcher = {
  dispatch(request: unknown): Promise<unknown>;
  detachAll(): Promise<void>;
  onDetach(source: { tabId?: number }): void;
};

// The extension is deliberately build-free JavaScript. A URL import keeps it
// outside the Node package's emitted source tree while testing that exact file.
const protocol = (await import(new URL("../extension/protocol.js", import.meta.url).href)) as {
  createDispatcher(browser: unknown): Dispatcher;
  validateBridgeUrl(value: unknown): string;
  isRecord(value: unknown): boolean;
};

const connectionUrl = `ws://127.0.0.1:3210/extension?token=${"a".repeat(64)}`;
const cdpRequest: Request = {
  id: "request-1",
  method: "cdp.send",
  params: { tabId: 1, method: "Runtime.evaluate", params: {} },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("extension pairing accepts only the authenticated loopback endpoint", () => {
  assert.equal(protocol.validateBridgeUrl(connectionUrl), connectionUrl);
  for (const url of [
    connectionUrl.replace("127.0.0.1", "localhost"),
    connectionUrl.replace("127.0.0.1", "example.com"),
    connectionUrl.replace("ws:", "wss:"),
    connectionUrl.replace("/extension?", "/client?"),
    connectionUrl.replace("token=", "token=short"),
    `${connectionUrl}&extra=1`,
    `${connectionUrl}&token=${"a".repeat(64)}`,
    `${connectionUrl}#fragment`,
  ])
    assert.throws(() => protocol.validateBridgeUrl(url));
});

test("extension sanitizes tab metadata and rejects malformed commands", async () => {
  const dispatcher = protocol.createDispatcher({
    tabs: {
      query: async () => [
        { id: 1, url: "https://example.test/", title: "Example", active: true, discarded: true },
      ],
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "tabs", method: "tabs.list", params: {} }), [
    { id: 1, url: "https://example.test/", title: "Example", active: true },
  ]);
  await assert.rejects(
    dispatcher.dispatch({ ...cdpRequest, params: { ...cdpRequest.params, tabId: 0 } }),
    /positive integer/,
  );
  await assert.rejects(
    dispatcher.dispatch({ ...cdpRequest, params: { ...cdpRequest.params, method: "bad command" } }),
    /Domain.command/,
  );
  await assert.rejects(
    dispatcher.dispatch({ ...cdpRequest, params: { ...cdpRequest.params, params: [] } }),
    /params must be an object/,
  );
  await assert.rejects(
    dispatcher.dispatch({ ...cdpRequest, method: "something.else" }),
    /Unknown bridge method/,
  );
  await assert.rejects(dispatcher.dispatch({ ...cdpRequest, id: "" }), /nonempty string id/);
});

test("overlapping commands share an attach and only detach the owned debugger", async () => {
  const attached = deferred<void>();
  let attachCount = 0;
  let detachCount = 0;
  let commandCount = 0;
  const dispatcher = protocol.createDispatcher({
    debugger: {
      attach: async () => {
        attachCount += 1;
        await attached.promise;
      },
      detach: async () => {
        detachCount += 1;
      },
      sendCommand: async () => {
        commandCount += 1;
        return { ok: true };
      },
    },
  });
  const first = dispatcher.dispatch(cdpRequest);
  const second = dispatcher.dispatch({ ...cdpRequest, id: "request-2" });
  attached.resolve();
  await Promise.all([first, second]);
  assert.equal(attachCount, 1);
  assert.equal(commandCount, 2);
  await dispatcher.dispatch({
    id: "detach-other",
    method: "debugger.detach",
    params: { tabId: 2 },
  });
  assert.equal(detachCount, 0);
  await dispatcher.detachAll();
  assert.equal(detachCount, 1);
});

test("disconnect during an in-flight attach detaches it and prevents command execution", async () => {
  const attached = deferred<void>();
  let detachCount = 0;
  let commandCount = 0;
  const dispatcher = protocol.createDispatcher({
    debugger: {
      attach: async () => attached.promise,
      detach: async () => {
        detachCount += 1;
      },
      sendCommand: async () => {
        commandCount += 1;
        return {};
      },
    },
  });
  const command = dispatcher.dispatch(cdpRequest);
  const rejected = assert.rejects(command, /connection closed while attaching/);
  const cleanup = dispatcher.detachAll();
  attached.resolve();
  await rejected;
  await cleanup;
  assert.equal(detachCount, 1);
  assert.equal(commandCount, 0);
});

test("Chrome startup and install events register before pairing restoration completes", async () => {
  const stored = deferred<{ bridgeEnabled: boolean; bridgeUrl: string }>();
  const startupListeners: Array<() => void> = [];
  const installedListeners: Array<() => void> = [];
  const createdSockets: string[] = [];
  const chrome = {
    debugger: { onDetach: { addListener() {} } },
    alarms: { onAlarm: { addListener() {} }, create: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    storage: { local: { get: async () => stored.promise } },
    runtime: {
      onMessage: { addListener() {} },
      onStartup: {
        addListener(listener: () => void) {
          startupListeners.push(listener);
        },
      },
      onInstalled: {
        addListener(listener: () => void) {
          installedListeners.push(listener);
        },
      },
    },
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  // The browser supplies Chrome globals; inject the same protocol module here
  // and evaluate the worker without making network or real browser requests.
  new Script(source.replace(/^import[^\n]+\n/, "")).runInNewContext({
    ...protocol,
    chrome,
    WebSocket: class {
      constructor(url: string) {
        createdSockets.push(url);
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  assert.equal(startupListeners.length, 1);
  assert.equal(installedListeners.length, 1);
  startupListeners[0]?.();
  installedListeners[0]?.();
  stored.resolve({ bridgeEnabled: true, bridgeUrl: connectionUrl });
  await setImmediate();
  assert.deepEqual(createdSockets, [connectionUrl]);
});
