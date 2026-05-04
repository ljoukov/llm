import { getRuntimeSingleton } from "./utils/runtimeSingleton.js";
import type { LlmUsageTokens } from "./utils/cost.js";
import type { LlmModelId, LlmProvider, LlmStreamEvent } from "./llm.js";

export type LlmTelemetryOperation =
  | "generateText"
  | "streamText"
  | "generateJson"
  | "streamJson"
  | "generateImages";

type LlmTelemetryBaseEvent = {
  readonly timestamp: string;
  readonly callId: string;
  readonly operation: LlmTelemetryOperation;
  readonly provider: LlmProvider;
  readonly model: LlmModelId;
};

export type LlmCallStartedTelemetryEvent = LlmTelemetryBaseEvent & {
  readonly type: "llm.call.started";
  readonly inputMode?: "string" | "messages";
  readonly toolCount?: number;
  readonly responseModalities?: readonly string[];
  readonly imagePromptCount?: number;
  readonly styleImageCount?: number;
  readonly numImagesPerPrompt?: number;
  readonly maxAttempts?: number;
  readonly streamMode?: "partial" | "final";
};

export type LlmCallStreamTelemetryEvent = LlmTelemetryBaseEvent & {
  readonly type: "llm.call.stream";
  readonly event: LlmStreamEvent;
};

export type LlmCallCompletedTelemetryEvent = LlmTelemetryBaseEvent & {
  readonly type: "llm.call.completed";
  readonly success: boolean;
  readonly durationMs: number;
  readonly modelVersion?: string;
  readonly blocked?: boolean;
  readonly usage?: LlmUsageTokens;
  readonly costUsd?: number;
  readonly outputTextChars?: number;
  readonly thoughtChars?: number;
  readonly responseImages?: number;
  readonly rawTextChars?: number;
  readonly imageCount?: number;
  readonly attempts?: number;
  readonly uploadCount?: number;
  readonly uploadBytes?: number;
  readonly uploadLatencyMs?: number;
  readonly error?: string;
};

type AgentTelemetryBaseEvent = {
  readonly timestamp: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly model: LlmModelId;
};

export type AgentRunStartedTelemetryEvent = AgentTelemetryBaseEvent & {
  readonly type: "agent.run.started";
  readonly inputMode: "string" | "messages";
  readonly customToolCount: number;
  readonly mergedToolCount: number;
  readonly filesystemToolsEnabled: boolean;
  readonly subagentToolsEnabled: boolean;
};

export type AgentRunStreamTelemetryEvent = AgentTelemetryBaseEvent & {
  readonly type: "agent.run.stream";
  readonly event: LlmStreamEvent;
};

export type AgentRunCompletedTelemetryEvent = AgentTelemetryBaseEvent & {
  readonly type: "agent.run.completed";
  readonly success: boolean;
  readonly durationMs: number;
  readonly stepCount?: number;
  readonly toolCallCount?: number;
  readonly totalCostUsd?: number;
  readonly usage?: LlmUsageTokens;
  readonly uploadCount?: number;
  readonly uploadBytes?: number;
  readonly uploadLatencyMs?: number;
  readonly error?: string;
};

export type TelemetryEvent =
  | LlmCallStartedTelemetryEvent
  | LlmCallStreamTelemetryEvent
  | LlmCallCompletedTelemetryEvent
  | AgentRunStartedTelemetryEvent
  | AgentRunStreamTelemetryEvent
  | AgentRunCompletedTelemetryEvent;

export type TelemetrySink = {
  readonly emit: (event: TelemetryEvent) => void | Promise<void>;
  readonly flush?: () => void | Promise<void>;
};

export type TelemetryConfig = {
  readonly sink: TelemetrySink;
  readonly includeStreamEvents?: boolean;
};

export type TelemetrySelection = false | TelemetryConfig;

export type TelemetrySession = {
  readonly includeStreamEvents: boolean;
  readonly emit: (event: TelemetryEvent) => void;
  readonly flush: () => Promise<void>;
};

type ConfiguredTelemetryState = {
  configuredTelemetry: TelemetryConfig | undefined;
};

const telemetryState = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.telemetryState"),
  (): ConfiguredTelemetryState => ({
    configuredTelemetry: undefined,
  }),
);

export function configureTelemetry(telemetry: TelemetrySelection | undefined = undefined): void {
  telemetryState.configuredTelemetry =
    telemetry === undefined || telemetry === false ? undefined : telemetry;
}

export function resetTelemetry(): void {
  telemetryState.configuredTelemetry = undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function resolveTelemetrySelection(
  telemetry: TelemetrySelection | undefined,
): TelemetryConfig | undefined {
  if (telemetry === false) {
    return undefined;
  }
  if (telemetry !== undefined) {
    return telemetry;
  }
  return telemetryState.configuredTelemetry;
}

export function createTelemetrySession(
  telemetry: TelemetrySelection | undefined,
): TelemetrySession | undefined {
  const config = resolveTelemetrySelection(telemetry);
  if (!config) {
    return undefined;
  }

  const pending = new Set<Promise<void>>();
  const trackPromise = (promise: Promise<void>): void => {
    pending.add(promise);
    promise.finally(() => {
      pending.delete(promise);
    });
  };
  const emit = (event: TelemetryEvent): void => {
    try {
      const output = config.sink.emit(event);
      if (isPromiseLike(output)) {
        const task = Promise.resolve(output)
          .then(() => undefined)
          .catch(() => undefined);
        trackPromise(task);
      }
    } catch {
      // Telemetry failures must never break library execution.
    }
  };
  const flush = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    if (typeof config.sink.flush === "function") {
      try {
        await config.sink.flush();
      } catch {
        // Telemetry failures must never break library execution.
      }
    }
  };

  return {
    includeStreamEvents: config.includeStreamEvents === true,
    emit,
    flush,
  };
}
