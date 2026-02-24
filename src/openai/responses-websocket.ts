import WebSocket, { type RawData } from "ws";

import { createAsyncQueue } from "../utils/asyncQueue.js";

export const OPENAI_BETA_RESPONSES_WEBSOCKETS_V1 = "responses_websockets=2026-02-04";
export const OPENAI_BETA_RESPONSES_WEBSOCKETS_V2 = "responses_websockets=2026-02-06";

export type ResponsesWebSocketMode = "auto" | "off" | "only";

export type ResponsesStreamEvent = {
  type?: string;
  [key: string]: unknown;
};

export type ResponsesStreamWithFinal<
  TEvent = ResponsesStreamEvent,
  TFinal = unknown,
> = AsyncIterable<TEvent> & {
  finalResponse: () => Promise<TFinal>;
  close: () => void;
};

export class ResponsesWebSocketHttpError extends Error {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;

  constructor(options: {
    status: number;
    message: string;
    body?: string;
    headers?: Record<string, string>;
  }) {
    super(options.message);
    this.name = "ResponsesWebSocketHttpError";
    this.status = options.status;
    this.body = options.body;
    this.headers = options.headers;
  }
}

export function resolveResponsesWebSocketMode(
  raw: string | undefined,
  fallback: ResponsesWebSocketMode = "auto",
): ResponsesWebSocketMode {
  const value = raw?.trim().toLowerCase();
  if (value === "auto" || value === "off" || value === "only") {
    return value;
  }
  return fallback;
}

export function mergeOpenAiBetaHeader(existing: string | undefined, required: string): string {
  const parts = new Set<string>();
  for (const part of (existing ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      parts.add(trimmed);
    }
  }
  const normalizedRequired = required.trim();
  if (normalizedRequired.length > 0) {
    parts.add(normalizedRequired);
  }
  return Array.from(parts).join(", ");
}

export function toWebSocketUrl(httpOrHttpsUrl: string): string {
  const parsed = new URL(httpOrHttpsUrl);
  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Unsupported websocket URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function isResponsesWebSocketUnsupportedError(error: unknown): boolean {
  if (error instanceof ResponsesWebSocketHttpError) {
    return [400, 404, 405, 406, 426, 501].includes(error.status);
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unexpected server response: 426");
}

export function createAdaptiveResponsesStream<
  TEvent = ResponsesStreamEvent,
  TFinal = unknown,
>(options: {
  mode: ResponsesWebSocketMode;
  createWebSocketStream: () => Promise<ResponsesStreamWithFinal<TEvent, TFinal>>;
  createFallbackStream: () => ResponsesStreamWithFinal<TEvent, TFinal>;
  onWebSocketFallback?: (error: unknown) => void;
}): ResponsesStreamWithFinal<TEvent, TFinal> {
  let resolved: Promise<ResponsesStreamWithFinal<TEvent, TFinal>> | null = null;
  let websocketSelected = false;
  let fallbackSelected = false;

  const activateFallback = (error: unknown): ResponsesStreamWithFinal<TEvent, TFinal> => {
    options.onWebSocketFallback?.(error);
    fallbackSelected = true;
    websocketSelected = false;
    const fallback = options.createFallbackStream();
    resolved = Promise.resolve(fallback);
    return fallback;
  };

  const getStream = async (): Promise<ResponsesStreamWithFinal<TEvent, TFinal>> => {
    if (resolved) {
      return await resolved;
    }
    resolved = (async () => {
      if (options.mode === "off") {
        fallbackSelected = true;
        return options.createFallbackStream();
      }
      try {
        const stream = await options.createWebSocketStream();
        websocketSelected = true;
        return stream;
      } catch (error) {
        if (options.mode === "only") {
          throw error;
        }
        return activateFallback(error);
      }
    })();
    return await resolved;
  };

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
      const stream = await getStream();
      let yielded = 0;
      try {
        for await (const event of stream) {
          yielded += 1;
          yield event;
        }
      } catch (error) {
        if (options.mode !== "only" && websocketSelected && !fallbackSelected && yielded === 0) {
          const fallback = activateFallback(error);
          for await (const event of fallback) {
            yield event;
          }
          return;
        }
        throw error;
      }
    },
    async finalResponse(): Promise<TFinal> {
      const stream = await getStream();
      try {
        return await stream.finalResponse();
      } catch (error) {
        if (options.mode === "only" || !websocketSelected || fallbackSelected) {
          throw error;
        }
        const fallback = activateFallback(error);
        return await fallback.finalResponse();
      }
    },
    close(): void {
      void getStream()
        .then((stream) => stream.close())
        .catch(() => {});
    },
  };
}

type ConnectWebSocketResult = {
  socket: WebSocket;
  responseHeaders: Record<string, string>;
};

type CreateResponsesWebSocketStreamOptions = {
  url: string;
  headers: Record<string, string>;
  request: unknown;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  completionEventTypes?: string[];
};

export async function createResponsesWebSocketStream(
  options: CreateResponsesWebSocketStreamOptions,
): Promise<ResponsesStreamWithFinal<ResponsesStreamEvent, Record<string, unknown>>> {
  const completionTypes = new Set(
    options.completionEventTypes ?? ["response.completed", "response.failed", "response.done"],
  );
  const { socket, responseHeaders } = await connectWebSocket({
    url: options.url,
    headers: options.headers,
    signal: options.signal,
  });
  const queue = createAsyncQueue<ResponsesStreamEvent>();

  let settled = false;
  let finalResponse: Record<string, unknown> | null = null;
  let latestResponse: Record<string, unknown> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let resolveFinal: ((response: Record<string, unknown>) => void) | null = null;
  let rejectFinal: ((error: Error) => void) | null = null;

  const finalPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  void finalPromise.catch(() => {});

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const closeSocket = () => {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      // Ignore close failures.
    }
  };

  const complete = (response: Record<string, unknown>) => {
    if (settled) {
      return;
    }
    settled = true;
    clearIdleTimer();
    finalResponse = response;
    resolveFinal?.(response);
    queue.close();
    closeSocket();
  };

  const fail = (error: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearIdleTimer();
    rejectFinal?.(error);
    queue.fail(error);
    closeSocket();
  };

  const restartIdleTimer = () => {
    clearIdleTimer();
    const idleTimeoutMs = options.idleTimeoutMs;
    if (!idleTimeoutMs || idleTimeoutMs <= 0 || settled) {
      return;
    }
    idleTimer = setTimeout(() => {
      fail(new Error(`Responses WebSocket idle timeout after ${idleTimeoutMs}ms.`));
    }, idleTimeoutMs);
  };

  const onAbort = () => {
    const error = createAbortError(options.signal?.reason);
    fail(error);
  };

  if (options.signal) {
    if (options.signal.aborted) {
      socket.close();
      throw createAbortError(options.signal.reason);
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const cleanup = () => {
    clearIdleTimer();
    socket.removeAllListeners();
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  };

  socket.on("message", (raw: RawData) => {
    restartIdleTimer();
    const parsed = parseWebSocketPayload(raw);
    if (!parsed) {
      return;
    }
    const error = mapWebSocketErrorEvent(parsed);
    if (error) {
      fail(error);
      return;
    }

    const event = parsed as ResponsesStreamEvent;
    if (isObjectWithResponse(event)) {
      latestResponse = event.response;
    }

    queue.push(event);

    const type = typeof event.type === "string" ? event.type : "";
    if (completionTypes.has(type)) {
      const completedResponse = normalizeFinalResponse(
        type,
        event.response,
        latestResponse,
        responseHeaders,
      );
      complete(completedResponse);
    }
  });

  socket.on("error", (error: Error) => {
    fail(new Error(`Responses WebSocket error: ${error.message}`));
  });

  socket.on("close", (_code: number, _reason: Buffer) => {
    if (settled) {
      cleanup();
      return;
    }
    fail(new Error("Responses WebSocket closed before completion."));
    cleanup();
  });

  restartIdleTimer();

  const payload = serializeRequestPayload(options.request);
  await new Promise<void>((resolve, reject) => {
    socket.send(payload, (error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  }).catch((error: unknown) => {
    fail(new Error(`Failed to send Responses WebSocket request: ${errorToMessage(error)}`));
    throw error instanceof Error ? error : new Error(errorToMessage(error));
  });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ResponsesStreamEvent> {
      try {
        for await (const event of queue.iterable) {
          yield event;
        }
      } finally {
        if (!settled) {
          closeSocket();
        }
      }
    },
    async finalResponse(): Promise<Record<string, unknown>> {
      return await finalPromise;
    },
    close(): void {
      if (settled) {
        return;
      }
      const response = finalResponse ?? latestResponse ?? { status: "cancelled" };
      complete(response);
      cleanup();
    },
  };
}

async function connectWebSocket(options: {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ConnectWebSocketResult> {
  return await new Promise<ConnectWebSocketResult>((resolve, reject) => {
    const socket = new WebSocket(options.url, {
      headers: options.headers,
      handshakeTimeout: 30_000,
    });

    let settled = false;
    let responseBody = "";

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        socket.terminate();
      } catch {
        // Ignore terminate failures.
      }
      reject(error);
    };

    const resolveOnce = (result: ConnectWebSocketResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(false);
      resolve(result);
    };

    const onAbort = () => {
      rejectOnce(createAbortError(options.signal?.reason));
    };

    const cleanup = (removeAbortListener = true) => {
      socket.removeListener("open", onOpen);
      socket.removeListener("error", onError);
      socket.removeListener("unexpected-response", onUnexpectedResponse);
      if (removeAbortListener && options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const onOpen = () => {
      const headers = normalizeUpgradeHeaders(socket);
      resolveOnce({ socket, responseHeaders: headers });
    };

    const onError = (error: Error) => {
      rejectOnce(new Error(`Responses WebSocket connection failed: ${error.message}`));
    };

    const onUnexpectedResponse = (
      _request: unknown,
      response: NodeJS.ReadableStream & {
        statusCode?: number;
        headers?: Record<string, string | string[] | undefined>;
        setEncoding?: (encoding: BufferEncoding) => void;
      },
    ) => {
      if (typeof response.setEncoding === "function") {
        response.setEncoding("utf8");
      }
      response.on("data", (chunk) => {
        responseBody += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      response.on("end", () => {
        const status = Number(response.statusCode ?? 0);
        const headers: Record<string, string> = {};
        const rawHeaders = response.headers ?? {};
        for (const [key, value] of Object.entries(rawHeaders)) {
          if (typeof value === "string") {
            headers[key] = value;
          } else if (Array.isArray(value)) {
            headers[key] = value.join(", ");
          }
        }
        rejectOnce(
          new ResponsesWebSocketHttpError({
            status: Number.isFinite(status) && status > 0 ? status : 500,
            message: `Responses WebSocket upgrade failed${status ? ` (${status})` : ""}.`,
            body: responseBody || undefined,
            headers,
          }),
        );
      });
      response.on("error", (error: Error) => {
        rejectOnce(
          new ResponsesWebSocketHttpError({
            status: Number(response.statusCode ?? 500),
            message: `Responses WebSocket upgrade failed: ${error.message}`,
            body: responseBody || undefined,
          }),
        );
      });
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function normalizeUpgradeHeaders(socket: WebSocket): Record<string, string> {
  const maybeUpgradeResponse = (
    socket as WebSocket & {
      _socket?: unknown;
      _req?: { res?: { headers?: Record<string, string | string[] | undefined> } };
    }
  )._req?.res;
  const raw = maybeUpgradeResponse?.headers ?? {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
    }
  }
  return normalized;
}

function parseWebSocketPayload(raw: RawData): Record<string, unknown> | null {
  const text = toUtf8(raw);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function toUtf8(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks = raw.map((chunk) => {
      if (typeof chunk === "string") {
        return Buffer.from(chunk, "utf8");
      }
      return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    });
    return Buffer.concat(chunks).toString("utf8");
  }
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw).toString("utf8");
}

function mapWebSocketErrorEvent(payload: Record<string, unknown>): Error | null {
  if (payload.type !== "error") {
    return null;
  }

  const status = resolveNumericStatus(payload.status) ?? resolveNumericStatus(payload.status_code);
  if (!status || status < 400) {
    const message = errorToMessage(payload.error) || "Responses WebSocket returned an error event.";
    return new Error(message);
  }

  const headers = mapErrorHeaders(payload.headers);
  const body =
    payload.error && typeof payload.error === "object"
      ? JSON.stringify({ error: payload.error }, null, 2)
      : undefined;

  return new ResponsesWebSocketHttpError({
    status,
    message: `Responses WebSocket returned status ${status}.`,
    body,
    headers,
  });
}

function mapErrorHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      headers[key.toLowerCase()] = String(entry);
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function resolveNumericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function normalizeFinalResponse(
  eventType: string,
  eventResponse: unknown,
  latestResponse: Record<string, unknown> | null,
  responseHeaders: Record<string, string>,
): Record<string, unknown> {
  const response =
    eventResponse && typeof eventResponse === "object"
      ? ({ ...(eventResponse as Record<string, unknown>) } as Record<string, unknown>)
      : latestResponse
        ? { ...latestResponse }
        : {};

  if (typeof response.status !== "string") {
    if (eventType === "response.failed") {
      response.status = "failed";
    } else if (eventType === "response.done") {
      response.status = "completed";
    } else if (eventType === "response.completed") {
      response.status = "completed";
    }
  }

  const upgradeModel = responseHeaders["openai-model"];
  if (typeof response.model !== "string" && upgradeModel) {
    response.model = upgradeModel;
  }

  return response;
}

function serializeRequestPayload(request: unknown): string {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Responses WebSocket request must be a JSON object.");
  }
  const body = request as Record<string, unknown>;
  const payload = typeof body.type === "string" ? body : { type: "response.create", ...body };
  return JSON.stringify(payload);
}

function isObjectWithResponse(event: ResponsesStreamEvent): event is ResponsesStreamEvent & {
  response: Record<string, unknown>;
} {
  return Boolean(event.response && typeof event.response === "object");
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createAbortError(reason: unknown): Error {
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "Request aborted.",
  );
  error.name = "AbortError";
  return error;
}
