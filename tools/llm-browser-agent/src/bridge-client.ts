import { WebSocket } from "ws";

export interface BridgeClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export function validateClientUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a loopback browser bridge client URL.");
  }
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1 ||
    url.pathname !== "/client" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("token").length !== 1 ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get("token") ?? "") ||
    [...url.searchParams.keys()].some((key) => key !== "token")
  ) {
    throw new Error(
      "Expected ws://127.0.0.1:<port>/client?token=<64 lowercase hexadecimal characters>.",
    );
  }
  return url;
}

export async function connectBridge(
  value: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<BridgeClient> {
  const url = validateClientUrl(value);
  const timeoutMs = options.requestTimeoutMs ?? 35_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Request timeout must be positive.");
  const socket = new WebSocket(url);
  let nextId = 0;
  let closing: Promise<void> | undefined;
  const pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failAll = (message: string) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };
  socket.on("message", (raw) => {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (
      typeof message !== "object" ||
      !message ||
      !("id" in message) ||
      typeof message.id !== "string"
    )
      return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if ("error" in message && typeof message.error === "string")
      entry.reject(new Error(message.error));
    else if ("result" in message) entry.resolve(message.result);
    else entry.reject(new Error("Invalid browser bridge response."));
  });
  socket.on("close", () => failAll("Browser bridge disconnected."));
  socket.on("error", () => failAll("Browser bridge connection failed."));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Browser bridge connection timed out."));
    }, 10_000);
    const onOpen = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve();
    };
    const onError = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      reject(new Error("Could not connect to browser bridge. Start the bridge first."));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  return {
    request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (socket.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error("Browser bridge is not connected."));
      const id = String(++nextId);
      return new Promise<T>((resolve, reject) => {
        const payload = JSON.stringify({ id, method, params });
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Browser bridge request timed out."));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
        socket.send(payload, (error) => {
          if (error) {
            const entry = pending.get(id);
            if (!entry) return;
            clearTimeout(entry.timer);
            pending.delete(id);
            reject(new Error("Browser bridge request could not be sent."));
          }
        });
      });
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const timer = setTimeout(() => socket.terminate(), 1_000);
        timer.unref();
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close();
      });
      return closing;
    },
  };
}
