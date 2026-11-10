import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge.js";
import { connectBridge, validateClientUrl } from "../src/bridge-client.js";

const origin = `chrome-extension://${"a".repeat(32)}`;

async function openSocket(url: string, socketOrigin?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, socketOrigin ? { origin: socketOrigin } : {});
  await once(socket, "open");
  return socket;
}

async function rejectedUpgrade(url: string, socketOrigin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, socketOrigin ? { origin: socketOrigin } : {});
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("Unexpected successful WebSocket connection."));
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
  });
}

test("authenticates both roles and rejects browser/page client connections", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  assert.equal(
    await rejectedUpgrade(bridge.clientUrl.replace(/token=.*/, `token=${"0".repeat(64)}`)),
    401,
  );
  assert.equal(await rejectedUpgrade(bridge.extensionUrl), 403);
  assert.equal(await rejectedUpgrade(bridge.extensionUrl, "https://example.com"), 403);
  assert.equal(await rejectedUpgrade(bridge.clientUrl, "https://example.com"), 403);
  assert.equal(await rejectedUpgrade(bridge.clientUrl, origin), 403);
  assert.equal(await rejectedUpgrade(bridge.clientUrl.replace("/client?", "/other?")), 403);
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  assert.equal(bridge.isConnected(), true);
  assert.equal(await rejectedUpgrade(bridge.extensionUrl, origin), 409);
});

test("reports extension availability and clear missing-extension errors", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const client = await connectBridge(bridge.clientUrl);
  t.after(() => client.close());
  assert.deepEqual(await client.request("browser.status"), { connected: false });
  await assert.rejects(client.request("tabs.list"), /extension is not connected/);
  await assert.rejects(client.request("something.else"), /Unsupported bridge method/);
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  assert.deepEqual(await client.request("browser.status"), { connected: true });
});

test("correlates overlapping client ids independently and preserves tool errors", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  const first = await connectBridge(bridge.clientUrl);
  const second = await connectBridge(bridge.clientUrl);
  t.after(async () => {
    await first.close();
    await second.close();
  });
  const messages: Array<{ id: string; method: string; params: { label: string } }> = [];
  extension.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    if (!request.id) return;
    messages.push(request);
    if (messages.length === 2) {
      assert.notEqual(messages[0]?.id, messages[1]?.id);
      for (const message of [...messages].reverse()) {
        extension.send(JSON.stringify({ id: message.id, result: message.params.label }));
      }
    } else if (messages.length === 3) {
      extension.send(
        JSON.stringify({ id: request.id, error: "Chrome debugger could not attach." }),
      );
    }
  });
  assert.deepEqual(
    await Promise.all([
      first.request("tabs.list", { label: "first" }),
      second.request("tabs.list", { label: "second" }),
    ]),
    ["first", "second"],
  );
  await assert.rejects(first.request("cdp.send"), /Chrome debugger could not attach/);
});

test("times out pending operations and rejects them on extension disconnect", async (t) => {
  const bridge = await startBridge({ port: 0, requestTimeoutMs: 80 });
  t.after(() => bridge.close());
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  const client = await connectBridge(bridge.clientUrl);
  t.after(() => client.close());
  await assert.rejects(client.request("tabs.list"), /Chrome request timed out/);
  const response = client.request("tabs.list");
  const rejected = assert.rejects(response, /extension disconnected/);
  await once(extension, "message");
  extension.close();
  await rejected;
});

test("malformed messages and unsolicited extension responses do not break the relay", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  extension.send("not json");
  extension.send(JSON.stringify({ id: "nonexistent", result: "ignored" }));
  const rawClient = await openSocket(bridge.clientUrl);
  t.after(() => rawClient.terminate());
  rawClient.send("not json");
  const [invalid] = await once(rawClient, "message");
  assert.match(JSON.parse(invalid.toString()).error, /Expected a JSON request/);
  rawClient.send(JSON.stringify({ id: "valid", method: "browser.status", params: [] }));
  const [badParams] = await once(rawClient, "message");
  assert.match(JSON.parse(badParams.toString()).error, /params must be an object/);
  rawClient.send(JSON.stringify({ id: "valid", method: "browser.status" }));
  const [status] = await once(rawClient, "message");
  assert.deepEqual(JSON.parse(status.toString()), { id: "valid", result: { connected: true } });
});

test("client refuses remote endpoints and malformed authentication URLs", () => {
  const valid = `ws://127.0.0.1:3219/client?token=${"a".repeat(64)}`;
  assert.equal(validateClientUrl(valid).hostname, "127.0.0.1");
  for (const value of [
    valid.replace("127.0.0.1", "example.com"),
    valid.replace("127.0.0.1", "localhost"),
    valid.replace("ws:", "wss:"),
    valid.replace("/client?", "/extension?"),
    valid.replace(/token=.*/, "token=bad"),
    `${valid}&token=${"b".repeat(64)}`,
    `${valid}&extra=true`,
    `${valid}#fragment`,
  ])
    assert.throws(() => validateClientUrl(value), /Expected/);
});

test("closing the bridge rejects pending client requests", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  const client = await connectBridge(bridge.clientUrl);
  t.after(() => client.close());
  const request = client.request("tabs.list");
  const rejected = assert.rejects(request, /bridge (closed|disconnected)/i);
  await once(extension, "message");
  await bridge.close();
  await rejected;
});

test("roundtrips controller policy operations without changing extension policy data", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  const client = await connectBridge(bridge.clientUrl);
  t.after(() => client.close());
  let policy = { mode: "all", allow: [] as string[], block: ["blocked.test"] };
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  extension.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    if (!request.id) return;
    requests.push({ method: request.method, params: request.params });
    if (request.method === "policy.set") policy = request.params.policy;
    extension.send(JSON.stringify({ id: request.id, result: policy }));
  });
  assert.deepEqual(await client.request("policy.get"), policy);
  const updated = {
    mode: "allowlist",
    allow: ["example.test", "*.internal.test"],
    block: ["blocked.test"],
  };
  assert.deepEqual(await client.request("policy.set", { policy: updated }), updated);
  assert.deepEqual(await client.request("policy.get"), updated);
  assert.deepEqual(requests, [
    { method: "policy.get", params: {} },
    { method: "policy.set", params: { policy: updated } },
    { method: "policy.get", params: {} },
  ]);
});

test("forwards fixed page operations and rejects unknown page or policy methods", async (t) => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const extension = await openSocket(bridge.extensionUrl, origin);
  t.after(() => extension.terminate());
  const client = await connectBridge(bridge.clientUrl);
  t.after(() => client.close());
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  extension.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    if (!request.id) return;
    requests.push({ method: request.method, params: request.params });
    extension.send(
      JSON.stringify({
        id: request.id,
        result:
          request.method === "page.read" ? { text: "Visible page content" } : { filled: true },
      }),
    );
  });
  const readParams = { tabId: 7, maxChars: 4000 };
  const fillParams = { tabId: 7, selector: "#name", text: "Controller text" };
  assert.deepEqual(await client.request("page.read", readParams), { text: "Visible page content" });
  assert.deepEqual(await client.request("page.fill", fillParams), { filled: true });
  await assert.rejects(
    client.request("page.execute", { expression: "arbitrary code" }),
    /Unsupported bridge method/,
  );
  await assert.rejects(client.request("policy.delete"), /Unsupported bridge method/);
  assert.deepEqual(requests, [
    { method: "page.read", params: readParams },
    { method: "page.fill", params: fillParams },
  ]);
});
