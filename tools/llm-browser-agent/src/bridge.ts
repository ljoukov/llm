import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const METHODS = new Set([
  "tabs.list",
  "tabs.create",
  "tabs.close",
  "tabs.activate",
  "cdp.send",
  "debugger.detach",
  "browser.status",
  "policy.get",
  "policy.set",
  "policy.inspect",
  "page.read",
  "page.fill",
]);
const TOKEN = /^[a-f0-9]{64}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export interface BrowserBridge {
  readonly port: number;
  readonly token: string;
  readonly extensionUrl: string;
  readonly clientUrl: string;
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface BridgeOptions {
  port?: number;
  token?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  client: WebSocket;
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

export async function startBridge(options: BridgeOptions = {}): Promise<BrowserBridge> {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (!TOKEN.test(token))
    throw new Error("Bridge token must be 64 lowercase hexadecimal characters.");
  const requestedPort = options.port ?? 3219;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error("Bridge port must be an integer between 0 and 65535.");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Request timeout must be positive.");
  }

  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Not found\n");
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const pending = new Map<string, PendingRequest>();
  let extension: WebSocket | undefined;
  let nextId = 0;
  let closing: Promise<void> | undefined;

  const finish = (id: string, result: { result: unknown } | { error: string }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    send(request.client, { id: request.clientId, ...result });
  };
  const failAll = (message: string) => {
    for (const id of pending.keys()) finish(id, { error: message });
  };

  server.on("upgrade", (request, socket, head) => {
    const deny = (status: number, label: string) => {
      socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://127.0.0.1");
    } catch {
      deny(400, "Bad Request");
      return;
    }
    const suppliedToken = url.searchParams.get("token") ?? "";
    if (
      !TOKEN.test(suppliedToken) ||
      url.searchParams.getAll("token").length !== 1 ||
      !timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(token))
    ) {
      deny(401, "Unauthorized");
      return;
    }
    const origin = request.headers.origin;
    const isExtension = url.pathname === "/extension";
    if (isExtension) {
      if (typeof origin !== "string" || !EXTENSION_ORIGIN.test(origin)) {
        deny(403, "Forbidden");
        return;
      }
      if (extension && extension.readyState !== WebSocket.CLOSED) {
        deny(409, "Conflict");
        return;
      }
    } else if (url.pathname !== "/client" || origin !== undefined) {
      deny(403, "Forbidden");
      return;
    }

    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("error", () => {});
      if (isExtension) {
        extension = connection;
        connection.on("message", (raw) => {
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (!record(message) || typeof message.id !== "string") return;
          if (typeof message.error === "string") finish(message.id, { error: message.error });
          else if (Object.hasOwn(message, "result")) finish(message.id, { result: message.result });
        });
        connection.on("close", () => {
          if (extension === connection) {
            extension = undefined;
            failAll("Chrome extension disconnected.");
          }
        });
      } else {
        clients.add(connection);
        connection.on("message", (raw) => {
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            send(connection, { id: null, error: "Expected a JSON request." });
            return;
          }
          if (
            !record(message) ||
            typeof message.id !== "string" ||
            message.id.length === 0 ||
            message.id.length > 128
          ) {
            send(connection, {
              id: null,
              error: "Request requires a nonempty string id (maximum 128 characters).",
            });
            return;
          }
          const clientId = message.id;
          if (typeof message.method !== "string" || !METHODS.has(message.method)) {
            send(connection, { id: clientId, error: "Unsupported bridge method." });
            return;
          }
          if (message.params !== undefined && !record(message.params)) {
            send(connection, { id: clientId, error: "Request params must be an object." });
            return;
          }
          if (message.method === "browser.status") {
            send(connection, {
              id: clientId,
              result: { connected: extension?.readyState === WebSocket.OPEN },
            });
            return;
          }
          if (extension?.readyState !== WebSocket.OPEN) {
            send(connection, {
              id: clientId,
              error:
                "Chrome extension is not connected. Open the extension popup and connect it to this bridge.",
            });
            return;
          }
          if (
            [...pending.values()].some(
              (entry) => entry.client === connection && entry.clientId === clientId,
            )
          ) {
            send(connection, { id: clientId, error: "Request id is already pending." });
            return;
          }
          const id = String(++nextId);
          const timer = setTimeout(
            () => finish(id, { error: "Chrome request timed out." }),
            requestTimeoutMs,
          );
          timer.unref();
          pending.set(id, { client: connection, clientId, timer });
          send(extension, { id, method: message.method, params: message.params ?? {} });
        });
        connection.on("close", () => {
          clients.delete(connection);
          for (const [id, entry] of pending) {
            if (entry.client === connection) {
              clearTimeout(entry.timer);
              pending.delete(id);
            }
          }
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Bridge failed to obtain a listening port.");
  const port = address.port;
  const heartbeat = setInterval(() => {
    if (extension) send(extension, { method: "ping" });
  }, 20_000);
  heartbeat.unref();

  return {
    port,
    token,
    extensionUrl: `ws://127.0.0.1:${port}/extension?token=${token}`,
    clientUrl: `ws://127.0.0.1:${port}/client?token=${token}`,
    isConnected: () => extension?.readyState === WebSocket.OPEN,
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        failAll("Browser bridge closed.");
        extension?.terminate();
        for (const client of clients) client.terminate();
        await Promise.all([
          new Promise<void>((resolve) => sockets.close(() => resolve())),
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        ]);
      })();
      return closing;
    },
  };
}
