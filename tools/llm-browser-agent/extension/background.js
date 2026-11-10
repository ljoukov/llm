import { createDispatcher, isRecord, validateBridgeUrl } from "./protocol.js";

const dispatcher = createDispatcher(chrome);
const RECONNECT_ALARM = "local-bridge-reconnect";
let socket = null;
let retryTimer = null;
let heartbeatTimer = null;
let desiredUrl = null;
let connectionGeneration = 0;
let cleanup = Promise.resolve();
let status = { state: "disconnected", message: "No local bridge connected." };
let commandQueue = Promise.resolve();

chrome.debugger.onDetach.addListener((source) => dispatcher.onDetach(source));
chrome.debugger.onEvent?.addListener((source, method, params) =>
  dispatcher.onEvent(source, method, params),
);
chrome.tabs?.onCreated?.addListener((tab) => void dispatcher.onTabCreated(tab).catch(() => {}));
chrome.tabs?.onRemoved?.addListener((tabId) => void dispatcher.onTabRemoved(tabId).catch(() => {}));
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) =>
  dispatcher.onTabUpdated(tabId, changeInfo),
);
// Timers alone cannot wake a suspended Manifest V3 worker after the bridge has
// been offline. This alarm restores reconnects without requiring an open popup.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void restoration.then(() => connect());
});
// Register synchronously so Chrome knows these events should wake this worker.
// Restoration reads the saved pairing once; repeated wake events share it.
chrome.runtime.onStartup.addListener(() => void restoration.then(() => connect()));
chrome.runtime.onInstalled.addListener(() => void restoration.then(() => connect()));

function setStatus(state, message) {
  status = { state, message };
  void chrome.action.setBadgeText({ text: state === "connected" ? "ON" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#1b5c47" });
}

function stopConnection() {
  connectionGeneration += 1;
  clearTimeout(retryTimer);
  clearInterval(heartbeatTimer);
  retryTimer = null;
  heartbeatTimer = null;
  const previous = socket;
  socket = null;
  if (previous) previous.close();
  cleanup = cleanup.then(() => dispatcher.detachAll());
  return cleanup;
}

async function connect() {
  if (!desiredUrl) return;
  await cleanup;
  if (!desiredUrl || socket) return;
  const thisGeneration = connectionGeneration;
  setStatus("connecting", "Connecting to the local bridge…");
  const next = new WebSocket(desiredUrl);
  socket = next;
  const current = () => socket === next && thisGeneration === connectionGeneration;

  next.onopen = () => {
    if (!current()) return next.close();
    setStatus("connected", "Connected to the local bridge.");
    // Application messages keep Manifest V3's service worker alive while paired.
    heartbeatTimer = setInterval(() => {
      if (current() && next.readyState === WebSocket.OPEN) {
        next.send(JSON.stringify({ method: "ping" }));
      }
    }, 20_000);
  };

  next.onmessage = async (event) => {
    if (!current()) return;
    let request;
    try {
      request = JSON.parse(event.data);
      if (isRecord(request) && request.method === "ping" && request.id === undefined) {
        next.send(JSON.stringify({ method: "pong" }));
        return;
      }
      if (isRecord(request) && request.method === "pong" && request.id === undefined) return;
      const operation = commandQueue.then(() => {
        if (!current()) throw new Error("Browser connection closed before the command started.");
        return dispatcher.dispatch(request);
      });
      commandQueue = operation.catch(() => {});
      const result = await operation;
      if (current() && next.readyState === WebSocket.OPEN) {
        next.send(JSON.stringify({ id: request.id, result }));
      }
    } catch (error) {
      if (current() && next.readyState === WebSocket.OPEN && typeof request?.id === "string") {
        next.send(
          JSON.stringify({
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  next.onerror = () => {
    if (current()) setStatus("disconnected", "Local bridge unavailable. Reconnecting…");
  };
  next.onclose = () => {
    if (!current()) return;
    socket = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    setStatus("disconnected", "Local bridge unavailable. Reconnecting…");
    cleanup = cleanup.then(() => dispatcher.detachAll());
    if (desiredUrl) retryTimer = setTimeout(() => void connect(), 1_000);
  };
}

// Only this extension's own pages can configure the bridge. There are no content
// scripts, external-message listeners, or webpage-accessible control endpoints.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))
    return false;
  (async () => {
    await restoration;
    if (message?.type === "status") return status;
    if (message?.type === "connect") {
      const url = validateBridgeUrl(message.url);
      desiredUrl = null;
      await stopConnection();
      await chrome.storage.local.set({ bridgeUrl: url, bridgeEnabled: true });
      await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
      desiredUrl = url;
      void connect();
      return { state: "connecting", message: "Connecting to the local bridge…" };
    }
    if (message?.type === "disconnect") {
      desiredUrl = null;
      await chrome.storage.local.set({ bridgeEnabled: false });
      await chrome.alarms.clear(RECONNECT_ALARM);
      await stopConnection();
      setStatus("disconnected", "Disconnected. Browser control is off.");
      return status;
    }
    throw new Error("Unknown popup request.");
  })().then(respond, (error) =>
    respond({ error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

async function restore() {
  const stored = await chrome.storage.local.get(["bridgeUrl", "bridgeEnabled"]);
  if (stored.bridgeEnabled && stored.bridgeUrl) {
    try {
      desiredUrl = validateBridgeUrl(stored.bridgeUrl);
      await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
      await connect();
    } catch {
      setStatus("disconnected", "Saved connection URL is invalid. Pair the bridge again.");
    }
  }
}

const restoration = restore();
