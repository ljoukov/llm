import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LlmStreamEvent } from "./llm.js";

export type AgentLogLineSink = {
  readonly append: (line: string) => void | Promise<void>;
  readonly flush?: () => void | Promise<void>;
};

export type AgentLoggingConfig = {
  readonly workspaceDir?: string;
  readonly callLogsDir?: string;
  readonly mirrorToConsole?: boolean;
  readonly sink?: AgentLogLineSink;
};

export type AgentLoggingSelection = boolean | AgentLoggingConfig;

export type AgentLlmCallAttachment = {
  readonly filename: string;
  readonly bytes: Buffer;
};

export type AgentLlmCallStartInput = {
  readonly provider: string;
  readonly modelId: string;
  readonly requestText: string;
  readonly requestMetadata?: Record<string, unknown>;
  readonly attachments?: readonly AgentLlmCallAttachment[];
};

export type AgentLlmCallLogger = {
  readonly appendThoughtDelta: (text: string) => void;
  readonly appendResponseDelta: (text: string) => void;
  readonly complete: (metadata?: Record<string, unknown>) => void;
  readonly fail: (error: unknown, metadata?: Record<string, unknown>) => void;
};

export type AgentLoggingSession = {
  readonly workspaceDir: string;
  readonly logsRootDir: string;
  readonly logLine: (line: string) => void;
  readonly startLlmCall: (input: AgentLlmCallStartInput) => AgentLlmCallLogger;
  readonly flush: () => Promise<void>;
};

function toIsoNow(): string {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalisePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "segment";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function redactDataUrlPayload(value: string): string {
  if (!value.toLowerCase().startsWith("data:")) {
    return value;
  }
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return value;
  }
  return `${value.slice(0, commaIndex + 1)}...`;
}

export function sanitiseLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactDataUrlPayload(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitiseLogValue(entry, seen));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const hasInlineMime =
    (typeof record.mimeType === "string" && record.mimeType.trim().length > 0) ||
    (typeof record.mime_type === "string" && record.mime_type.trim().length > 0);

  for (const [key, entryValue] of Object.entries(record)) {
    if (key === "image_url") {
      if (typeof entryValue === "string") {
        output[key] = redactDataUrlPayload(entryValue);
        continue;
      }
      if (entryValue && typeof entryValue === "object") {
        const nested = entryValue as Record<string, unknown>;
        if (typeof nested.url === "string") {
          output[key] = {
            ...nested,
            url: redactDataUrlPayload(nested.url),
          };
          continue;
        }
      }
    }
    if (key === "data" && hasInlineMime && typeof entryValue === "string") {
      output[key] = `[omitted:${Buffer.byteLength(entryValue, "utf8")}b]`;
      continue;
    }
    output[key] = sanitiseLogValue(entryValue, seen);
  }
  return output;
}

function serialiseForSnippet(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(sanitiseLogValue(value));
  } catch {
    return String(value);
  }
}

function formatToolLogSnippet(value: unknown): string {
  const compact = serialiseForSnippet(value).replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return "<empty>";
  }
  const max = 600;
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, max)}...`;
}

function formatUsd(value: number | undefined): string {
  const amount = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  return amount.toFixed(6);
}

export function appendToolCallStreamLog(options: {
  readonly event: LlmStreamEvent;
  readonly append: (line: string) => void;
}): void {
  const event = options.event;
  if (event.type !== "tool_call") {
    return;
  }
  const callIdSegment =
    typeof event.callId === "string" && event.callId.trim().length > 0
      ? ` callId=${event.callId}`
      : "";
  const prefix = [
    `tool_call_${event.phase}:`,
    `turn=${event.turn.toString()}`,
    `index=${event.toolIndex.toString()}`,
    `tool=${event.toolName}${callIdSegment}`,
  ].join(" ");

  if (event.phase === "started") {
    options.append(prefix);
    options.append(`tool_call_input: ${formatToolLogSnippet(sanitiseLogValue(event.input))}`);
    return;
  }

  const durationSegment =
    typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
      ? ` durationMs=${Math.max(0, Math.round(event.durationMs)).toString()}`
      : "";
  options.append(`${prefix} status=${event.error ? "error" : "ok"}${durationSegment}`);
  options.append(`tool_call_output: ${formatToolLogSnippet(sanitiseLogValue(event.output))}`);
  if (typeof event.error === "string" && event.error.trim().length > 0) {
    options.append(`tool_call_error: ${event.error.trim()}`);
  }
}

export function appendAgentStreamEventLog(options: {
  readonly event: LlmStreamEvent;
  readonly append: (line: string) => void;
}): void {
  const event = options.event;
  switch (event.type) {
    case "delta": {
      const channelPrefix = event.channel === "thought" ? "thought_delta" : "response_delta";
      options.append(`${channelPrefix}: ${event.text}`);
      return;
    }
    case "model": {
      options.append(`model: ${event.modelVersion}`);
      return;
    }
    case "usage": {
      options.append(
        [
          "usage:",
          `modelVersion=${event.modelVersion}`,
          `costUsd=${formatUsd(event.costUsd)}`,
          `tokens=${formatToolLogSnippet(sanitiseLogValue(event.usage))}`,
        ].join(" "),
      );
      return;
    }
    case "blocked": {
      options.append("blocked");
      return;
    }
    case "tool_call": {
      appendToolCallStreamLog({
        event,
        append: options.append,
      });
      return;
    }
  }
}

class AgentLoggingSessionImpl implements AgentLoggingSession {
  readonly workspaceDir: string;
  readonly logsRootDir: string;
  private readonly mirrorToConsole: boolean;
  private readonly sink: AgentLogLineSink | undefined;
  private readonly agentLogPath: string;
  private readonly ensureReady: Promise<void>;
  private readonly pending = new Set<Promise<void>>();
  private lineChain: Promise<void> = Promise.resolve();
  private callCounter = 0;

  constructor(config: AgentLoggingConfig) {
    this.workspaceDir = path.resolve(config.workspaceDir ?? process.cwd());
    const configuredCallLogsDir =
      typeof config.callLogsDir === "string" ? config.callLogsDir.trim() : "";
    this.logsRootDir =
      configuredCallLogsDir.length > 0
        ? path.resolve(this.workspaceDir, configuredCallLogsDir)
        : path.join(this.workspaceDir, "llm_calls");
    this.mirrorToConsole = config.mirrorToConsole !== false;
    this.sink = config.sink;
    this.agentLogPath = path.join(this.workspaceDir, "agent.log");
    this.ensureReady = this.prepare();
    this.track(this.ensureReady);
  }

  private async prepare(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(this.logsRootDir, { recursive: true });
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    task.finally(() => {
      this.pending.delete(task);
    });
  }

  private enqueueLineWrite(line: string): void {
    const next = this.lineChain.then(async () => {
      await this.ensureReady;
      await appendFile(this.agentLogPath, `${line}\n`, "utf8");
      const sinkResult = this.sink?.append(line);
      if (isPromiseLike(sinkResult)) {
        await sinkResult;
      }
    });
    const tracked = next.catch(() => undefined);
    this.lineChain = tracked;
    this.track(tracked);
  }

  logLine(line: string): void {
    const timestamped = `${toIsoNow()} ${line}`;
    if (this.mirrorToConsole) {
      console.log(timestamped);
    }
    this.enqueueLineWrite(timestamped);
  }

  startLlmCall(input: AgentLlmCallStartInput): AgentLlmCallLogger {
    const callNumber = this.callCounter + 1;
    this.callCounter = callNumber;
    const timestampSegment = toIsoNow().replace(/[:]/g, "-");
    const modelSegment = normalisePathSegment(input.modelId);
    const baseDir = path.join(
      this.logsRootDir,
      `${timestampSegment}-${callNumber.toString().padStart(4, "0")}`,
      modelSegment,
    );

    const responsePath = path.join(baseDir, "response.txt");
    const thoughtsPath = path.join(baseDir, "thoughts.txt");
    const responseMetadataPath = path.join(baseDir, "response.metadata.json");

    let chain: Promise<void> = this.ensureReady
      .then(async () => {
        await mkdir(baseDir, { recursive: true });
        const requestText =
          input.requestText.trim().length > 0 ? input.requestText : "<empty request>";
        await writeFile(
          path.join(baseDir, "request.txt"),
          ensureTrailingNewline(requestText),
          "utf8",
        );

        const requestMetadata = {
          capturedAt: toIsoNow(),
          provider: input.provider,
          modelId: input.modelId,
          ...(input.requestMetadata ? { request: sanitiseLogValue(input.requestMetadata) } : {}),
        };
        await writeFile(
          path.join(baseDir, "request.metadata.json"),
          `${JSON.stringify(requestMetadata, null, 2)}\n`,
          "utf8",
        );

        const usedNames = new Set<string>();
        for (const attachment of input.attachments ?? []) {
          let filename = normalisePathSegment(attachment.filename);
          if (!filename.includes(".")) {
            filename = `${filename}.bin`;
          }
          const ext = path.extname(filename);
          const base = ext.length > 0 ? filename.slice(0, -ext.length) : filename;
          let candidate = filename;
          let duplicateIndex = 2;
          while (usedNames.has(candidate)) {
            candidate = `${base}-${duplicateIndex.toString()}${ext}`;
            duplicateIndex += 1;
          }
          usedNames.add(candidate);
          await writeFile(path.join(baseDir, candidate), attachment.bytes);
        }
      })
      .catch(() => undefined);
    this.track(chain);

    let closed = false;

    const enqueue = (operation: () => Promise<void>): void => {
      const next = chain.then(operation);
      const tracked = next.catch(() => undefined);
      chain = tracked;
      this.track(tracked);
    };

    return {
      appendThoughtDelta: (text: string) => {
        if (closed || text.length === 0) {
          return;
        }
        enqueue(async () => {
          await appendFile(thoughtsPath, text, "utf8");
        });
      },
      appendResponseDelta: (text: string) => {
        if (closed || text.length === 0) {
          return;
        }
        enqueue(async () => {
          await appendFile(responsePath, text, "utf8");
        });
      },
      complete: (metadata?: Record<string, unknown>) => {
        if (closed) {
          return;
        }
        closed = true;
        enqueue(async () => {
          const payload: Record<string, unknown> = {
            capturedAt: toIsoNow(),
            status: "completed",
          };
          if (metadata) {
            const sanitised = sanitiseLogValue(metadata);
            if (sanitised && typeof sanitised === "object" && !Array.isArray(sanitised)) {
              Object.assign(payload, sanitised as Record<string, unknown>);
            } else if (sanitised !== undefined) {
              payload.metadata = sanitised;
            }
          }
          await writeFile(responseMetadataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        });
      },
      fail: (error: unknown, metadata?: Record<string, unknown>) => {
        if (closed) {
          return;
        }
        closed = true;
        enqueue(async () => {
          const payload: Record<string, unknown> = {
            capturedAt: toIsoNow(),
            status: "failed",
            error: toErrorMessage(error),
          };
          if (metadata) {
            const sanitised = sanitiseLogValue(metadata);
            if (sanitised && typeof sanitised === "object" && !Array.isArray(sanitised)) {
              Object.assign(payload, sanitised as Record<string, unknown>);
            } else if (sanitised !== undefined) {
              payload.metadata = sanitised;
            }
          }
          await writeFile(responseMetadataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        });
      },
    };
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    if (typeof this.sink?.flush === "function") {
      try {
        await this.sink.flush();
      } catch {
        // Sink flush failures must not break agent execution.
      }
    }
  }
}

const loggingSessionStorage = new AsyncLocalStorage<AgentLoggingSession>();

export function createAgentLoggingSession(config: AgentLoggingConfig): AgentLoggingSession {
  return new AgentLoggingSessionImpl(config);
}

export function runWithAgentLoggingSession<T>(
  session: AgentLoggingSession | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!session) {
    return fn();
  }
  return loggingSessionStorage.run(session, fn);
}

export function getCurrentAgentLoggingSession(): AgentLoggingSession | undefined {
  return loggingSessionStorage.getStore();
}
