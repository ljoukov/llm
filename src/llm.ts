import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  FinishReason,
  FunctionCallingConfigMode,
  MediaResolution,
  PartMediaResolutionLevel,
  ThinkingLevel,
  createPartFromBase64,
  createPartFromFunctionResponse,
  createPartFromUri,
  type Content as GeminiContent,
  type GenerateContentConfig,
  type GroundingMetadata,
  type Part as GeminiPart,
  type Tool as GeminiTool,
} from "@google/genai";
import { zodToJsonSchema } from "@alcyone-labs/zod-to-json-schema";
import { z } from "zod";
import { toFile } from "openai";
import type { ResponseTextConfig } from "openai/resources/responses/responses";

import { createAsyncQueue, type AsyncQueue } from "./utils/asyncQueue.js";
import { estimateCallCostUsd, type LlmUsageTokens } from "./utils/cost.js";
import type { CallSchedulerRunMetrics } from "./utils/scheduler.js";
import {
  collectChatGptCodexResponse,
  type ChatGptInputItem,
  type ChatGptInputMessagePart,
} from "./openai/chatgpt-codex.js";
import { runFireworksCall } from "./fireworks/calls.js";
import {
  FIREWORKS_MODEL_IDS,
  isFireworksModelId,
  resolveFireworksModelId,
} from "./fireworks/models.js";
import { runGeminiCall } from "./google/calls.js";
import {
  GEMINI_IMAGE_MODEL_IDS,
  GEMINI_TEXT_MODEL_IDS,
  getGeminiBackend,
  isGeminiImageModelId,
  isGeminiTextModelId,
  type GeminiImageModelId,
} from "./google/client.js";
import {
  runOpenAiCall,
  type OpenAiReasoningEffort,
  DEFAULT_OPENAI_REASONING_EFFORT,
} from "./openai/calls.js";
import {
  CHATGPT_MODEL_IDS,
  OPENAI_IMAGE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  isOpenAiImageModelId,
  isChatGptModelId,
  isExperimentalChatGptModelId,
  isOpenAiModelId,
  resolveChatGptProviderModel,
  resolveChatGptServiceTier,
  resolveOpenAiProviderModel,
  resolveOpenAiServiceTier,
  validateOpenAiGptImage2Resolution,
  type ExperimentalChatGptModelId,
  type OpenAiImageModelId,
  type OpenAiGptImage2Background,
  type OpenAiGptImage2Moderation,
  type OpenAiGptImage2NumImages,
  type OpenAiGptImage2OutputFormat,
  type OpenAiGptImage2PartialImageCount,
  type OpenAiGptImage2Quality,
  type OpenAiGptImage2Resolution,
} from "./openai/models.js";
import {
  getCurrentAgentLoggingSession,
  sanitiseLogValue,
  type AgentLlmCallAttachment,
  type AgentLlmCallLogger,
} from "./agentLogging.js";
import {
  collectFileUploadMetrics,
  DEFAULT_FILE_TTL_SECONDS,
  emptyFileUploadMetrics,
  ensureGeminiFileMirror,
  ensureVertexFileMirror,
  getCurrentFileUploadMetrics,
  filesCreate,
  getCanonicalFileMetadata,
  getCanonicalFileSignedUrl,
  runWithFileUploadSource,
} from "./files.js";
import {
  createTelemetrySession,
  type LlmCallCompletedTelemetryEvent,
  type LlmCallStartedTelemetryEvent,
  type LlmCallStreamTelemetryEvent,
  type LlmTelemetryOperation,
  type TelemetrySelection,
} from "./telemetry.js";
import { getRuntimeSingleton } from "./utils/runtimeSingleton.js";

export type { LlmUsageTokens } from "./utils/cost.js";
export { estimateCallCostUsd } from "./utils/cost.js";

type CollectChatGptCodexResponseOptions = Parameters<typeof collectChatGptCodexResponse>[0];
type CollectChatGptCodexResponseResult = Awaited<ReturnType<typeof collectChatGptCodexResponse>>;

export type LlmToolCallContext = {
  readonly toolName: string;
  readonly toolId: string;
  readonly turn: number;
  readonly toolIndex: number;
};

const toolCallContextStorage = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.toolCallContextStorage"),
  () => new AsyncLocalStorage<LlmToolCallContext>(),
);

export function getCurrentToolCallContext(): LlmToolCallContext | null {
  return toolCallContextStorage.getStore() ?? null;
}

export type JsonSchema = Record<string, unknown>;

export type LlmRole = "user" | "assistant" | "system" | "developer" | "tool";

type LlmInlineDataPart = {
  type: "inlineData";
  data: string;
  mimeType?: string;
  filename?: string;
};

export type LlmMediaResolution = "auto" | "low" | "medium" | "high" | "original";

export type LlmInputImagePart = {
  type: "input_image";
  image_url?: string | null;
  file_id?: string | null;
  detail?: LlmMediaResolution;
  filename?: string | null;
};

export type LlmInputFilePart = {
  type: "input_file";
  file_data?: string | null;
  file_id?: string | null;
  file_url?: string | null;
  filename?: string | null;
};

export type LlmContentPart =
  | { type: "text"; text: string; thought?: boolean }
  | LlmInlineDataPart
  | LlmInputImagePart
  | LlmInputFilePart;

export type LlmContent = {
  readonly role: LlmRole;
  readonly parts: readonly LlmContentPart[];
};

const INLINE_ATTACHMENT_FILENAME_SYMBOL = Symbol.for("@ljoukov/llm.inlineAttachmentFilename");
const INLINE_ATTACHMENT_PROMPT_THRESHOLD_BYTES = 20 * 1024 * 1024;
const TOOL_OUTPUT_SPILL_THRESHOLD_BYTES = 1 * 1024 * 1024;

type InternalFilenameCarrier = {
  [INLINE_ATTACHMENT_FILENAME_SYMBOL]?: string;
};

export type LlmToolOutputContentItem =
  | {
      readonly type: "input_text";
      readonly text: string;
    }
  | LlmInputImagePart
  | LlmInputFilePart;

export type LlmImageSize = "1K" | "2K" | "4K";
export type LlmThinkingLevel = "low" | "medium" | "high";

export type LlmWebSearchMode = "cached" | "live";

export type LlmOpenAiShellNetworkPolicy =
  | { readonly type: "disabled" }
  | {
      readonly type: "allowlist";
      readonly allowedDomains: readonly string[];
      readonly domainSecrets?: readonly {
        readonly domain: string;
        readonly name: string;
        readonly value: string;
      }[];
    };

export type LlmOpenAiShellEnvironment =
  | {
      readonly type?: "container-auto";
      readonly fileIds?: readonly string[];
      readonly memoryLimit?: "1g" | "4g" | "16g" | "64g" | null;
      readonly networkPolicy?: LlmOpenAiShellNetworkPolicy;
    }
  | {
      readonly type: "container-reference";
      readonly containerId: string;
    };

export type LlmToolConfig =
  | { readonly type: "web-search"; readonly mode?: LlmWebSearchMode }
  | { readonly type: "code-execution" }
  | {
      /**
       * OpenAI hosted shell tool. Runs commands in an OpenAI-managed container,
       * not on the caller's local machine.
       */
      readonly type: "shell";
      readonly environment?: LlmOpenAiShellEnvironment;
    };

export type LlmTextDeltaEvent =
  | { readonly type: "delta"; readonly channel: "response"; readonly text: string }
  | { readonly type: "delta"; readonly channel: "thought"; readonly text: string };

export type LlmUsageEvent = {
  readonly type: "usage";
  readonly usage: LlmUsageTokens;
  readonly costUsd: number;
  readonly modelVersion: string;
};

export type LlmModelEvent = {
  readonly type: "model";
  readonly modelVersion: string;
};

export type LlmBlockedEvent = {
  readonly type: "blocked";
};

export type LlmToolCallStartedEvent = {
  readonly type: "tool_call";
  readonly phase: "started";
  readonly turn: number;
  readonly toolIndex: number;
  readonly toolName: string;
  readonly toolId: string;
  readonly callKind: "function" | "custom";
  readonly callId?: string;
  readonly input: unknown;
};

export type LlmToolCallCompletedEvent = {
  readonly type: "tool_call";
  readonly phase: "completed";
  readonly turn: number;
  readonly toolIndex: number;
  readonly toolName: string;
  readonly toolId: string;
  readonly callKind: "function" | "custom";
  readonly callId?: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs?: number;
};

export type LlmToolCallStreamEvent = LlmToolCallStartedEvent | LlmToolCallCompletedEvent;

export type LlmStreamEvent =
  | LlmTextDeltaEvent
  | LlmUsageEvent
  | LlmModelEvent
  | LlmBlockedEvent
  | LlmToolCallStreamEvent;

export type LlmProvider = "openai" | "chatgpt" | "gemini" | "fireworks";
export const LLM_TEXT_MODEL_IDS = [
  ...OPENAI_MODEL_IDS,
  ...CHATGPT_MODEL_IDS,
  ...FIREWORKS_MODEL_IDS,
  ...GEMINI_TEXT_MODEL_IDS,
] as const;
export type LlmTextModelId = (typeof LLM_TEXT_MODEL_IDS)[number] | ExperimentalChatGptModelId;

export const LLM_IMAGE_MODEL_IDS = [...OPENAI_IMAGE_MODEL_IDS, ...GEMINI_IMAGE_MODEL_IDS] as const;
export type LlmImageModelId = (typeof LLM_IMAGE_MODEL_IDS)[number];

export const LLM_MODEL_IDS = [...LLM_TEXT_MODEL_IDS, ...LLM_IMAGE_MODEL_IDS] as const;
export type LlmModelId = LlmTextModelId | LlmImageModelId;

export function isLlmTextModelId(value: string): value is LlmTextModelId {
  return (
    isOpenAiModelId(value) ||
    isChatGptModelId(value) ||
    isFireworksModelId(value) ||
    isGeminiTextModelId(value)
  );
}

export function isLlmImageModelId(value: string): value is LlmImageModelId {
  return isOpenAiImageModelId(value) || isGeminiImageModelId(value);
}

export function isLlmModelId(value: string): value is LlmModelId {
  return isLlmTextModelId(value) || isLlmImageModelId(value);
}

export type LlmTextResult = {
  readonly provider: LlmProvider;
  readonly model: LlmModelId;
  readonly modelVersion: string;
  readonly content?: LlmContent;
  readonly text: string;
  readonly thoughts: string;
  readonly blocked: boolean;
  readonly usage?: LlmUsageTokens;
  readonly costUsd: number;
  readonly grounding?: GroundingMetadata;
};

export type LlmTextStream = {
  readonly events: AsyncIterable<LlmStreamEvent>;
  readonly result: Promise<LlmTextResult>;
  readonly abort: () => void;
};

export type DeepPartial<T> =
  T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<DeepPartial<Item>>
    : T extends Array<infer Item>
      ? Array<DeepPartial<Item>>
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T;

export type LlmJsonPartialEvent<T> = {
  readonly type: "json";
  readonly stage: "partial";
  readonly value: DeepPartial<T>;
};

export type LlmJsonFinalEvent<T> = {
  readonly type: "json";
  readonly stage: "final";
  readonly value: T;
};

export type LlmJsonStreamEvent<T> = LlmStreamEvent | LlmJsonPartialEvent<T> | LlmJsonFinalEvent<T>;

export type LlmJsonStream<T> = {
  readonly events: AsyncIterable<LlmJsonStreamEvent<T>>;
  readonly result: Promise<{
    readonly value: T;
    readonly rawText: string;
    readonly result: LlmTextResult;
  }>;
  readonly abort: () => void;
};

export type LlmInputMessage = {
  readonly role: "user" | "assistant" | "system" | "developer";
  readonly content: string | readonly LlmContentPart[];
};

export type LlmInput = {
  /**
   * OpenAI-style input:
   * - a plain string becomes one user message
   * - message arrays allow multi-turn + role-specific content
   */
  readonly input: string | readonly LlmInputMessage[];
  /**
   * OpenAI-style top-level instructions.
   * Applied as a system message before input.
   */
  readonly instructions?: string;
};

export type LlmBaseRequest = {
  readonly model: LlmModelId;
  readonly tools?: readonly LlmToolConfig[];
  readonly responseMimeType?: string;
  readonly responseJsonSchema?: JsonSchema;
  readonly responseModalities?: readonly string[];
  readonly imageAspectRatio?: string;
  readonly imageSize?: LlmImageSize;
  readonly thinkingLevel?: LlmThinkingLevel;
  readonly mediaResolution?: LlmMediaResolution;
  readonly openAiTextFormat?: ResponseTextConfig["format"];
  readonly telemetry?: TelemetrySelection;
  readonly signal?: AbortSignal;
};

export type LlmTextRequest = LlmInput & LlmBaseRequest;

type LlmStructuredRequestBase = Omit<LlmBaseRequest, "model"> & {
  readonly model: LlmTextModelId;
};

export type LlmJsonRequest<T> = LlmInput &
  LlmStructuredRequestBase & {
    readonly schema: z.ZodType<T>;
    readonly openAiSchemaName?: string;
    readonly maxAttempts?: number;
    readonly normalizeJson?: (value: unknown) => unknown;
    /**
     * Optional streaming callback. Useful to surface thought deltas while still
     * returning a single validated JSON result.
     */
    readonly onEvent?: (event: LlmStreamEvent) => void;
  };

export type LlmJsonStreamRequest<T> = LlmJsonRequest<T> & {
  /**
   * - "partial" (default): emit best-effort partial JSON snapshots while streaming.
   * - "final": stream thought deltas but only emit the final validated JSON value.
   */
  readonly streamMode?: "partial" | "final";
};

export class LlmJsonCallError extends Error {
  constructor(
    message: string,
    readonly attempts: ReadonlyArray<{
      readonly attempt: number;
      readonly rawText: string;
      readonly error: unknown;
    }>,
  ) {
    super(message);
    this.name = "LlmJsonCallError";
  }
}

export type LlmImageData = {
  readonly mimeType?: string;
  readonly data: Buffer;
};

export type LlmOpenAiImageResolution = OpenAiGptImage2Resolution;
export type LlmOpenAiImageQuality = OpenAiGptImage2Quality;
export type LlmOpenAiImageOutputFormat = OpenAiGptImage2OutputFormat;
export type LlmOpenAiImageBackground = OpenAiGptImage2Background;
export type LlmOpenAiImageModeration = OpenAiGptImage2Moderation;
export type LlmOpenAiImagePartialImageCount = OpenAiGptImage2PartialImageCount;
export type LlmOpenAiImageNumImages = OpenAiGptImage2NumImages;

type LlmGenerateImagesRequestBase = {
  readonly stylePrompt: string;
  readonly styleImages?: readonly LlmImageData[];
  readonly imagePrompts: readonly string[];
  readonly telemetry?: TelemetrySelection;
  readonly signal?: AbortSignal;
};

export type LlmOpenAiGenerateImagesRequest = LlmGenerateImagesRequestBase & {
  readonly model: OpenAiImageModelId;
  readonly imageResolution?: LlmOpenAiImageResolution;
  readonly imageQuality?: LlmOpenAiImageQuality;
  readonly outputFormat?: LlmOpenAiImageOutputFormat;
  readonly outputCompression?: number;
  readonly background?: LlmOpenAiImageBackground;
  readonly moderation?: LlmOpenAiImageModeration;
  readonly partialImages?: LlmOpenAiImagePartialImageCount;
  readonly numImages?: LlmOpenAiImageNumImages;
};

export type LlmGeminiGenerateImagesRequest = LlmGenerateImagesRequestBase & {
  readonly model: GeminiImageModelId;
  readonly imageGradingPrompt: string;
  readonly maxAttempts?: number;
  readonly imageAspectRatio?: string;
  readonly imageSize?: LlmImageSize;
};

export type LlmGenerateImagesRequest =
  | LlmOpenAiGenerateImagesRequest
  | LlmGeminiGenerateImagesRequest;

function isOpenAiGenerateImagesRequest(
  request: LlmGenerateImagesRequest,
): request is LlmOpenAiGenerateImagesRequest {
  return isOpenAiImageModelId(request.model);
}

export type LlmFunctionTool<Schema extends z.ZodType, Output> = {
  readonly type?: "function";
  readonly description?: string;
  readonly inputSchema: Schema;
  readonly terminal?: boolean;
  readonly execute: (input: z.output<Schema>) => Promise<Output> | Output;
};

export type LlmCustomToolInputFormat =
  | { readonly type: "text" }
  | {
      readonly type: "grammar";
      readonly syntax: "lark" | "regex";
      readonly definition: string;
    };

export type LlmCustomTool<Output> = {
  readonly type: "custom";
  readonly description?: string;
  readonly format?: LlmCustomToolInputFormat;
  readonly terminal?: boolean;
  readonly execute: (input: string) => Promise<Output> | Output;
};

export type LlmExecutableTool<Schema extends z.ZodType, Output> =
  | LlmFunctionTool<Schema, Output>
  | LlmCustomTool<Output>;

export type LlmToolSet = Record<string, LlmExecutableTool<z.ZodType, unknown>>;

export function tool<Schema extends z.ZodType, Output>(options: {
  readonly description?: string;
  readonly inputSchema: Schema;
  readonly terminal?: boolean;
  readonly execute: (input: z.output<Schema>) => Promise<Output> | Output;
}): LlmFunctionTool<Schema, Output> {
  return {
    type: "function",
    ...options,
  };
}

export function customTool<Output>(options: {
  readonly description?: string;
  readonly format?: LlmCustomToolInputFormat;
  readonly terminal?: boolean;
  readonly execute: (input: string) => Promise<Output> | Output;
}): LlmCustomTool<Output> {
  return {
    type: "custom",
    ...options,
  };
}

export type LlmToolCallResult = {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error?: string;
  readonly callId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly metrics?: Record<string, unknown>;
};

export type LlmToolLoopStepTiming = {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly totalMs: number;
  readonly queueWaitMs: number;
  readonly connectionSetupMs: number;
  readonly activeGenerationMs: number;
  readonly toolExecutionMs: number;
  readonly waitToolMs: number;
  readonly schedulerDelayMs: number;
  readonly providerRetryDelayMs: number;
  readonly providerAttempts: number;
};

export type LlmToolLoopStep = {
  readonly step: number;
  readonly modelVersion: string;
  readonly text?: string;
  readonly thoughts?: string;
  readonly toolCalls: readonly LlmToolCallResult[];
  readonly usage?: LlmUsageTokens;
  readonly costUsd: number;
  readonly timing?: LlmToolLoopStepTiming;
};

export type LlmToolLoopResult = {
  readonly text: string;
  readonly thoughts: string;
  readonly steps: readonly LlmToolLoopStep[];
  readonly totalCostUsd: number;
};

export type LlmToolLoopSteeringMessage = {
  readonly role?: "user";
  readonly content: string | readonly LlmContentPart[];
};

export type LlmToolLoopSteeringInput =
  | string
  | LlmToolLoopSteeringMessage
  | readonly LlmToolLoopSteeringMessage[];

export type LlmToolLoopSteeringAppendResult = {
  readonly accepted: boolean;
  readonly queuedCount: number;
};

export type LlmToolLoopSteeringChannel = {
  readonly append: (input: LlmToolLoopSteeringInput) => LlmToolLoopSteeringAppendResult;
  readonly steer: (input: LlmToolLoopSteeringInput) => LlmToolLoopSteeringAppendResult;
  readonly pendingCount: () => number;
  readonly close: () => void;
};

export type LlmToolLoopRequest = LlmInput & {
  readonly model: LlmTextModelId;
  readonly tools: LlmToolSet;
  readonly modelTools?: readonly LlmToolConfig[];
  readonly maxSteps?: number;
  readonly thinkingLevel?: LlmThinkingLevel;
  readonly mediaResolution?: LlmMediaResolution;
  readonly steering?: LlmToolLoopSteeringChannel;
  readonly onEvent?: (event: LlmStreamEvent) => void;
  readonly signal?: AbortSignal;
};

export type LlmToolLoopStream = {
  readonly events: AsyncIterable<LlmStreamEvent>;
  readonly result: Promise<LlmToolLoopResult>;
  readonly append: (input: LlmToolLoopSteeringInput) => LlmToolLoopSteeringAppendResult;
  readonly steer: (input: LlmToolLoopSteeringInput) => LlmToolLoopSteeringAppendResult;
  readonly pendingSteeringCount: () => number;
  readonly abort: () => void;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyNullableJsonSchema(schema: Record<string, unknown>): void {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    if (!anyOf.some((entry) => isPlainRecord(entry) && entry.type === "null")) {
      anyOf.push({ type: "null" });
    }
    return;
  }
  const type = schema.type;
  if (typeof type === "string") {
    schema.type = type === "null" ? "null" : [type, "null"];
    return;
  }
  if (Array.isArray(type)) {
    const normalized = type.filter((entry): entry is string => typeof entry === "string");
    if (!normalized.includes("null")) {
      schema.type = [...normalized, "null"];
    } else {
      schema.type = normalized;
    }
    return;
  }
  schema.type = ["null"];
}

function orderedJsonSchemaKeys(
  properties: Record<string, unknown>,
  ordering: readonly string[] | undefined,
): string[] {
  const keys = Object.keys(properties);
  if (!ordering || ordering.length === 0) {
    return keys;
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of ordering) {
    if (Object.hasOwn(properties, key)) {
      ordered.push(key);
      seen.add(key);
    }
  }
  for (const key of keys) {
    if (!seen.has(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}

function addGeminiPropertyOrdering(schema: JsonSchema): JsonSchema {
  if (!isPlainRecord(schema)) {
    return schema;
  }
  if (typeof schema.$ref === "string") {
    return { $ref: schema.$ref };
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties") {
      continue;
    }
    if (key === "items") {
      output.items = isPlainRecord(value) ? addGeminiPropertyOrdering(value as JsonSchema) : value;
      continue;
    }
    if (key === "anyOf" || key === "oneOf") {
      output[key] = Array.isArray(value)
        ? value.map((entry) => addGeminiPropertyOrdering(entry as JsonSchema))
        : value;
      continue;
    }
    if (key === "$defs" && isPlainRecord(value)) {
      const defs: Record<string, unknown> = {};
      for (const [defKey, defValue] of Object.entries(value)) {
        if (isPlainRecord(defValue)) {
          defs[defKey] = addGeminiPropertyOrdering(defValue as JsonSchema);
        }
      }
      output.$defs = defs;
      continue;
    }
    output[key] = value;
  }
  const propertiesRaw = schema.properties;
  if (isPlainRecord(propertiesRaw)) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(propertiesRaw)) {
      properties[key] = isPlainRecord(value)
        ? addGeminiPropertyOrdering(value as JsonSchema)
        : value;
    }
    output.properties = properties;
    output.propertyOrdering = Object.keys(properties);
  }
  if ((schema as { nullable?: unknown }).nullable) {
    applyNullableJsonSchema(output);
  }
  return output;
}

function normalizeOpenAiSchema(schema: JsonSchema): JsonSchema {
  if (!isPlainRecord(schema)) {
    return schema;
  }
  if (typeof schema.$ref === "string") {
    return { $ref: schema.$ref };
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties") {
      continue;
    }
    if (key === "required") {
      continue;
    }
    if (key === "additionalProperties") {
      continue;
    }
    if (key === "propertyOrdering") {
      continue;
    }
    if (key === "items") {
      if (isPlainRecord(value)) {
        output.items = normalizeOpenAiSchema(value);
      }
      continue;
    }
    if (key === "anyOf" || key === "oneOf") {
      if (Array.isArray(value)) {
        output.anyOf = value.map((entry) => normalizeOpenAiSchema(entry as JsonSchema));
      }
      continue;
    }
    if (key === "$defs" && isPlainRecord(value)) {
      const defs: Record<string, unknown> = {};
      for (const [defKey, defValue] of Object.entries(value)) {
        if (isPlainRecord(defValue)) {
          defs[defKey] = normalizeOpenAiSchema(defValue);
        }
      }
      output.$defs = defs;
      continue;
    }
    output[key] = value;
  }

  const propertiesRaw = schema.properties;
  if (isPlainRecord(propertiesRaw)) {
    const ordering = Array.isArray((schema as { propertyOrdering?: unknown }).propertyOrdering)
      ? ((schema as { propertyOrdering?: unknown }).propertyOrdering as string[])
      : undefined;
    const orderedKeys = orderedJsonSchemaKeys(propertiesRaw, ordering);
    const properties: Record<string, unknown> = {};
    for (const key of orderedKeys) {
      const value = propertiesRaw[key];
      if (!isPlainRecord(value)) {
        properties[key] = value;
        continue;
      }
      properties[key] = normalizeOpenAiSchema(value as JsonSchema);
    }
    output.properties = properties;
    output.required = orderedKeys;
    output.additionalProperties = false;
  }

  const schemaType = (schema as { type?: unknown }).type;
  if (
    output.additionalProperties === undefined &&
    (schemaType === "object" || (Array.isArray(schemaType) && schemaType.includes("object")))
  ) {
    output.additionalProperties = false;
    if (!Array.isArray(output.required)) {
      output.required = [];
    }
  }

  const normalizeExclusiveBound = (options: {
    exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum";
    inclusiveKey: "minimum" | "maximum";
  }): void => {
    const exclusiveValue = output[options.exclusiveKey];
    if (exclusiveValue === false) {
      delete output[options.exclusiveKey];
      return;
    }
    const inclusiveValue = output[options.inclusiveKey];
    if (exclusiveValue === true) {
      if (typeof inclusiveValue === "number" && Number.isFinite(inclusiveValue)) {
        output[options.exclusiveKey] = inclusiveValue;
        delete output[options.inclusiveKey];
      } else {
        delete output[options.exclusiveKey];
      }
      return;
    }
    if (typeof exclusiveValue === "number" && Number.isFinite(exclusiveValue)) {
      delete output[options.inclusiveKey];
    }
  };

  normalizeExclusiveBound({
    exclusiveKey: "exclusiveMinimum",
    inclusiveKey: "minimum",
  });
  normalizeExclusiveBound({
    exclusiveKey: "exclusiveMaximum",
    inclusiveKey: "maximum",
  });

  return output;
}

function resolveOpenAiSchemaRoot(schema: JsonSchema): JsonSchema {
  if (!isPlainRecord(schema)) {
    return schema;
  }
  if (typeof schema.$ref !== "string") {
    return schema;
  }
  const refMatch = /^#\/(definitions|[$]defs)\/(.+)$/u.exec(schema.$ref);
  if (!refMatch) {
    return schema;
  }
  const section = refMatch[1];
  const key = refMatch[2];
  if (!section || !key) {
    return schema;
  }
  const defsSource =
    section === "definitions"
      ? (schema as { definitions?: unknown }).definitions
      : (schema as { $defs?: unknown }).$defs;
  if (!isPlainRecord(defsSource)) {
    return schema;
  }
  const resolved = defsSource[key];
  if (!isPlainRecord(resolved)) {
    return schema;
  }
  return { ...resolved };
}

export function toGeminiJsonSchema(schema: z.ZodType, options?: { name?: string }): JsonSchema {
  const jsonSchema = zodToJsonSchema(schema, {
    name: options?.name,
    target: "jsonSchema7",
  }) as JsonSchema;
  return addGeminiPropertyOrdering(resolveOpenAiSchemaRoot(jsonSchema));
}

function isJsonSchemaObject(schema: JsonSchema | undefined): boolean {
  if (!schema || !isPlainRecord(schema)) {
    return false;
  }
  const type = (schema as { type?: unknown }).type;
  if (type === "object") {
    return true;
  }
  if (Array.isArray(type) && type.includes("object")) {
    return true;
  }
  if (isPlainRecord((schema as { properties?: unknown }).properties)) {
    return true;
  }
  return false;
}

const CANONICAL_GEMINI_FILE_URI_PREFIX = "openai://file/";
const CANONICAL_LLM_FILE_ID_PATTERN = /^file_[a-f0-9]{64}$/u;

function buildCanonicalGeminiFileUri(fileId: string): string {
  return `${CANONICAL_GEMINI_FILE_URI_PREFIX}${fileId}`;
}

function parseCanonicalGeminiFileId(fileUri: string | undefined): string | undefined {
  if (!fileUri?.startsWith(CANONICAL_GEMINI_FILE_URI_PREFIX)) {
    return undefined;
  }
  const fileId = fileUri.slice(CANONICAL_GEMINI_FILE_URI_PREFIX.length).trim();
  return fileId.length > 0 ? fileId : undefined;
}

function isCanonicalLlmFileId(fileId: string | null | undefined): fileId is string {
  return typeof fileId === "string" && CANONICAL_LLM_FILE_ID_PATTERN.test(fileId.trim());
}

type OpenAiImageDetail = "auto" | "low" | "high" | "original";

function isLlmMediaResolution(value: unknown): value is LlmMediaResolution {
  return (
    value === "auto" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "original"
  );
}

function resolveEffectiveMediaResolution(
  detail: LlmMediaResolution | undefined,
  fallback: LlmMediaResolution | undefined,
): LlmMediaResolution | undefined {
  return detail ?? fallback;
}

function supportsOpenAiOriginalImageDetail(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const providerModel = isChatGptModelId(model) ? resolveChatGptProviderModel(model) : model;
  const match = /^gpt-(\d+)(?:\.(\d+))?/u.exec(providerModel);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? "0");
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }
  return major > 5 || (major === 5 && minor >= 4);
}

function toOpenAiImageDetail(
  mediaResolution: LlmMediaResolution | undefined,
  model: string | undefined,
): OpenAiImageDetail {
  switch (mediaResolution) {
    case "low":
      return "low";
    case "medium":
      return "high";
    case "high":
      return "high";
    case "original":
      return supportsOpenAiOriginalImageDetail(model) ? "original" : "high";
    case "auto":
    default:
      return "auto";
  }
}

function toGeminiMediaResolution(
  mediaResolution: LlmMediaResolution | undefined,
): MediaResolution | undefined {
  switch (mediaResolution) {
    case "low":
      return MediaResolution.MEDIA_RESOLUTION_LOW;
    case "medium":
      return MediaResolution.MEDIA_RESOLUTION_MEDIUM;
    case "high":
    case "original":
      return MediaResolution.MEDIA_RESOLUTION_HIGH;
    case "auto":
    default:
      return undefined;
  }
}

function toGeminiPartMediaResolution(
  mediaResolution: LlmMediaResolution | undefined,
): PartMediaResolutionLevel | undefined {
  switch (mediaResolution) {
    case "low":
      return PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW;
    case "medium":
      return PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM;
    case "high":
      return PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;
    case "original":
      return PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH;
    case "auto":
    default:
      return undefined;
  }
}

function cloneContentPart(part: LlmContentPart): LlmContentPart {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text,
        thought: part.thought === true ? true : undefined,
      };
    case "inlineData":
      return {
        type: "inlineData",
        data: part.data,
        mimeType: part.mimeType,
        filename: part.filename,
      };
    case "input_image":
      return {
        type: "input_image",
        image_url: part.image_url ?? undefined,
        file_id: part.file_id ?? undefined,
        detail: part.detail,
        filename: part.filename ?? undefined,
      };
    case "input_file":
      return {
        type: "input_file",
        file_data: part.file_data ?? undefined,
        file_id: part.file_id ?? undefined,
        file_url: part.file_url ?? undefined,
        filename: part.filename ?? undefined,
      };
    default:
      return part;
  }
}

export function sanitisePartForLogging(part: LlmContentPart): unknown {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        thought: part.thought === true ? true : undefined,
        preview: part.text.slice(0, 200),
      };
    case "inlineData": {
      let omittedBytes: number;
      try {
        omittedBytes = Buffer.from(part.data, "base64").byteLength;
      } catch {
        omittedBytes = Buffer.byteLength(part.data, "utf8");
      }
      return {
        type: "inlineData",
        mimeType: part.mimeType,
        filename: part.filename,
        data: `[omitted:${omittedBytes}b]`,
      };
    }
    case "input_image":
      return {
        type: "input_image",
        file_id: part.file_id ?? undefined,
        filename: part.filename ?? undefined,
        detail: part.detail ?? undefined,
        image_url:
          typeof part.image_url === "string"
            ? part.image_url.startsWith("data:")
              ? "[omitted:data-url]"
              : part.image_url
            : undefined,
      };
    case "input_file":
      return {
        type: "input_file",
        file_id: part.file_id ?? undefined,
        filename: part.filename ?? undefined,
        file_url:
          typeof part.file_url === "string"
            ? part.file_url.startsWith("data:")
              ? "[omitted:data-url]"
              : part.file_url
            : undefined,
        file_data:
          typeof part.file_data === "string"
            ? `[omitted:${Buffer.byteLength(part.file_data, "utf8")}b]`
            : undefined,
      };
    default:
      return "[unknown part]";
  }
}

export function convertGooglePartsToLlmParts(parts: readonly GeminiPart[]): LlmContentPart[] {
  const result: LlmContentPart[] = [];
  for (const part of parts) {
    if (part.text !== undefined) {
      result.push({
        type: "text",
        text: part.text,
        thought: part.thought ? true : undefined,
      });
      continue;
    }
    const inline = part.inlineData;
    if (inline?.data) {
      result.push({
        type: "inlineData",
        data: inline.data,
        mimeType: inline.mimeType,
        filename: inline.displayName,
      });
      continue;
    }
    if (part.fileData?.fileUri) {
      result.push({
        type: "input_file",
        file_url: part.fileData.fileUri,
        filename: part.fileData.displayName,
      });
    }
  }
  return result;
}

function assertLlmRole(value: string | undefined): LlmRole {
  switch (value) {
    case "user":
    case "assistant":
    case "system":
    case "developer":
    case "tool":
      return value;
    case "model":
      return "assistant";
    default:
      throw new Error(`Unsupported LLM role: ${String(value)}`);
  }
}

function convertGeminiContentToLlmContent(content: GeminiContent): LlmContent {
  return {
    role: assertLlmRole(content.role),
    parts: convertGooglePartsToLlmParts(content.parts ?? []),
  };
}

function toGeminiPart(
  part: LlmContentPart,
  options?: { defaultMediaResolution?: LlmMediaResolution },
): GeminiPart {
  const defaultMediaResolution = options?.defaultMediaResolution;
  switch (part.type) {
    case "text":
      return {
        text: part.text,
        thought: part.thought === true ? true : undefined,
      };
    case "inlineData": {
      if (isInlineImageMime(part.mimeType)) {
        const mimeType = part.mimeType ?? "application/octet-stream";
        const geminiPart = createPartFromBase64(
          part.data,
          mimeType,
          toGeminiPartMediaResolution(defaultMediaResolution),
        );
        if (part.filename && geminiPart.inlineData) {
          geminiPart.inlineData.displayName = part.filename;
        }
        return geminiPart;
      }
      const inlineData = {
        data: part.data,
        mimeType: part.mimeType,
      };
      setInlineAttachmentFilename(inlineData, part.filename);
      return {
        inlineData: {
          ...inlineData,
        },
      };
    }
    case "input_image": {
      const mediaResolution = resolveEffectiveMediaResolution(part.detail, defaultMediaResolution);
      const geminiPartMediaResolution = toGeminiPartMediaResolution(mediaResolution);
      if (part.file_id) {
        return createPartFromUri(
          buildCanonicalGeminiFileUri(part.file_id),
          inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream",
          geminiPartMediaResolution,
        );
      }
      if (typeof part.image_url !== "string" || part.image_url.trim().length === 0) {
        throw new Error("input_image requires image_url or file_id.");
      }
      const parsed = parseDataUrlPayload(part.image_url);
      if (parsed) {
        const geminiPart = createPartFromBase64(
          parsed.dataBase64,
          parsed.mimeType,
          geminiPartMediaResolution,
        );
        if (part.filename && geminiPart.inlineData) {
          geminiPart.inlineData.displayName = part.filename;
        }
        return geminiPart;
      }
      return createPartFromUri(
        part.image_url,
        inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream",
        geminiPartMediaResolution,
      );
    }
    case "input_file": {
      if (part.file_id) {
        return {
          fileData: {
            fileUri: buildCanonicalGeminiFileUri(part.file_id),
            mimeType:
              inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream",
          },
        };
      }
      if (typeof part.file_data === "string" && part.file_data.trim().length > 0) {
        const geminiPart = createPartFromBase64(
          part.file_data,
          inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream",
        );
        if (part.filename && geminiPart.inlineData) {
          geminiPart.inlineData.displayName = part.filename;
        }
        return geminiPart;
      }
      if (typeof part.file_url === "string" && part.file_url.trim().length > 0) {
        const parsed = parseDataUrlPayload(part.file_url);
        if (parsed) {
          const geminiPart = createPartFromBase64(parsed.dataBase64, parsed.mimeType);
          if (part.filename && geminiPart.inlineData) {
            geminiPart.inlineData.displayName = part.filename;
          }
          return geminiPart;
        }
        return {
          fileData: {
            fileUri: part.file_url,
            mimeType:
              inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream",
          },
        };
      }
      throw new Error("input_file requires file_id, file_data, or file_url.");
    }
    default:
      throw new Error("Unsupported LLM content part");
  }
}

function convertLlmContentToGeminiContent(
  content: LlmContent,
  options?: { defaultMediaResolution?: LlmMediaResolution },
): GeminiContent {
  const role = content.role === "assistant" ? "model" : "user";
  return {
    role,
    parts: content.parts.map((part) => toGeminiPart(part, options)),
  };
}

function resolveProvider(model: LlmModelId): {
  provider: LlmProvider;
  model: string;
  serviceTier?: "priority";
} {
  if (isChatGptModelId(model)) {
    return {
      provider: "chatgpt",
      model: resolveChatGptProviderModel(model),
      serviceTier: resolveChatGptServiceTier(model),
    };
  }
  if (isGeminiTextModelId(model) || isGeminiImageModelId(model)) {
    return { provider: "gemini", model };
  }
  if (isFireworksModelId(model)) {
    const fireworksModel = resolveFireworksModelId(model);
    if (fireworksModel) {
      return { provider: "fireworks", model: fireworksModel };
    }
  }
  if (isOpenAiImageModelId(model)) {
    return { provider: "openai", model };
  }
  if (isOpenAiModelId(model)) {
    return {
      provider: "openai",
      model: resolveOpenAiProviderModel(model),
      serviceTier: resolveOpenAiServiceTier(model),
    };
  }
  throw new Error(`Unsupported model: ${model}`);
}

function isOpenAiCodexModel(modelId: string): boolean {
  return modelId.includes("codex");
}

function resolveOpenAiReasoningEffort(
  modelId: string,
  thinkingLevel?: LlmThinkingLevel,
): OpenAiReasoningEffort {
  if (thinkingLevel) {
    switch (thinkingLevel) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "xhigh";
    }
  }
  if (isOpenAiCodexModel(modelId)) {
    return "medium";
  }
  return DEFAULT_OPENAI_REASONING_EFFORT;
}

type OpenAiReasoningEffortParam = "minimal" | "low" | "medium" | "high";

function toOpenAiReasoningEffort(effort: OpenAiReasoningEffort): OpenAiReasoningEffortParam {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "high";
  }
}

function resolveOpenAiVerbosity(modelId: string): "low" | "medium" | "high" {
  return isOpenAiCodexModel(modelId) ? "medium" : "high";
}

function isRetryableChatGptTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message === "terminated" ||
    message.includes("socket hang up") ||
    message.includes("fetch failed") ||
    message.includes("failed to download file from") ||
    message.includes("network") ||
    message.includes("responses websocket")
  );
}

async function collectChatGptCodexResponseWithRetry(
  options: CollectChatGptCodexResponseOptions,
  maxAttempts = 3,
): Promise<CollectChatGptCodexResponseResult> {
  let attempt = 1;
  while (true) {
    try {
      return await collectChatGptCodexResponse(options);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableChatGptTransportError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      attempt += 1;
    }
  }
}

function isInlineImageMime(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  return mimeType.startsWith("image/");
}

function guessInlineDataFilename(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return "image.jpg";
    case "image/png":
      return "image.png";
    case "image/webp":
      return "image.webp";
    case "image/gif":
      return "image.gif";
    case "application/pdf":
      return "document.pdf";
    case "application/json":
      return "data.json";
    case "text/markdown":
      return "document.md";
    case "text/plain":
      return "document.txt";
    default:
      return "attachment.bin";
  }
}

function normaliseAttachmentFilename(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const basename = path.basename(trimmed).replace(/[^\w.-]+/g, "-");
  return basename.length > 0 ? basename : fallback;
}

function setInlineAttachmentFilename(target: object, filename: string | undefined): void {
  const normalized = filename?.trim();
  if (!normalized) {
    return;
  }
  (target as InternalFilenameCarrier)[INLINE_ATTACHMENT_FILENAME_SYMBOL] = normalized;
}

function getInlineAttachmentFilename(target: unknown): string | undefined {
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const value = (target as InternalFilenameCarrier)[INLINE_ATTACHMENT_FILENAME_SYMBOL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function estimateInlinePayloadBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isOpenAiNativeContentItem(value: unknown): value is Record<string, any> {
  return (
    !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
  );
}

function estimateOpenAiInlinePromptBytes(input: readonly unknown[]): number {
  let total = 0;
  const visitItems = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (Array.isArray((item as { content?: unknown }).content)) {
        visitItems((item as { content: unknown[] }).content);
      }
      if (Array.isArray((item as { output?: unknown }).output)) {
        visitItems((item as { output: unknown[] }).output);
      }
      if (!isOpenAiNativeContentItem(item)) {
        continue;
      }
      if (
        item.type === "input_image" &&
        typeof item.image_url === "string" &&
        item.image_url.trim().toLowerCase().startsWith("data:")
      ) {
        total += estimateInlinePayloadBytes(item.image_url);
      }
      if (
        item.type === "input_file" &&
        typeof item.file_data === "string" &&
        item.file_data.trim().length > 0
      ) {
        total += estimateInlinePayloadBytes(item.file_data);
      }
      if (
        item.type === "input_file" &&
        typeof item.file_url === "string" &&
        item.file_url.trim().toLowerCase().startsWith("data:")
      ) {
        total += estimateInlinePayloadBytes(item.file_url);
      }
    }
  };
  visitItems(input);
  return total;
}

async function storeCanonicalPromptFile(options: {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}): Promise<{ readonly fileId: string; readonly filename: string; readonly mimeType: string }> {
  const file = await runWithFileUploadSource("prompt_inline_offload", async () => {
    return await filesCreate({
      data: options.bytes,
      filename: options.filename,
      mimeType: options.mimeType,
      expiresAfterSeconds: DEFAULT_FILE_TTL_SECONDS,
    });
  });
  return {
    fileId: file.id,
    filename: file.filename,
    mimeType: options.mimeType,
  };
}

async function prepareOpenAiPromptContentItem(
  item: unknown,
  options?: {
    model?: string;
    provider?: "openai" | "chatgpt";
    offloadInlineData?: boolean;
  },
): Promise<unknown> {
  if (!isOpenAiNativeContentItem(item)) {
    return item;
  }

  if (item.type === "input_image") {
    if (isCanonicalLlmFileId(item.file_id)) {
      const signedUrl = await getCanonicalFileSignedUrl({ fileId: item.file_id });
      return {
        type: "input_image",
        image_url: signedUrl,
        detail: toOpenAiImageDetail(
          isLlmMediaResolution(item.detail) ? item.detail : undefined,
          options?.model,
        ),
      };
    }

    if (
      options?.offloadInlineData !== true ||
      typeof item.image_url !== "string" ||
      !item.image_url.trim().toLowerCase().startsWith("data:")
    ) {
      return item;
    }

    const parsed = parseDataUrlPayload(item.image_url);
    if (!parsed) {
      return item;
    }
    const uploaded = await storeCanonicalPromptFile({
      bytes: parsed.bytes,
      mimeType: parsed.mimeType ?? "application/octet-stream",
      filename: normaliseAttachmentFilename(
        getInlineAttachmentFilename(item),
        guessInlineDataFilename(parsed.mimeType),
      ),
    });
    const signedUrl = await getCanonicalFileSignedUrl({ fileId: uploaded.fileId });
    return {
      type: "input_image",
      image_url: signedUrl,
      detail: toOpenAiImageDetail(
        isLlmMediaResolution(item.detail) ? item.detail : undefined,
        options?.model,
      ),
    };
  }

  if (item.type !== "input_file") {
    return item;
  }

  if (isCanonicalLlmFileId(item.file_id)) {
    const signedUrl = await getCanonicalFileSignedUrl({ fileId: item.file_id });
    return {
      type: "input_file",
      file_url: signedUrl,
    };
  }

  if (options?.offloadInlineData !== true) {
    return item;
  }

  if (typeof item.file_data === "string" && item.file_data.trim().length > 0) {
    const filename = normaliseAttachmentFilename(
      typeof item.filename === "string" ? item.filename : undefined,
      guessInlineDataFilename(undefined),
    );
    const mimeType = inferToolOutputMimeTypeFromFilename(filename) ?? "application/octet-stream";
    const uploaded = await storeCanonicalPromptFile({
      bytes: decodeInlineDataBuffer(item.file_data),
      mimeType,
      filename,
    });
    const signedUrl = await getCanonicalFileSignedUrl({ fileId: uploaded.fileId });
    return {
      type: "input_file",
      file_url: signedUrl,
    };
  }

  if (typeof item.file_url === "string" && item.file_url.trim().toLowerCase().startsWith("data:")) {
    const parsed = parseDataUrlPayload(item.file_url);
    if (!parsed) {
      return item;
    }
    const uploaded = await storeCanonicalPromptFile({
      bytes: parsed.bytes,
      mimeType: parsed.mimeType ?? "application/octet-stream",
      filename: normaliseAttachmentFilename(
        typeof item.filename === "string" ? item.filename : undefined,
        guessInlineDataFilename(parsed.mimeType),
      ),
    });
    const signedUrl = await getCanonicalFileSignedUrl({ fileId: uploaded.fileId });
    return {
      type: "input_file",
      file_url: signedUrl,
    };
  }

  return item;
}

async function prepareOpenAiPromptInput(
  input: readonly unknown[],
  options?: {
    model?: string;
    provider?: "openai" | "chatgpt";
    offloadInlineData?: boolean;
  },
): Promise<unknown[]> {
  const prepareItem = async (item: unknown): Promise<unknown> => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return {
        ...record,
        content: await Promise.all(
          record.content.map((part) => prepareOpenAiPromptContentItem(part, options)),
        ),
      };
    }
    if (Array.isArray(record.output)) {
      return {
        ...record,
        output: await Promise.all(
          record.output.map((part) => prepareOpenAiPromptContentItem(part, options)),
        ),
      };
    }
    return await prepareOpenAiPromptContentItem(item, options);
  };

  return await Promise.all(input.map((item) => prepareItem(item)));
}

function hasCanonicalOpenAiFileReferences(input: readonly unknown[]): boolean {
  let found = false;
  const visitItems = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (found || !item || typeof item !== "object") {
        continue;
      }
      if (Array.isArray((item as { content?: unknown }).content)) {
        visitItems((item as { content: unknown[] }).content);
      }
      if (Array.isArray((item as { output?: unknown }).output)) {
        visitItems((item as { output: unknown[] }).output);
      }
      if (!isOpenAiNativeContentItem(item)) {
        continue;
      }
      if (
        (item.type === "input_image" || item.type === "input_file") &&
        isCanonicalLlmFileId(item.file_id)
      ) {
        found = true;
        return;
      }
    }
  };
  visitItems(input);
  return found;
}

async function maybePrepareOpenAiPromptInput(
  input: readonly unknown[],
  options?: { model?: string; provider?: "openai" | "chatgpt" },
): Promise<unknown[]> {
  const offloadInlineData =
    estimateOpenAiInlinePromptBytes(input) > INLINE_ATTACHMENT_PROMPT_THRESHOLD_BYTES;
  if (!offloadInlineData && !hasCanonicalOpenAiFileReferences(input)) {
    return Array.from(input);
  }
  return await prepareOpenAiPromptInput(input, {
    ...options,
    offloadInlineData,
  });
}

function estimateGeminiInlinePromptBytes(contents: readonly GeminiContent[]): number {
  let total = 0;
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.inlineData?.data) {
        total += estimateInlinePayloadBytes(part.inlineData.data);
      }
    }
  }
  return total;
}

function hasCanonicalGeminiFileReferences(contents: readonly GeminiContent[]): boolean {
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (parseCanonicalGeminiFileId(part.fileData?.fileUri)) {
        return true;
      }
    }
  }
  return false;
}

async function prepareGeminiPromptContents(
  contents: readonly GeminiContent[],
): Promise<GeminiContent[]> {
  const backend = getGeminiBackend();
  const preparedContents: GeminiContent[] = [];
  for (const content of contents) {
    const parts: GeminiPart[] = [];
    for (const part of content.parts ?? []) {
      const canonicalFileId = parseCanonicalGeminiFileId(part.fileData?.fileUri);
      if (canonicalFileId) {
        const mediaResolution = part.mediaResolution?.level;
        await getCanonicalFileMetadata(canonicalFileId);
        if (backend === "api") {
          const mirrored = await ensureGeminiFileMirror(canonicalFileId);
          parts.push(createPartFromUri(mirrored.uri, mirrored.mimeType, mediaResolution));
        } else {
          const mirrored = await ensureVertexFileMirror(canonicalFileId);
          parts.push({
            fileData: {
              fileUri: mirrored.fileUri,
              mimeType: mirrored.mimeType,
            },
            ...(mediaResolution ? { mediaResolution: { level: mediaResolution } } : {}),
          });
        }
        continue;
      }

      if (part.inlineData?.data) {
        const mediaResolution = part.mediaResolution?.level;
        const mimeType = part.inlineData.mimeType ?? "application/octet-stream";
        const filename = normaliseAttachmentFilename(
          getInlineAttachmentFilename(part.inlineData) ??
            part.inlineData.displayName ??
            guessInlineDataFilename(mimeType),
          guessInlineDataFilename(mimeType),
        );
        const stored = await storeCanonicalPromptFile({
          bytes: decodeInlineDataBuffer(part.inlineData.data),
          mimeType,
          filename,
        });
        if (backend === "api") {
          const mirrored = await ensureGeminiFileMirror(stored.fileId);
          parts.push(createPartFromUri(mirrored.uri, mirrored.mimeType, mediaResolution));
        } else {
          const mirrored = await ensureVertexFileMirror(stored.fileId);
          parts.push({
            fileData: {
              fileUri: mirrored.fileUri,
              mimeType: mirrored.mimeType,
            },
            ...(mediaResolution ? { mediaResolution: { level: mediaResolution } } : {}),
          });
        }
        continue;
      }

      parts.push(part);
    }
    preparedContents.push({
      ...content,
      parts,
    });
  }
  return preparedContents;
}

async function maybePrepareGeminiPromptContents(
  contents: readonly GeminiContent[],
): Promise<GeminiContent[]> {
  if (
    !hasCanonicalGeminiFileReferences(contents) &&
    estimateGeminiInlinePromptBytes(contents) <= INLINE_ATTACHMENT_PROMPT_THRESHOLD_BYTES
  ) {
    return Array.from(contents);
  }
  return await prepareGeminiPromptContents(contents);
}

function mergeConsecutiveTextParts(parts: readonly LlmContentPart[]): LlmContentPart[] {
  if (parts.length === 0) {
    return [];
  }
  const merged: LlmContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      merged.push(cloneContentPart(part));
      continue;
    }
    const isThought = part.thought === true;
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && (last.thought === true) === isThought) {
      last.text += part.text;
      last.thought = isThought ? true : undefined;
    } else {
      merged.push({
        type: "text",
        text: part.text,
        thought: isThought ? true : undefined,
      });
    }
  }
  return merged;
}

function extractTextByChannel(content: LlmContent | undefined): { text: string; thoughts: string } {
  if (!content) {
    return { text: "", thoughts: "" };
  }
  let text = "";
  let thoughts = "";
  for (const part of content.parts) {
    if (part.type !== "text") {
      continue;
    }
    if (part.thought === true) {
      thoughts += part.text;
    } else {
      text += part.text;
    }
  }
  return { text: text.trim(), thoughts: thoughts.trim() };
}

function normalizeJsonText(rawText: string): string {
  let text = rawText.trim();

  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
    text = text.replace(/```(?:\s*)?$/, "").trim();
  }

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  if (!text.startsWith("{") && !text.startsWith("[")) {
    const firstBrace = text.indexOf("{");
    if (firstBrace !== -1) {
      const lastBrace = text.lastIndexOf("}");
      if (lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.slice(firstBrace, lastBrace + 1).trim();
      }
    }
  }

  return text;
}

function escapeNewlinesInStrings(jsonText: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonText.length; i += 1) {
    const char = jsonText[i] ?? "";
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        output += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        output += char;
        inString = false;
        continue;
      }
      if (char === "\n") {
        output += "\\n";
        continue;
      }
      if (char === "\r") {
        output += "\\r";
        continue;
      }
      output += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    output += char;
  }
  return output;
}

export function parseJsonFromLlmText(rawText: string): unknown {
  const cleanedText = normalizeJsonText(rawText);
  const repairedText = escapeNewlinesInStrings(cleanedText);
  return JSON.parse(repairedText);
}

function parsePartialJsonFromLlmText(rawText: string): unknown | null {
  const jsonStart = extractJsonStartText(rawText);
  if (!jsonStart) {
    return null;
  }
  try {
    return parsePartialJson(jsonStart);
  } catch {
    return null;
  }
}

function extractJsonStartText(rawText: string): string | null {
  let text = rawText.trimStart();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  }
  const objIndex = text.indexOf("{");
  const arrIndex = text.indexOf("[");
  let start = -1;
  if (objIndex !== -1 && arrIndex !== -1) {
    start = Math.min(objIndex, arrIndex);
  } else {
    start = objIndex !== -1 ? objIndex : arrIndex;
  }
  if (start === -1) {
    return null;
  }
  return text.slice(start);
}

type PartialJsonObjectContext = {
  type: "object";
  value: Record<string, unknown>;
  state: "keyOrEnd" | "colon" | "value" | "commaOrEnd";
  key?: string;
};

type PartialJsonArrayContext = {
  type: "array";
  value: unknown[];
  state: "valueOrEnd" | "commaOrEnd";
};

type PartialJsonContext = PartialJsonObjectContext | PartialJsonArrayContext;

function parsePartialJson(text: string): unknown | null {
  let i = 0;
  const len = text.length;

  const isWhitespace = (char: string): boolean =>
    char === " " || char === "\n" || char === "\r" || char === "\t";
  const skipWhitespace = (): void => {
    while (i < len && isWhitespace(text[i] ?? "")) {
      i += 1;
    }
  };

  const parseString = (): { value: string; complete: boolean } | null => {
    if (text[i] !== '"') {
      return null;
    }
    i += 1;
    let value = "";
    while (i < len) {
      const ch = text[i] ?? "";
      if (ch === '"') {
        i += 1;
        return { value, complete: true };
      }
      if (ch === "\\") {
        if (i + 1 >= len) {
          return { value, complete: false };
        }
        const esc = text[i + 1] ?? "";
        switch (esc) {
          case '"':
          case "\\":
          case "/":
            value += esc;
            i += 2;
            continue;
          case "b":
            value += "\b";
            i += 2;
            continue;
          case "f":
            value += "\f";
            i += 2;
            continue;
          case "n":
            value += "\n";
            i += 2;
            continue;
          case "r":
            value += "\r";
            i += 2;
            continue;
          case "t":
            value += "\t";
            i += 2;
            continue;
          case "u": {
            // \uXXXX
            if (i + 5 >= len) {
              return { value, complete: false };
            }
            const hex = text.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
              value += "u";
              i += 2;
              continue;
            }
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          default:
            value += esc;
            i += 2;
            continue;
        }
      }
      value += ch;
      i += 1;
    }
    return { value, complete: false };
  };

  const parseNumber = (): { value: number; complete: boolean } | null => {
    const start = i;
    while (i < len) {
      const ch = text[i] ?? "";
      if (isWhitespace(ch) || ch === "," || ch === "}" || ch === "]") {
        break;
      }
      i += 1;
    }
    const raw = text.slice(start, i);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
      i = start;
      return null;
    }
    return { value: Number(raw), complete: true };
  };

  const parseLiteral = (): { value: unknown; complete: boolean } | null => {
    if (text.startsWith("true", i)) {
      i += 4;
      return { value: true, complete: true };
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return { value: false, complete: true };
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return { value: null, complete: true };
    }
    return null;
  };

  skipWhitespace();
  const first = text[i];
  if (first !== "{" && first !== "[") {
    return null;
  }

  const root: unknown = first === "{" ? {} : [];
  const stack: PartialJsonContext[] =
    first === "{"
      ? [{ type: "object", value: root as Record<string, unknown>, state: "keyOrEnd" }]
      : [{ type: "array", value: root as unknown[], state: "valueOrEnd" }];
  i += 1;

  while (stack.length > 0) {
    skipWhitespace();
    if (i >= len) {
      break;
    }

    const ctx = stack[stack.length - 1];
    if (!ctx) {
      break;
    }

    const ch = text[i] ?? "";

    if (ctx.type === "object") {
      if (ctx.state === "keyOrEnd") {
        if (ch === "}") {
          i += 1;
          stack.pop();
          continue;
        }
        if (ch === ",") {
          i += 1;
          continue;
        }
        if (ch !== '"') {
          break;
        }
        const key = parseString();
        if (!key) {
          break;
        }
        if (!key.complete) {
          break;
        }
        ctx.key = key.value;
        ctx.state = "colon";
        continue;
      }

      if (ctx.state === "colon") {
        if (ch === ":") {
          i += 1;
          ctx.state = "value";
          continue;
        }
        break;
      }

      if (ctx.state === "value") {
        if (ch === "}") {
          i += 1;
          ctx.key = undefined;
          stack.pop();
          continue;
        }
        if (ch === ",") {
          i += 1;
          ctx.key = undefined;
          ctx.state = "keyOrEnd";
          continue;
        }

        const key = ctx.key;
        if (!key) {
          break;
        }

        if (ch === "{" || ch === "[") {
          const container: unknown = ch === "{" ? {} : [];
          ctx.value[key] = container;
          ctx.key = undefined;
          ctx.state = "commaOrEnd";
          stack.push(
            ch === "{"
              ? { type: "object", value: container as Record<string, unknown>, state: "keyOrEnd" }
              : { type: "array", value: container as unknown[], state: "valueOrEnd" },
          );
          i += 1;
          continue;
        }

        let primitive: { value: unknown; complete: boolean } | null = null;
        if (ch === '"') {
          primitive = parseString();
        } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
          primitive = parseNumber();
        } else {
          primitive = parseLiteral();
        }
        if (!primitive) {
          break;
        }
        ctx.value[key] = primitive.value;
        ctx.key = undefined;
        ctx.state = "commaOrEnd";
        if (!primitive.complete) {
          break;
        }
        continue;
      }

      if (ctx.state === "commaOrEnd") {
        if (ch === ",") {
          i += 1;
          ctx.state = "keyOrEnd";
          continue;
        }
        if (ch === "}") {
          i += 1;
          stack.pop();
          continue;
        }
        break;
      }
    } else {
      if (ctx.state === "valueOrEnd") {
        if (ch === "]") {
          i += 1;
          stack.pop();
          continue;
        }
        if (ch === ",") {
          i += 1;
          continue;
        }

        if (ch === "{" || ch === "[") {
          const container: unknown = ch === "{" ? {} : [];
          ctx.value.push(container);
          ctx.state = "commaOrEnd";
          stack.push(
            ch === "{"
              ? { type: "object", value: container as Record<string, unknown>, state: "keyOrEnd" }
              : { type: "array", value: container as unknown[], state: "valueOrEnd" },
          );
          i += 1;
          continue;
        }

        let primitive: { value: unknown; complete: boolean } | null = null;
        if (ch === '"') {
          primitive = parseString();
        } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
          primitive = parseNumber();
        } else {
          primitive = parseLiteral();
        }
        if (!primitive) {
          break;
        }
        ctx.value.push(primitive.value);
        ctx.state = "commaOrEnd";
        if (!primitive.complete) {
          break;
        }
        continue;
      }

      if (ctx.state === "commaOrEnd") {
        if (ch === ",") {
          i += 1;
          ctx.state = "valueOrEnd";
          continue;
        }
        if (ch === "]") {
          i += 1;
          stack.pop();
          continue;
        }
        break;
      }
    }
  }

  return root;
}

function resolveTextContents(input: LlmInput): readonly LlmContent[] {
  const contents: LlmContent[] = [];

  if (input.instructions) {
    const instructions = input.instructions.trim();
    if (instructions.length > 0) {
      contents.push({
        role: "system",
        parts: [{ type: "text", text: instructions }],
      });
    }
  }

  if (typeof input.input === "string") {
    contents.push({
      role: "user",
      parts: [{ type: "text", text: input.input }],
    });
    return contents;
  }

  for (const message of input.input) {
    const parts =
      typeof message.content === "string"
        ? ([{ type: "text", text: message.content }] as const)
        : message.content;
    contents.push({
      role: message.role,
      parts: parts.map((part) => cloneContentPart(part)),
    });
  }

  return contents;
}

function toOpenAiInput(
  contents: readonly LlmContent[],
  options?: { defaultMediaResolution?: LlmMediaResolution; model?: string },
): unknown[] {
  // Keep the shape compatible with OpenAI Responses API input.
  const OPENAI_ROLE_FROM_LLM: Record<LlmRole, string> = {
    user: "user",
    assistant: "assistant",
    system: "system",
    developer: "developer",
    tool: "assistant",
  };
  const defaultMediaResolution = options?.defaultMediaResolution;
  const model = options?.model;

  return contents.map((content) => {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content.parts) {
      switch (part.type) {
        case "text":
          parts.push({ type: "input_text", text: part.text });
          break;
        case "inlineData": {
          const mimeType = part.mimeType;
          if (isInlineImageMime(mimeType)) {
            const dataUrl = `data:${mimeType};base64,${part.data}`;
            const imagePart: Record<string, unknown> = {
              type: "input_image",
              image_url: dataUrl,
              detail: toOpenAiImageDetail(defaultMediaResolution, model),
            };
            setInlineAttachmentFilename(
              imagePart,
              normaliseAttachmentFilename(part.filename, guessInlineDataFilename(mimeType)),
            );
            parts.push(imagePart);
            break;
          }
          parts.push({
            type: "input_file",
            filename: normaliseAttachmentFilename(part.filename, guessInlineDataFilename(mimeType)),
            file_data: part.data,
          });
          break;
        }
        case "input_image": {
          const mediaResolution = resolveEffectiveMediaResolution(
            part.detail,
            defaultMediaResolution,
          );
          const imagePart: Record<string, unknown> = {
            type: "input_image",
            ...(part.file_id ? { file_id: part.file_id } : {}),
            ...(part.image_url ? { image_url: part.image_url } : {}),
            detail: toOpenAiImageDetail(mediaResolution, model),
          };
          if (part.filename) {
            setInlineAttachmentFilename(imagePart, part.filename);
          }
          parts.push(imagePart);
          break;
        }
        case "input_file":
          parts.push({
            type: "input_file",
            ...(part.file_id ? { file_id: part.file_id } : {}),
            ...(part.file_data ? { file_data: part.file_data } : {}),
            ...(part.file_url ? { file_url: part.file_url } : {}),
            ...(!part.file_id && part.filename ? { filename: part.filename } : {}),
          });
          break;
        default:
          throw new Error("Unsupported LLM content part");
      }
    }
    if (
      parts.length === 1 &&
      parts[0]?.type === "input_text" &&
      typeof parts[0].text === "string"
    ) {
      return {
        role: OPENAI_ROLE_FROM_LLM[content.role],
        content: parts[0].text,
      };
    }
    return {
      role: OPENAI_ROLE_FROM_LLM[content.role],
      content: parts,
    };
  });
}

function toChatGptInput(
  contents: readonly LlmContent[],
  options?: { defaultMediaResolution?: LlmMediaResolution; model?: string },
): {
  instructions?: string;
  input: ChatGptInputItem[];
} {
  const instructionsParts: string[] = [];
  const input: ChatGptInputItem[] = [];
  const defaultMediaResolution = options?.defaultMediaResolution;
  const model = options?.model;
  for (const content of contents) {
    if (content.role === "system" || content.role === "developer") {
      for (const part of content.parts) {
        if (part.type === "text") {
          instructionsParts.push(part.text);
        }
      }
      continue;
    }
    const isAssistant = content.role === "assistant" || content.role === "tool";
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content.parts) {
      if (part.type === "text") {
        parts.push({
          type: isAssistant ? "output_text" : "input_text",
          text: part.text,
        });
        continue;
      }
      if (isAssistant) {
        const mimeType =
          part.type === "inlineData"
            ? (part.mimeType ?? "application/octet-stream")
            : (inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream");
        parts.push({
          type: "output_text",
          text:
            part.type === "input_image" || isInlineImageMime((part as LlmInlineDataPart).mimeType)
              ? `[image:${mimeType}]`
              : `[file:${mimeType}]`,
        });
        continue;
      }
      switch (part.type) {
        case "inlineData": {
          if (isInlineImageMime(part.mimeType)) {
            const mimeType = part.mimeType ?? "application/octet-stream";
            const dataUrl = `data:${mimeType};base64,${part.data}`;
            parts.push({
              type: "input_image",
              image_url: dataUrl,
              detail: toOpenAiImageDetail(defaultMediaResolution, model),
            });
          } else {
            parts.push({
              type: "input_file",
              filename: normaliseAttachmentFilename(
                part.filename,
                guessInlineDataFilename(part.mimeType),
              ),
              file_data: part.data,
            });
          }
          break;
        }
        case "input_image": {
          const mediaResolution = resolveEffectiveMediaResolution(
            part.detail,
            defaultMediaResolution,
          );
          parts.push({
            type: "input_image",
            ...(part.file_id ? { file_id: part.file_id } : {}),
            ...(part.image_url ? { image_url: part.image_url } : {}),
            detail: toOpenAiImageDetail(mediaResolution, model),
          });
          break;
        }
        case "input_file":
          parts.push({
            type: "input_file",
            ...(part.file_id ? { file_id: part.file_id } : {}),
            ...(part.file_data ? { file_data: part.file_data } : {}),
            ...(part.file_url ? { file_url: part.file_url } : {}),
            ...(!part.file_id && part.filename ? { filename: part.filename } : {}),
          });
          break;
        default:
          throw new Error("Unsupported LLM content part");
      }
    }
    if (parts.length === 0) {
      parts.push({
        type: isAssistant ? "output_text" : "input_text",
        text: "(empty content)",
      });
    }
    if (isAssistant) {
      input.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: parts,
      } as ChatGptInputItem);
    } else {
      input.push({
        role: "user",
        content: parts,
      } as ChatGptInputItem);
    }
  }
  const instructions = instructionsParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\\n\\n");
  return {
    instructions: instructions.length > 0 ? instructions : undefined,
    input,
  };
}

function toFireworksMessages(
  contents: readonly LlmContent[],
  options?: { readonly responseMimeType?: string; readonly responseJsonSchema?: JsonSchema },
): Array<Record<string, unknown>> {
  const systemMessages: string[] = [];
  const messages: Array<Record<string, unknown>> = [];

  if (options?.responseMimeType === "application/json") {
    systemMessages.push("Return valid JSON only. Do not include markdown or prose outside JSON.");
  }
  if (options?.responseJsonSchema) {
    systemMessages.push(`Target JSON schema:
${JSON.stringify(options.responseJsonSchema)}`);
  }

  for (const content of contents) {
    const text = content.parts
      .map((part) => {
        if (part.type === "text") {
          return part.text;
        }
        const mimeType =
          part.type === "inlineData"
            ? (part.mimeType ?? "application/octet-stream")
            : (inferToolOutputMimeTypeFromFilename(part.filename) ?? "application/octet-stream");
        if (part.type === "input_image" || isInlineImageMime(mimeType)) {
          return `[image:${mimeType}]`;
        }
        return `[file:${mimeType}]`;
      })
      .join("\n")
      .trim();

    if (content.role === "system" || content.role === "developer") {
      if (text.length > 0) {
        systemMessages.push(text);
      }
      continue;
    }

    if (content.role === "tool" || content.role === "assistant") {
      messages.push({
        role: "assistant",
        content: text.length > 0 ? text : "(empty content)",
      });
      continue;
    }

    messages.push({
      role: "user",
      content: text.length > 0 ? text : "(empty content)",
    });
  }

  if (systemMessages.length > 0) {
    messages.unshift({
      role: "system",
      content: systemMessages.join("\n\n"),
    });
  }

  return messages;
}

function toGeminiTools(tools: readonly LlmToolConfig[] | undefined): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => {
    switch (tool.type) {
      case "web-search":
        return { googleSearch: {} };
      case "code-execution":
        return { codeExecution: {} };
      case "shell":
        throw new Error("Gemini provider does not support the OpenAI shell tool.");
      default:
        throw new Error("Unsupported tool configuration");
    }
  });
}

function toOpenAiShellEnvironment(
  environment: LlmOpenAiShellEnvironment | undefined,
): Record<string, unknown> {
  if (environment?.type === "container-reference") {
    return {
      type: "container_reference",
      container_id: environment.containerId,
    };
  }

  return {
    type: "container_auto",
    ...(environment?.fileIds ? { file_ids: Array.from(environment.fileIds) } : {}),
    ...(environment?.memoryLimit !== undefined ? { memory_limit: environment.memoryLimit } : {}),
    ...(environment?.networkPolicy
      ? {
          network_policy:
            environment.networkPolicy.type === "allowlist"
              ? {
                  type: "allowlist",
                  allowed_domains: Array.from(environment.networkPolicy.allowedDomains),
                  ...(environment.networkPolicy.domainSecrets
                    ? {
                        domain_secrets: environment.networkPolicy.domainSecrets.map((secret) => ({
                          domain: secret.domain,
                          name: secret.name,
                          value: secret.value,
                        })),
                      }
                    : {}),
                }
              : { type: "disabled" },
        }
      : {}),
  };
}

function toOpenAiTools(
  tools: readonly LlmToolConfig[] | undefined,
  options: { readonly provider: "openai" | "chatgpt" },
): unknown[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => {
    switch (tool.type) {
      case "web-search": {
        const external_web_access = tool.mode !== "cached";
        return { type: "web_search", external_web_access };
      }
      case "code-execution": {
        return { type: "code_interpreter", container: { type: "auto" } };
      }
      case "shell": {
        if (options.provider !== "openai") {
          throw new Error("OpenAI shell tool is only supported for OpenAI API models.");
        }
        return {
          type: "shell",
          environment: toOpenAiShellEnvironment(tool.environment),
        };
      }
      default:
        throw new Error("Unsupported tool configuration");
    }
  });
}

function mergeTokenUpdates(
  current: LlmUsageTokens | undefined,
  next: LlmUsageTokens | undefined,
): LlmUsageTokens | undefined {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  return {
    promptTokens: next.promptTokens ?? current.promptTokens,
    promptTextTokens: next.promptTextTokens ?? current.promptTextTokens,
    promptImageTokens: next.promptImageTokens ?? current.promptImageTokens,
    cachedTokens: next.cachedTokens ?? current.cachedTokens,
    responseTokens: next.responseTokens ?? current.responseTokens,
    responseTextTokens: next.responseTextTokens ?? current.responseTextTokens,
    responseImageTokens: next.responseImageTokens ?? current.responseImageTokens,
    thinkingTokens: next.thinkingTokens ?? current.thinkingTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    toolUsePromptTokens: next.toolUsePromptTokens ?? current.toolUsePromptTokens,
  };
}

function sumUsageValue(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return current;
  }
  const normalizedNext = Math.max(0, next);
  if (typeof current !== "number" || !Number.isFinite(current)) {
    return normalizedNext;
  }
  return Math.max(0, current) + normalizedNext;
}

function sumUsageTokens(
  current: LlmUsageTokens | undefined,
  next: LlmUsageTokens | undefined,
): LlmUsageTokens | undefined {
  if (!next) {
    return current;
  }
  return {
    promptTokens: sumUsageValue(current?.promptTokens, next.promptTokens),
    promptTextTokens: sumUsageValue(current?.promptTextTokens, next.promptTextTokens),
    promptImageTokens: sumUsageValue(current?.promptImageTokens, next.promptImageTokens),
    cachedTokens: sumUsageValue(current?.cachedTokens, next.cachedTokens),
    responseTokens: sumUsageValue(current?.responseTokens, next.responseTokens),
    responseTextTokens: sumUsageValue(current?.responseTextTokens, next.responseTextTokens),
    responseImageTokens: sumUsageValue(current?.responseImageTokens, next.responseImageTokens),
    thinkingTokens: sumUsageValue(current?.thinkingTokens, next.thinkingTokens),
    totalTokens: sumUsageValue(current?.totalTokens, next.totalTokens),
    toolUsePromptTokens: sumUsageValue(current?.toolUsePromptTokens, next.toolUsePromptTokens),
  };
}

function countInlineImagesInContent(content: LlmContent | undefined): number {
  if (!content) {
    return 0;
  }
  let count = 0;
  for (const part of content.parts) {
    if (part.type === "inlineData" && isInlineImageMime(part.mimeType)) {
      count += 1;
    }
  }
  return count;
}

type LlmTelemetryEventPayload =
  | Omit<LlmCallStartedTelemetryEvent, "timestamp" | "callId" | "operation" | "provider" | "model">
  | Omit<LlmCallStreamTelemetryEvent, "timestamp" | "callId" | "operation" | "provider" | "model">
  | Omit<
      LlmCallCompletedTelemetryEvent,
      "timestamp" | "callId" | "operation" | "provider" | "model"
    >;

function createLlmTelemetryEmitter(params: {
  telemetry: TelemetrySelection | undefined;
  operation: LlmTelemetryOperation;
  provider: LlmProvider;
  model: LlmModelId;
}): {
  readonly includeStreamEvents: boolean;
  readonly emit: (event: LlmTelemetryEventPayload) => void;
  readonly flush: () => Promise<void>;
} {
  const session = createTelemetrySession(params.telemetry);
  const callId = randomBytes(8).toString("hex");
  return {
    includeStreamEvents: session?.includeStreamEvents === true,
    emit: (event) => {
      if (!session) {
        return;
      }
      session.emit({
        ...event,
        timestamp: new Date().toISOString(),
        callId,
        operation: params.operation,
        provider: params.provider,
        model: params.model,
      });
    },
    flush: async () => {
      await session?.flush();
    },
  };
}

function toMaybeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function sumModalityTokenCounts(details: unknown, modality: string): number {
  if (!Array.isArray(details)) {
    return 0;
  }
  let total = 0;
  for (const entry of details) {
    const entryModality = (entry as { modality?: unknown }).modality;
    if (typeof entryModality !== "string") {
      continue;
    }
    if (entryModality.toUpperCase() !== modality.toUpperCase()) {
      continue;
    }
    const tokenCount = toMaybeNumber((entry as { tokenCount?: unknown }).tokenCount);
    if (tokenCount !== undefined && tokenCount > 0) {
      total += tokenCount;
    }
  }
  return total;
}

function extractGeminiUsageTokens(usage: unknown): LlmUsageTokens | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const promptTokens = toMaybeNumber((usage as { promptTokenCount?: unknown }).promptTokenCount);
  const cachedTokens = toMaybeNumber(
    (usage as { cachedContentTokenCount?: unknown }).cachedContentTokenCount,
  );
  const responseTokens = toMaybeNumber(
    (usage as { candidatesTokenCount?: unknown }).candidatesTokenCount ??
      (usage as { responseTokenCount?: unknown }).responseTokenCount,
  );
  const thinkingTokens = toMaybeNumber(
    (usage as { thoughtsTokenCount?: unknown }).thoughtsTokenCount,
  );
  const totalTokens = toMaybeNumber((usage as { totalTokenCount?: unknown }).totalTokenCount);
  const toolUsePromptTokens = toMaybeNumber(
    (usage as { toolUsePromptTokenCount?: unknown }).toolUsePromptTokenCount,
  );
  const responseDetails =
    (usage as { candidatesTokensDetails?: unknown }).candidatesTokensDetails ??
    (usage as { responseTokensDetails?: unknown }).responseTokensDetails;
  const responseImageTokens = sumModalityTokenCounts(responseDetails, "IMAGE");
  if (
    promptTokens === undefined &&
    cachedTokens === undefined &&
    responseTokens === undefined &&
    responseImageTokens === 0 &&
    thinkingTokens === undefined &&
    totalTokens === undefined &&
    toolUsePromptTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens,
    cachedTokens,
    responseTokens,
    responseImageTokens: responseImageTokens > 0 ? responseImageTokens : undefined,
    thinkingTokens,
    totalTokens,
    toolUsePromptTokens,
  };
}

function extractOpenAiUsageTokens(usage: unknown): LlmUsageTokens | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const promptTokens = toMaybeNumber((usage as { input_tokens?: unknown }).input_tokens);
  const cachedTokens = toMaybeNumber(
    (usage as { input_tokens_details?: { cached_tokens?: unknown } }).input_tokens_details
      ?.cached_tokens,
  );
  const promptTextTokens = toMaybeNumber(
    (usage as { input_tokens_details?: { text_tokens?: unknown } }).input_tokens_details
      ?.text_tokens,
  );
  const promptImageTokens = toMaybeNumber(
    (usage as { input_tokens_details?: { image_tokens?: unknown } }).input_tokens_details
      ?.image_tokens,
  );
  const outputTokensRaw = toMaybeNumber((usage as { output_tokens?: unknown }).output_tokens);
  const reasoningTokens = toMaybeNumber(
    (usage as { output_tokens_details?: { reasoning_tokens?: unknown } }).output_tokens_details
      ?.reasoning_tokens,
  );
  const responseTextTokens = toMaybeNumber(
    (usage as { output_tokens_details?: { text_tokens?: unknown } }).output_tokens_details
      ?.text_tokens,
  );
  const responseImageTokens = toMaybeNumber(
    (usage as { output_tokens_details?: { image_tokens?: unknown } }).output_tokens_details
      ?.image_tokens,
  );
  const totalTokens = toMaybeNumber((usage as { total_tokens?: unknown }).total_tokens);
  let responseTokens: number | undefined;
  if (outputTokensRaw !== undefined) {
    const adjusted = outputTokensRaw - (reasoningTokens ?? 0);
    responseTokens = adjusted >= 0 ? adjusted : 0;
  }
  if (
    promptTokens === undefined &&
    cachedTokens === undefined &&
    responseTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens,
    promptTextTokens,
    promptImageTokens,
    cachedTokens,
    responseTokens,
    responseTextTokens,
    responseImageTokens,
    thinkingTokens: reasoningTokens,
    totalTokens,
  };
}

function extractChatGptUsageTokens(usage: unknown): LlmUsageTokens | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const promptTokens = toMaybeNumber((usage as { input_tokens?: unknown }).input_tokens);
  const cachedTokens = toMaybeNumber(
    (usage as { input_tokens_details?: { cached_tokens?: unknown } }).input_tokens_details
      ?.cached_tokens,
  );
  const outputTokensRaw = toMaybeNumber((usage as { output_tokens?: unknown }).output_tokens);
  const reasoningTokens = toMaybeNumber(
    (usage as { output_tokens_details?: { reasoning_tokens?: unknown } }).output_tokens_details
      ?.reasoning_tokens,
  );
  const totalTokens = toMaybeNumber((usage as { total_tokens?: unknown }).total_tokens);
  let responseTokens: number | undefined;
  if (outputTokensRaw !== undefined) {
    const adjusted = outputTokensRaw - (reasoningTokens ?? 0);
    responseTokens = adjusted >= 0 ? adjusted : 0;
  }
  if (
    promptTokens === undefined &&
    cachedTokens === undefined &&
    responseTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens,
    cachedTokens,
    responseTokens,
    thinkingTokens: reasoningTokens,
    totalTokens,
  };
}

function extractFireworksUsageTokens(usage: unknown): LlmUsageTokens | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const promptTokens = toMaybeNumber(
    (usage as { prompt_tokens?: unknown }).prompt_tokens ??
      (usage as { input_tokens?: unknown }).input_tokens,
  );
  const cachedTokens = toMaybeNumber(
    (usage as { prompt_tokens_details?: { cached_tokens?: unknown } }).prompt_tokens_details
      ?.cached_tokens ??
      (usage as { input_tokens_details?: { cached_tokens?: unknown } }).input_tokens_details
        ?.cached_tokens,
  );
  const outputTokensRaw = toMaybeNumber(
    (usage as { completion_tokens?: unknown }).completion_tokens ??
      (usage as { output_tokens?: unknown }).output_tokens,
  );
  const reasoningTokens = toMaybeNumber(
    (usage as { completion_tokens_details?: { reasoning_tokens?: unknown } })
      .completion_tokens_details?.reasoning_tokens ??
      (usage as { output_tokens_details?: { reasoning_tokens?: unknown } }).output_tokens_details
        ?.reasoning_tokens,
  );
  const totalTokens = toMaybeNumber(
    (usage as { total_tokens?: unknown }).total_tokens ??
      (usage as { totalTokenCount?: unknown }).totalTokenCount,
  );
  let responseTokens: number | undefined;
  if (outputTokensRaw !== undefined) {
    const adjusted = outputTokensRaw - (reasoningTokens ?? 0);
    responseTokens = adjusted >= 0 ? adjusted : 0;
  }
  if (
    promptTokens === undefined &&
    cachedTokens === undefined &&
    responseTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens,
    cachedTokens,
    responseTokens,
    thinkingTokens: reasoningTokens,
    totalTokens,
  };
}

const MODERATION_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

function isModerationFinish(reason: FinishReason | undefined): boolean {
  if (!reason) {
    return false;
  }
  return MODERATION_FINISH_REASONS.has(reason);
}

function mergeToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: "Failed to serialize tool output", detail: message });
  }
}

function isLlmToolOutputContentItem(value: unknown): value is LlmToolOutputContentItem {
  if (!isPlainRecord(value)) {
    return false;
  }
  const itemType = typeof value.type === "string" ? value.type : "";
  if (itemType === "input_text") {
    return typeof value.text === "string";
  }
  if (itemType === "input_image") {
    const keys = ["image_url", "file_id", "filename"] as const;
    for (const key of keys) {
      const part = value[key];
      if (part !== undefined && part !== null && typeof part !== "string") {
        return false;
      }
    }
    if (
      value.detail !== undefined &&
      value.detail !== null &&
      !isLlmMediaResolution(value.detail)
    ) {
      return false;
    }
    return value.image_url !== undefined || value.file_id !== undefined;
  }
  if (itemType === "input_file") {
    const keys = ["file_data", "file_id", "file_url", "filename"] as const;
    for (const key of keys) {
      const part = value[key];
      if (part !== undefined && part !== null && typeof part !== "string") {
        return false;
      }
    }
    return true;
  }
  return false;
}

function toOpenAiToolOutput(
  value: unknown,
  options?: { defaultMediaResolution?: LlmMediaResolution; model?: string },
): string | LlmToolOutputContentItem[] {
  const normalizeImageItem = (item: LlmToolOutputContentItem): LlmToolOutputContentItem => {
    if (item.type !== "input_image") {
      return item;
    }
    const mediaResolution = resolveEffectiveMediaResolution(
      item.detail,
      options?.defaultMediaResolution,
    );
    return {
      ...item,
      detail: toOpenAiImageDetail(mediaResolution, options?.model),
    };
  };
  if (isLlmToolOutputContentItem(value)) {
    return [normalizeImageItem(value)];
  }
  if (Array.isArray(value) && value.every((item) => isLlmToolOutputContentItem(item))) {
    return value.map((item) => normalizeImageItem(item));
  }
  return mergeToolOutput(value);
}

function toChatGptToolOutput(
  value: unknown,
  options?: { defaultMediaResolution?: LlmMediaResolution; model?: string },
): string | ChatGptInputMessagePart[] {
  const toolOutput = toOpenAiToolOutput(value, options);
  if (typeof toolOutput === "string") {
    return toolOutput;
  }
  return toolOutput.map((item) => {
    if (item.type !== "input_image") {
      return item;
    }
    return {
      type: "input_image",
      ...(item.file_id ? { file_id: item.file_id } : {}),
      ...(item.image_url ? { image_url: item.image_url } : {}),
      ...(item.detail
        ? {
            detail: toOpenAiImageDetail(
              resolveEffectiveMediaResolution(item.detail, options?.defaultMediaResolution),
              options?.model,
            ),
          }
        : {}),
    };
  });
}

function toGeminiToolOutputItems(value: unknown): readonly LlmToolOutputContentItem[] | null {
  if (isLlmToolOutputContentItem(value)) {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => isLlmToolOutputContentItem(item))) {
    return value;
  }
  return null;
}

function inferToolOutputMimeTypeFromFilename(
  filename: string | null | undefined,
): string | undefined {
  const normalized = filename?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }
  if (normalized.endsWith(".heic")) {
    return "image/heic";
  }
  if (normalized.endsWith(".heif")) {
    return "image/heif";
  }
  if (normalized.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (normalized.endsWith(".json")) {
    return "application/json";
  }
  if (normalized.endsWith(".md")) {
    return "text/markdown";
  }
  if (normalized.endsWith(".txt")) {
    return "text/plain";
  }
  return undefined;
}

function estimateToolOutputItemBytes(item: LlmToolOutputContentItem): number {
  if (item.type === "input_text") {
    return Buffer.byteLength(item.text, "utf8");
  }
  if (item.type === "input_image") {
    return typeof item.image_url === "string" ? estimateInlinePayloadBytes(item.image_url) : 0;
  }
  if (typeof item.file_data === "string" && item.file_data.trim().length > 0) {
    return estimateInlinePayloadBytes(item.file_data);
  }
  if (typeof item.file_url === "string" && item.file_url.trim().length > 0) {
    return estimateInlinePayloadBytes(item.file_url);
  }
  return 0;
}

async function spillTextToolOutputToFile(options: {
  text: string;
  filename: string;
  mimeType: string;
}): Promise<LlmToolOutputContentItem[]> {
  const stored = await runWithFileUploadSource("tool_output_spill", async () => {
    return await filesCreate({
      data: options.text,
      filename: options.filename,
      mimeType: options.mimeType,
      expiresAfterSeconds: DEFAULT_FILE_TTL_SECONDS,
    });
  });
  return [
    {
      type: "input_text",
      text: `Tool output was attached as ${stored.filename} (${stored.id}) because it exceeded the inline payload threshold.`,
    },
    {
      type: "input_file",
      file_id: stored.id,
      filename: stored.filename,
    },
  ];
}

async function maybeSpillToolOutputItem(
  item: LlmToolOutputContentItem,
  toolName: string,
  options?: {
    readonly force?: boolean;
  },
): Promise<LlmToolOutputContentItem | LlmToolOutputContentItem[]> {
  if (
    options?.force !== true &&
    estimateToolOutputItemBytes(item) <= TOOL_OUTPUT_SPILL_THRESHOLD_BYTES
  ) {
    return item;
  }

  if (item.type === "input_text") {
    return await spillTextToolOutputToFile({
      text: item.text,
      filename: normaliseAttachmentFilename(`${toolName}.txt`, "tool-output.txt"),
      mimeType: "text/plain",
    });
  }

  if (item.type === "input_image") {
    if (item.file_id || !item.image_url) {
      return item;
    }
    const parsed = parseDataUrlPayload(item.image_url);
    if (!parsed) {
      return item;
    }
    const stored = await runWithFileUploadSource("tool_output_spill", async () => {
      return await filesCreate({
        data: parsed.bytes,
        filename: normaliseAttachmentFilename(
          item.filename ?? guessInlineDataFilename(parsed.mimeType),
          guessInlineDataFilename(parsed.mimeType),
        ),
        mimeType: parsed.mimeType,
        expiresAfterSeconds: DEFAULT_FILE_TTL_SECONDS,
      });
    });
    return {
      type: "input_image",
      file_id: stored.id,
      detail: item.detail ?? "auto",
      filename: stored.filename,
    };
  }

  if (item.file_id) {
    return item;
  }

  if (typeof item.file_data === "string" && item.file_data.trim().length > 0) {
    const fileData = item.file_data;
    const filename = normaliseAttachmentFilename(
      item.filename ?? `${toolName}.bin`,
      `${toolName}.bin`,
    );
    const stored = await runWithFileUploadSource("tool_output_spill", async () => {
      return await filesCreate({
        data: decodeInlineDataBuffer(fileData),
        filename,
        mimeType: inferToolOutputMimeTypeFromFilename(filename) ?? "application/octet-stream",
        expiresAfterSeconds: DEFAULT_FILE_TTL_SECONDS,
      });
    });
    return {
      type: "input_file",
      file_id: stored.id,
      filename: stored.filename,
    };
  }

  if (typeof item.file_url === "string" && item.file_url.trim().length > 0) {
    const parsed = parseDataUrlPayload(item.file_url);
    if (!parsed) {
      return item;
    }
    const stored = await runWithFileUploadSource("tool_output_spill", async () => {
      return await filesCreate({
        data: parsed.bytes,
        filename: normaliseAttachmentFilename(
          item.filename ?? guessInlineDataFilename(parsed.mimeType),
          guessInlineDataFilename(parsed.mimeType),
        ),
        mimeType: parsed.mimeType,
        expiresAfterSeconds: DEFAULT_FILE_TTL_SECONDS,
      });
    });
    return {
      type: "input_file",
      file_id: stored.id,
      filename: stored.filename,
    };
  }

  return item;
}

async function maybeSpillToolOutput(
  value: unknown,
  toolName: string,
  options?: {
    readonly force?: boolean;
    readonly provider?: LlmProvider;
  },
): Promise<unknown> {
  if (typeof value === "string") {
    if (
      options?.force !== true &&
      Buffer.byteLength(value, "utf8") <= TOOL_OUTPUT_SPILL_THRESHOLD_BYTES
    ) {
      return value;
    }
    return await spillTextToolOutputToFile({
      text: value,
      filename: normaliseAttachmentFilename(`${toolName}.txt`, "tool-output.txt"),
      mimeType: "text/plain",
    });
  }

  if (isLlmToolOutputContentItem(value)) {
    return await maybeSpillToolOutputItem(value, toolName, options);
  }

  if (Array.isArray(value) && value.every((item) => isLlmToolOutputContentItem(item))) {
    const spilledItems: LlmToolOutputContentItem[] = [];
    for (const item of value) {
      const maybeSpilled = await maybeSpillToolOutputItem(item, toolName, options);
      if (Array.isArray(maybeSpilled)) {
        spilledItems.push(...maybeSpilled);
      } else {
        spilledItems.push(maybeSpilled);
      }
    }
    return spilledItems;
  }

  try {
    const serialized = JSON.stringify(value, null, 2);
    if (
      options?.force !== true &&
      Buffer.byteLength(serialized, "utf8") <= TOOL_OUTPUT_SPILL_THRESHOLD_BYTES
    ) {
      return value;
    }
    return await spillTextToolOutputToFile({
      text: serialized,
      filename: normaliseAttachmentFilename(`${toolName}.json`, "tool-output.json"),
      mimeType: "application/json",
    });
  } catch {
    return value;
  }
}

function estimateToolOutputPayloadBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  if (isLlmToolOutputContentItem(value)) {
    return value.type === "input_text" ? 0 : estimateToolOutputItemBytes(value);
  }
  if (Array.isArray(value) && value.every((item) => isLlmToolOutputContentItem(item))) {
    return value.reduce((total, item) => {
      return total + (item.type === "input_text" ? 0 : estimateToolOutputItemBytes(item));
    }, 0);
  }
  return 0;
}

async function maybeSpillCombinedToolCallOutputs<
  T extends {
    readonly entry: { readonly toolName: string };
    readonly result: LlmToolCallResult;
    readonly outputPayload: unknown;
  },
>(
  callResults: readonly T[],
  options?: {
    readonly provider?: LlmProvider;
  },
): Promise<T[]> {
  const totalBytes = callResults.reduce(
    (sum, callResult) => sum + estimateToolOutputPayloadBytes(callResult.outputPayload),
    0,
  );
  if (totalBytes <= INLINE_ATTACHMENT_PROMPT_THRESHOLD_BYTES) {
    return Array.from(callResults);
  }
  return await Promise.all(
    callResults.map(async (callResult) => {
      if (estimateToolOutputPayloadBytes(callResult.outputPayload) === 0) {
        return callResult;
      }
      const outputPayload = await maybeSpillToolOutput(
        callResult.outputPayload,
        callResult.entry.toolName,
        {
          force: true,
          provider: options?.provider,
        },
      );
      return {
        ...callResult,
        outputPayload,
        result: {
          ...callResult.result,
          output: outputPayload,
        },
      };
    }),
  );
}

function buildGeminiToolOutputMediaPart(
  item: LlmToolOutputContentItem,
  options?: { defaultMediaResolution?: LlmMediaResolution },
): GeminiPart | null {
  if (item.type === "input_image") {
    const mediaResolution = resolveEffectiveMediaResolution(
      item.detail,
      options?.defaultMediaResolution,
    );
    const geminiPartMediaResolution = toGeminiPartMediaResolution(mediaResolution);
    if (typeof item.file_id === "string" && item.file_id.trim().length > 0) {
      return createPartFromUri(
        buildCanonicalGeminiFileUri(item.file_id),
        inferToolOutputMimeTypeFromFilename(item.filename) ?? "application/octet-stream",
        geminiPartMediaResolution,
      );
    }
    if (typeof item.image_url !== "string" || item.image_url.trim().length === 0) {
      return null;
    }
    const parsed = parseDataUrlPayload(item.image_url);
    if (parsed) {
      const part = createPartFromBase64(
        parsed.dataBase64,
        parsed.mimeType,
        geminiPartMediaResolution,
      );
      const displayName = item.filename?.trim();
      if (displayName && part.inlineData) {
        part.inlineData.displayName = displayName;
      }
      return part;
    }
    return createPartFromUri(
      item.image_url,
      inferToolOutputMimeTypeFromFilename(item.filename) ?? "application/octet-stream",
      geminiPartMediaResolution,
    );
  }
  if (item.type === "input_file") {
    if (typeof item.file_id === "string" && item.file_id.trim().length > 0) {
      return {
        fileData: {
          fileUri: buildCanonicalGeminiFileUri(item.file_id),
          mimeType:
            inferToolOutputMimeTypeFromFilename(item.filename) ?? "application/octet-stream",
        },
      };
    }
    const dataUrl = typeof item.file_url === "string" ? parseDataUrlPayload(item.file_url) : null;
    if (dataUrl) {
      const part = createPartFromBase64(dataUrl.dataBase64, dataUrl.mimeType);
      const displayName = item.filename?.trim();
      if (displayName && part.inlineData) {
        part.inlineData.displayName = displayName;
      }
      return part;
    }
    const inferredMimeType = inferToolOutputMimeTypeFromFilename(item.filename);
    if (
      typeof item.file_data === "string" &&
      item.file_data.trim().length > 0 &&
      inferredMimeType
    ) {
      const part = createPartFromBase64(item.file_data, inferredMimeType);
      const displayName = item.filename?.trim();
      if (displayName && part.inlineData) {
        part.inlineData.displayName = displayName;
      }
      return part;
    }
    if (typeof item.file_url === "string" && item.file_url.trim().length > 0 && inferredMimeType) {
      return createPartFromUri(item.file_url, inferredMimeType);
    }
  }
  return null;
}

function toGeminiToolOutputPlaceholder(item: LlmToolOutputContentItem): Record<string, unknown> {
  if (item.type === "input_text") {
    return {
      type: item.type,
      text: item.text,
    };
  }
  if (item.type === "input_image") {
    const parsed = typeof item.image_url === "string" ? parseDataUrlPayload(item.image_url) : null;
    return {
      type: item.type,
      fileId: item.file_id ?? undefined,
      mimeType: parsed?.mimeType ?? undefined,
      media: item.file_id
        ? "attached-file-id"
        : parsed
          ? "attached-inline-data"
          : item.image_url
            ? "attached-file-data"
            : undefined,
    };
  }
  const dataUrl = typeof item.file_url === "string" ? parseDataUrlPayload(item.file_url) : null;
  return {
    type: item.type,
    filename: item.filename ?? undefined,
    fileId: item.file_id ?? undefined,
    mimeType: dataUrl?.mimeType ?? inferToolOutputMimeTypeFromFilename(item.filename) ?? undefined,
    media: item.file_id
      ? "attached-file-id"
      : dataUrl || (typeof item.file_data === "string" && item.file_data.trim().length > 0)
        ? "attached-inline-data"
        : typeof item.file_url === "string" && item.file_url.trim().length > 0
          ? "attached-file-data"
          : undefined,
  };
}

function buildGeminiFunctionResponseParts(options: {
  toolName: string;
  callId?: string;
  outputPayload: unknown;
  defaultMediaResolution?: LlmMediaResolution;
}): GeminiPart[] {
  const outputItems = toGeminiToolOutputItems(options.outputPayload);
  if (!outputItems) {
    const responsePayload = isPlainRecord(options.outputPayload)
      ? (sanitiseLogValue(options.outputPayload) as Record<string, unknown>)
      : { output: sanitiseLogValue(options.outputPayload) };
    if (options.callId) {
      return [createPartFromFunctionResponse(options.callId, options.toolName, responsePayload)];
    }
    return [
      {
        functionResponse: {
          name: options.toolName,
          response: responsePayload,
        },
      },
    ];
  }

  const responseOutput = outputItems.map((item) => toGeminiToolOutputPlaceholder(item));
  const responseParts = outputItems.flatMap((item) => {
    const mediaPart = buildGeminiToolOutputMediaPart(item, {
      defaultMediaResolution: options.defaultMediaResolution,
    });
    return mediaPart ? [mediaPart] : [];
  });
  const responsePayload: Record<string, unknown> = { output: responseOutput };
  const functionResponsePart = options.callId
    ? createPartFromFunctionResponse(options.callId, options.toolName, responsePayload)
    : ({
        functionResponse: {
          name: options.toolName,
          response: responsePayload,
        },
      } satisfies GeminiPart);
  return [functionResponsePart, ...responseParts];
}

function parseOpenAiToolArguments(raw: string): { value: unknown; error?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: {} };
  }
  try {
    return { value: JSON.parse(trimmed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: raw, error: message };
  }
}

function formatZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  const messages: string[] = [];
  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "input";
    messages.push(`${path}: ${issue.message}`);
  }
  return messages.join("; ");
}

function buildToolErrorOutput(
  message: string,
  issues?: readonly z.core.$ZodIssue[],
): Record<string, unknown> {
  const output: Record<string, unknown> = { error: message };
  if (issues && issues.length > 0) {
    output.issues = issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
      code: issue.code,
    }));
  }
  return output;
}

const SUBAGENT_WAIT_TOOL_NAME = "wait";

function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function toToolResultDuration(result: LlmToolCallResult): number {
  return typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
    ? Math.max(0, result.durationMs)
    : 0;
}

function schedulerMetricsOrDefault(metrics: CallSchedulerRunMetrics | undefined): {
  queueWaitMs: number;
  schedulerDelayMs: number;
  providerRetryDelayMs: number;
  providerAttempts: number;
  modelCallStartedAtMs?: number;
} {
  if (!metrics) {
    return {
      queueWaitMs: 0,
      schedulerDelayMs: 0,
      providerRetryDelayMs: 0,
      providerAttempts: 1,
    };
  }
  return {
    queueWaitMs: Math.max(0, metrics.queueWaitMs),
    schedulerDelayMs: Math.max(0, metrics.schedulerDelayMs),
    providerRetryDelayMs: Math.max(0, metrics.retryDelayMs),
    providerAttempts: Math.max(1, metrics.attempts),
    modelCallStartedAtMs: metrics.startedAtMs,
  };
}

function buildStepTiming(params: {
  stepStartedAtMs: number;
  stepCompletedAtMs: number;
  modelCompletedAtMs: number;
  firstModelEventAtMs?: number;
  schedulerMetrics?: CallSchedulerRunMetrics;
  toolExecutionMs: number;
  waitToolMs: number;
}): LlmToolLoopStepTiming {
  const scheduler = schedulerMetricsOrDefault(params.schedulerMetrics);
  const modelCallStartedAtMs = scheduler.modelCallStartedAtMs ?? params.stepStartedAtMs;
  const firstModelEventAtMs = params.firstModelEventAtMs;
  const effectiveFirstEventAtMs =
    firstModelEventAtMs !== undefined
      ? Math.max(modelCallStartedAtMs, firstModelEventAtMs)
      : params.modelCompletedAtMs;
  const connectionSetupMs = Math.max(0, effectiveFirstEventAtMs - modelCallStartedAtMs);
  const activeGenerationMs = Math.max(0, params.modelCompletedAtMs - effectiveFirstEventAtMs);
  return {
    startedAt: toIsoTimestamp(params.stepStartedAtMs),
    completedAt: toIsoTimestamp(params.stepCompletedAtMs),
    totalMs: Math.max(0, params.stepCompletedAtMs - params.stepStartedAtMs),
    queueWaitMs: scheduler.queueWaitMs,
    connectionSetupMs,
    activeGenerationMs,
    toolExecutionMs: Math.max(0, params.toolExecutionMs),
    waitToolMs: Math.max(0, params.waitToolMs),
    schedulerDelayMs: scheduler.schedulerDelayMs,
    providerRetryDelayMs: scheduler.providerRetryDelayMs,
    providerAttempts: scheduler.providerAttempts,
  };
}

function extractSpawnStartupMetrics(outputPayload: unknown): Record<string, unknown> | undefined {
  if (!outputPayload || typeof outputPayload !== "object") {
    return undefined;
  }
  const outputRecord = outputPayload as Record<string, unknown>;
  const notification =
    typeof outputRecord.notification === "string" ? outputRecord.notification : "";
  if (notification !== "spawned") {
    return undefined;
  }
  const agent = outputRecord.agent;
  if (!agent || typeof agent !== "object") {
    return undefined;
  }
  const agentRecord = agent as Record<string, unknown>;
  const startupLatencyMs = agentRecord.spawn_startup_latency_ms;
  if (typeof startupLatencyMs !== "number" || !Number.isFinite(startupLatencyMs)) {
    return undefined;
  }
  return {
    spawnStartupLatencyMs: Math.max(0, startupLatencyMs),
  };
}

async function executeToolCall(params: {
  callKind: "function" | "custom";
  toolName: string;
  tool: LlmExecutableTool<z.ZodType, unknown> | undefined;
  rawInput: unknown;
  parseError?: string;
  provider?: LlmProvider;
}): Promise<{ result: LlmToolCallResult; outputPayload: unknown }> {
  const { callKind, toolName, tool, rawInput, parseError, provider } = params;
  const startedAtMs = Date.now();
  const finalize = (
    base: Omit<LlmToolCallResult, "startedAt" | "completedAt" | "durationMs" | "metrics">,
    outputPayload: unknown,
    metrics?: Record<string, unknown>,
  ): { result: LlmToolCallResult; outputPayload: unknown } => {
    const completedAtMs = Date.now();
    return {
      result: {
        ...base,
        startedAt: toIsoTimestamp(startedAtMs),
        completedAt: toIsoTimestamp(completedAtMs),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        ...(metrics ? { metrics } : {}),
      },
      outputPayload,
    };
  };
  if (!tool) {
    const message = `Unknown tool: ${toolName}`;
    const outputPayload = buildToolErrorOutput(message);
    return finalize(
      { toolName, input: rawInput, output: outputPayload, error: message },
      outputPayload,
    );
  }
  if (callKind === "custom") {
    if (!isCustomTool(tool)) {
      const message = `Tool ${toolName} was called as custom_tool_call but is declared as function.`;
      const outputPayload = buildToolErrorOutput(message);
      return finalize(
        { toolName, input: rawInput, output: outputPayload, error: message },
        outputPayload,
      );
    }
    const input = typeof rawInput === "string" ? rawInput : String(rawInput ?? "");
    try {
      const output = await tool.execute(input);
      const outputPayload = await maybeSpillToolOutput(output, toolName, { provider });
      const metrics =
        toolName === "spawn_agent" ? extractSpawnStartupMetrics(outputPayload) : undefined;
      return finalize({ toolName, input, output: outputPayload }, outputPayload, metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outputPayload = buildToolErrorOutput(`Tool ${toolName} failed: ${message}`);
      return finalize({ toolName, input, output: outputPayload, error: message }, outputPayload);
    }
  }
  if (isCustomTool(tool)) {
    const message = `Tool ${toolName} was called as function_call but is declared as custom.`;
    const outputPayload = buildToolErrorOutput(message);
    return finalize(
      { toolName, input: rawInput, output: outputPayload, error: message },
      outputPayload,
    );
  }
  if (parseError) {
    const message = `Invalid JSON for tool ${toolName}: ${parseError}`;
    const outputPayload = buildToolErrorOutput(message);
    return finalize(
      { toolName, input: rawInput, output: outputPayload, error: message },
      outputPayload,
    );
  }
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const message = `Invalid tool arguments for ${toolName}: ${formatZodIssues(parsed.error.issues)}`;
    const outputPayload = buildToolErrorOutput(message, parsed.error.issues);
    return finalize(
      { toolName, input: rawInput, output: outputPayload, error: message },
      outputPayload,
    );
  }
  try {
    const output = await tool.execute(parsed.data);
    const outputPayload = await maybeSpillToolOutput(output, toolName, { provider });
    const metrics =
      toolName === "spawn_agent" ? extractSpawnStartupMetrics(outputPayload) : undefined;
    return finalize(
      { toolName, input: parsed.data, output: outputPayload },
      outputPayload,
      metrics,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outputPayload = buildToolErrorOutput(`Tool ${toolName} failed: ${message}`);
    return finalize(
      { toolName, input: parsed.data, output: outputPayload, error: message },
      outputPayload,
    );
  }
}

function findTerminalToolCall(
  tools: LlmToolSet,
  toolCalls: readonly LlmToolCallResult[],
): LlmToolCallResult | null {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (!toolCall) {
      continue;
    }
    const toolDef = tools[toolCall.toolName];
    if (toolDef?.terminal === true && !toolCall.error) {
      return toolCall;
    }
  }
  return null;
}

function terminalToolCallText(toolCall: LlmToolCallResult): string {
  const output = toolCall.output;
  if (typeof output === "string") {
    return output;
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const summary = record.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary;
    }
    const status = record.status;
    const title = record.presentationTitle;
    if (typeof status === "string" && typeof title === "string" && title.trim().length > 0) {
      return `${status}: ${title}`;
    }
    if (typeof status === "string" && status.trim().length > 0) {
      return status;
    }
  }
  return "";
}

function buildToolLogId(turn: number, toolIndex: number): string {
  return `turn${turn.toString()}/tool${toolIndex.toString()}`;
}

function sanitizeChatGptToolId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/gu, "");
  if (cleaned.length === 0) {
    return randomBytes(8).toString("hex");
  }
  return cleaned.slice(0, 64);
}

function normalizeChatGptToolIds(params: {
  callKind: "function" | "custom";
  callId?: string;
  itemId?: string;
}): {
  callId: string;
  itemId: string;
} {
  let rawCallId = params.callId ?? "";
  let rawItemId = params.itemId ?? "";
  if (rawCallId.includes("|")) {
    const [nextCallId, nextItemId] = rawCallId.split("|");
    rawCallId = nextCallId ?? rawCallId;
    if (nextItemId) {
      rawItemId = nextItemId;
    }
  } else if (rawItemId.includes("|")) {
    const [nextCallId, nextItemId] = rawItemId.split("|");
    rawCallId = nextCallId ?? rawCallId;
    rawItemId = nextItemId ?? rawItemId;
  }
  const callValue = sanitizeChatGptToolId(rawCallId || rawItemId || randomBytes(8).toString("hex"));
  let itemValue = sanitizeChatGptToolId(rawItemId || callValue);
  if (params.callKind === "custom") {
    if (!itemValue.startsWith("ctc")) {
      itemValue = `ctc_${itemValue}`;
    }
  } else if (!itemValue.startsWith("fc")) {
    itemValue = `fc-${itemValue}`;
  }
  return { callId: callValue, itemId: itemValue };
}

function extractOpenAiResponseParts(response: { output?: unknown; output_text?: unknown }): {
  parts: LlmContentPart[];
  blocked: boolean;
} {
  const parts: LlmContentPart[] = [];
  let blocked = false;
  const output = response.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const itemType = (item as { type?: unknown }).type;
      if (itemType === "message") {
        const content = (item as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const entry of content) {
            if (!entry || typeof entry !== "object") {
              continue;
            }
            const entryType = (entry as { type?: unknown }).type;
            if (entryType === "output_text") {
              const text = (entry as { text?: unknown }).text;
              if (typeof text === "string" && text.length > 0) {
                parts.push({ type: "text", text });
              }
            } else if (entryType === "refusal") {
              blocked = true;
            }
          }
        }
      } else if (itemType === "reasoning") {
        const content = (item as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const entry of content) {
            if (!entry || typeof entry !== "object") {
              continue;
            }
            const entryType = (entry as { type?: unknown }).type;
            if (entryType === "reasoning_summary_text" || entryType === "reasoning_summary") {
              const entryText =
                typeof (entry as { text?: unknown }).text === "string"
                  ? (entry as { text?: unknown }).text
                  : typeof (entry as { summary?: unknown }).summary === "string"
                    ? (entry as { summary?: unknown }).summary
                    : undefined;
              if (typeof entryText === "string" && entryText.length > 0) {
                parts.push({ type: "text", text: entryText, thought: true });
              }
            }
          }
        }
      } else if (
        itemType === "function_call" ||
        itemType === "tool_call" ||
        itemType === "custom_tool_call"
      ) {
        const serialized = JSON.stringify(item, null, 2);
        if (serialized.length > 0) {
          parts.push({ type: "text", text: `[tool-call]\\n${serialized}\\n` });
        }
      }
    }
  }
  if (parts.length === 0) {
    const outputText = response.output_text;
    if (typeof outputText === "string" && outputText.length > 0) {
      parts.push({ type: "text", text: outputText });
    }
  }
  return { parts, blocked };
}

type OpenAiToolCall =
  | { kind: "function"; name: string; arguments: string; call_id: string; id?: string }
  | { kind: "custom"; name: string; input: string; call_id: string; id?: string };

function extractOpenAiToolCalls(output: unknown): OpenAiToolCall[] {
  const calls: OpenAiToolCall[] = [];
  if (!Array.isArray(output)) {
    return calls;
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemType = (item as { type?: unknown }).type;
    if (itemType === "function_call") {
      const name =
        typeof (item as { name?: unknown }).name === "string"
          ? ((item as { name?: unknown }).name as string)
          : "";
      const args =
        typeof (item as { arguments?: unknown }).arguments === "string"
          ? ((item as { arguments?: unknown }).arguments as string)
          : "";
      const call_id =
        typeof (item as { call_id?: unknown }).call_id === "string"
          ? ((item as { call_id?: unknown }).call_id as string)
          : "";
      const id =
        typeof (item as { id?: unknown }).id === "string"
          ? ((item as { id?: unknown }).id as string)
          : undefined;
      if (name && call_id) {
        calls.push({ kind: "function", name, arguments: args, call_id, id });
      }
      continue;
    }
    if (itemType === "custom_tool_call") {
      const name =
        typeof (item as { name?: unknown }).name === "string"
          ? ((item as { name?: unknown }).name as string)
          : "";
      const input =
        typeof (item as { input?: unknown }).input === "string"
          ? ((item as { input?: unknown }).input as string)
          : "";
      const call_id =
        typeof (item as { call_id?: unknown }).call_id === "string"
          ? ((item as { call_id?: unknown }).call_id as string)
          : "";
      const id =
        typeof (item as { id?: unknown }).id === "string"
          ? ((item as { id?: unknown }).id as string)
          : undefined;
      if (name && call_id) {
        calls.push({ kind: "custom", name, input, call_id, id });
      }
    }
  }
  return calls;
}

type FireworksFunctionToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

function extractFireworksMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content) {
    const textPart = (part as { text?: unknown }).text;
    if (typeof textPart === "string") {
      text += textPart;
    }
  }
  return text;
}

function extractFireworksToolCalls(message: unknown): FireworksFunctionToolCall[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const calls: FireworksFunctionToolCall[] = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") {
      continue;
    }
    const id =
      typeof (call as { id?: unknown }).id === "string" ? (call as { id?: string }).id : "";
    const fn = (call as { function?: unknown }).function;
    const name =
      fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string"
        ? ((fn as { name?: string }).name ?? "")
        : "";
    const args =
      fn && typeof fn === "object" && typeof (fn as { arguments?: unknown }).arguments === "string"
        ? ((fn as { arguments?: string }).arguments ?? "")
        : "";
    if (id && name) {
      calls.push({ id, name, arguments: args });
    }
  }
  return calls;
}
function toGeminiThinkingLevel(thinkingLevel: LlmThinkingLevel): ThinkingLevel {
  switch (thinkingLevel) {
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "high":
      return ThinkingLevel.HIGH;
  }
}

function resolveGeminiThinkingConfig(
  modelId: string,
  thinkingLevel?: LlmThinkingLevel,
): GenerateContentConfig["thinkingConfig"] {
  if (isGeminiImageModelId(modelId) || modelId === "gemini-flash-lite-latest") {
    return undefined;
  }
  if (thinkingLevel) {
    const thinkingBudget = resolveGeminiThinkingBudget(modelId, thinkingLevel);
    if (thinkingBudget !== undefined) {
      return {
        includeThoughts: true,
        thinkingBudget,
      } as const;
    }
    return {
      includeThoughts: true,
      thinkingLevel: toGeminiThinkingLevel(thinkingLevel),
    } as const;
  }
  switch (modelId) {
    case "gemini-3.1-pro-preview":
      return { includeThoughts: true } as const;
    case "gemini-3-flash-preview":
      return { includeThoughts: true, thinkingBudget: 16_384 } as const;
    case "gemini-2.5-pro":
      return { includeThoughts: true, thinkingBudget: 32_768 } as const;
    case "gemini-flash-latest":
    case "gemini-flash-lite-latest":
      return { includeThoughts: true, thinkingBudget: 24_576 } as const;
    default:
      return { includeThoughts: true } as const;
  }
}

function resolveGeminiThinkingBudget(
  modelId: string,
  thinkingLevel: LlmThinkingLevel,
): number | undefined {
  if (modelId === "gemini-2.5-pro") {
    switch (thinkingLevel) {
      case "low":
        return 256;
      case "medium":
        return 4096;
      case "high":
        return 32_768;
    }
  }
  if (modelId === "gemini-flash-latest") {
    switch (thinkingLevel) {
      case "low":
        return 256;
      case "medium":
        return 8192;
      case "high":
        return 24_576;
    }
  }
  if (modelId === "gemini-3-flash-preview") {
    switch (thinkingLevel) {
      case "low":
        return 256;
      case "medium":
        return 8192;
      case "high":
        return 16_384;
    }
  }
  return undefined;
}

function decodeInlineDataBuffer(base64: string): Buffer {
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return Buffer.from(base64, "base64url");
  }
}

function extractImages(content: LlmContent | undefined): LlmImageData[] {
  if (!content) {
    return [];
  }
  const images: LlmImageData[] = [];
  for (const part of content.parts) {
    if (part.type !== "inlineData") {
      continue;
    }
    const buffer = decodeInlineDataBuffer(part.data);
    images.push({ mimeType: part.mimeType, data: buffer });
  }
  return images;
}

function resolveAttachmentExtension(mimeType: string | undefined): string {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "application/pdf":
      return "pdf";
    case "application/json":
      return "json";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    default: {
      const slashIndex = normalized.indexOf("/");
      if (slashIndex >= 0) {
        const subtype = normalized.slice(slashIndex + 1).split("+")[0] ?? "";
        const cleaned = subtype.replace(/[^a-z0-9]+/giu, "");
        if (cleaned.length > 0) {
          return cleaned;
        }
      }
      return "bin";
    }
  }
}

function buildLoggedAttachmentFilename(
  prefix: "input" | "output",
  index: number,
  mimeType: string | undefined,
): string {
  return `${prefix}-${index.toString()}.${resolveAttachmentExtension(mimeType)}`;
}

function parseDataUrlPayload(value: string): {
  mimeType: string;
  dataBase64: string;
  bytes: Buffer;
} | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("data:")) {
    return null;
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const header = trimmed.slice(5, commaIndex);
  const payload = trimmed.slice(commaIndex + 1);
  const isBase64 = /;base64(?:;|$)/iu.test(header);
  const mimeType = (header.split(";")[0] ?? "application/octet-stream").trim().toLowerCase();
  try {
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return {
      mimeType,
      dataBase64: bytes.toString("base64"),
      bytes,
    };
  } catch {
    return null;
  }
}

function decodeDataUrlAttachment(
  value: string,
  options: {
    readonly prefix: "input" | "output";
    readonly index: number;
  },
): AgentLlmCallAttachment | null {
  const parsed = parseDataUrlPayload(value);
  if (!parsed) {
    return null;
  }
  return {
    filename: buildLoggedAttachmentFilename(options.prefix, options.index, parsed.mimeType),
    bytes: parsed.bytes,
  };
}

function collectPayloadAttachments(
  value: unknown,
  options: {
    readonly prefix: "input" | "output";
    readonly attachments: AgentLlmCallAttachment[];
    readonly seen: WeakSet<object>;
    counter: number;
  },
): void {
  if (typeof value === "string") {
    const attachment = decodeDataUrlAttachment(value, {
      prefix: options.prefix,
      index: options.counter,
    });
    if (attachment) {
      options.attachments.push(attachment);
      options.counter += 1;
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (options.seen.has(value)) {
    return;
  }
  options.seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPayloadAttachments(entry, options);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
  if (typeof record.data === "string" && mimeType) {
    try {
      options.attachments.push({
        filename: buildLoggedAttachmentFilename(options.prefix, options.counter, mimeType),
        bytes: decodeInlineDataBuffer(record.data),
      });
      options.counter += 1;
    } catch {
      // Ignore malformed inline-data payloads in logging only.
    }
  }
  for (const entry of Object.values(record)) {
    collectPayloadAttachments(entry, options);
  }
}

function serialiseRequestPayloadForLogging(value: unknown): string {
  try {
    return `${JSON.stringify(sanitiseLogValue(value), null, 2)}\n`;
  } catch {
    return `${String(value)}\n`;
  }
}

function serialiseLogArtifactText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      return undefined;
    }
    return value.endsWith("\n") ? value : `${value}\n`;
  }
  if (Array.isArray(value) && value.length === 0) {
    return undefined;
  }
  if (isPlainRecord(value) && Object.keys(value).length === 0) {
    return undefined;
  }
  try {
    return `${JSON.stringify(sanitiseLogValue(value), null, 2)}\n`;
  } catch {
    return `${String(value)}\n`;
  }
}

function collectLoggedAttachmentsFromLlmParts(
  parts: readonly LlmContentPart[],
  prefix: "input" | "output",
): AgentLlmCallAttachment[] {
  const attachments: AgentLlmCallAttachment[] = [];
  let index = 1;
  for (const part of parts) {
    if (part.type !== "inlineData") {
      continue;
    }
    attachments.push({
      filename: normaliseAttachmentFilename(
        part.filename,
        buildLoggedAttachmentFilename(prefix, index, part.mimeType),
      ),
      bytes: decodeInlineDataBuffer(part.data),
    });
    index += 1;
  }
  return attachments;
}

function collectLoggedAttachmentsFromGeminiParts(
  parts: readonly GeminiPart[],
  prefix: "input" | "output",
): AgentLlmCallAttachment[] {
  return collectLoggedAttachmentsFromLlmParts(convertGooglePartsToLlmParts(parts), prefix);
}

function extractToolCallResponseTextFromOpenAiInput(input: unknown): string | undefined {
  const responses = extractToolCallResponsePayloadFromOpenAiInput(input);
  return serialiseLogArtifactText(responses);
}

function extractToolCallResponsePayloadFromOpenAiInput(input: unknown): unknown[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const responses = input
    .filter((item): item is Record<string, unknown> => isPlainRecord(item))
    .flatMap((item) => {
      const type = typeof item.type === "string" ? item.type : "";
      if (type !== "function_call_output" && type !== "custom_tool_call_output") {
        return [];
      }
      return [
        {
          type,
          callId: typeof item.call_id === "string" ? item.call_id : undefined,
          output: "output" in item ? sanitiseLogValue(item.output) : undefined,
        },
      ];
    });
  return responses.length > 0 ? responses : undefined;
}

function extractToolCallResponseTextFromFireworksMessages(messages: unknown): string | undefined {
  const responses = extractToolCallResponsePayloadFromFireworksMessages(messages);
  return serialiseLogArtifactText(responses);
}

function extractToolCallResponsePayloadFromFireworksMessages(
  messages: unknown,
): unknown[] | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const responses = messages
    .filter((message): message is Record<string, unknown> => isPlainRecord(message))
    .flatMap((message) => {
      if (message.role !== "tool") {
        return [];
      }
      return [
        {
          toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
          content: sanitiseLogValue(message.content),
        },
      ];
    });
  return responses.length > 0 ? responses : undefined;
}

function extractToolCallResponseTextFromGeminiContents(contents: unknown): string | undefined {
  const responses = extractToolCallResponsePayloadFromGeminiContents(contents);
  return serialiseLogArtifactText(responses);
}

function extractToolCallResponsePayloadFromGeminiContents(
  contents: unknown,
): unknown[] | undefined {
  if (!Array.isArray(contents)) {
    return undefined;
  }
  const responses: unknown[] = [];
  for (const content of contents) {
    if (!content || typeof content !== "object") {
      continue;
    }
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const functionResponse = (part as { functionResponse?: unknown }).functionResponse;
      if (functionResponse) {
        responses.push(sanitiseLogValue(functionResponse));
      }
    }
  }
  return responses.length > 0 ? responses : undefined;
}

type LoggedOpenAiStyleToolCall =
  | { kind: "function"; name: string; arguments: string; callId?: string; itemId?: string }
  | { kind: "custom"; name: string; input: string; callId?: string; itemId?: string };

function toLoggedOpenAiStyleToolCalls(
  calls: readonly LoggedOpenAiStyleToolCall[],
): ReadonlyArray<Record<string, unknown>> {
  return calls.map((call) => {
    if (call.kind === "custom") {
      return {
        kind: call.kind,
        name: call.name,
        callId: call.callId,
        itemId: call.itemId,
        input: call.input,
      };
    }
    const { value, error } = parseOpenAiToolArguments(call.arguments);
    return {
      kind: call.kind,
      name: call.name,
      callId: call.callId,
      itemId: call.itemId,
      arguments: value,
      ...(error ? { parseError: error, rawArguments: call.arguments } : {}),
    };
  });
}

function toLoggedGeminiToolCalls(
  calls: ReadonlyArray<NonNullable<GeminiPart["functionCall"]>>,
): ReadonlyArray<Record<string, unknown>> {
  return calls.map((call) => ({
    name: call.name ?? "unknown",
    callId: typeof call.id === "string" ? call.id : undefined,
    arguments: sanitiseLogValue(call.args ?? {}),
  }));
}

function startLlmCallLoggerFromContents(options: {
  readonly provider: LlmProvider;
  readonly request: LlmTextRequest;
  readonly contents: readonly LlmContent[];
}): AgentLlmCallLogger | undefined {
  const session = getCurrentAgentLoggingSession();
  if (!session) {
    return undefined;
  }
  const attachments: AgentLlmCallAttachment[] = [];
  let attachmentIndex = 1;
  const sections: string[] = [];
  for (const [messageIndex, message] of options.contents.entries()) {
    sections.push(`### message_${(messageIndex + 1).toString()} role=${message.role}`);
    for (const part of message.parts) {
      if (part.type === "text") {
        const channel = part.thought === true ? "thought" : "response";
        sections.push(`[text:${channel}]`);
        sections.push(part.text);
        continue;
      }
      if (part.type === "inlineData") {
        const filename = buildLoggedAttachmentFilename("input", attachmentIndex, part.mimeType);
        attachments.push({
          filename,
          bytes: decodeInlineDataBuffer(part.data),
        });
        attachmentIndex += 1;
        sections.push(
          `[inlineData] file=${filename} mime=${part.mimeType ?? "application/octet-stream"} bytes=${attachments[attachments.length - 1]?.bytes.byteLength ?? 0}`,
        );
        continue;
      }
      sections.push(`[${part.type}] file_id=${"file_id" in part ? (part.file_id ?? "") : ""}`);
    }
    sections.push("");
  }

  return session.startLlmCall({
    provider: options.provider,
    modelId: options.request.model,
    requestText: sections.join("\n").trim(),
    requestMetadata: {
      model: options.request.model,
      input: options.contents.map((content) => ({
        role: content.role,
        parts: content.parts.map((part) => sanitisePartForLogging(part)),
      })),
      ...(options.request.instructions
        ? {
            instructions: options.request.instructions,
          }
        : {}),
      ...(options.request.tools ? { tools: options.request.tools } : {}),
      ...(options.request.responseMimeType
        ? {
            responseMimeType: options.request.responseMimeType,
          }
        : {}),
      ...(options.request.responseJsonSchema
        ? {
            responseJsonSchema: sanitiseLogValue(options.request.responseJsonSchema),
          }
        : {}),
      ...(options.request.responseModalities
        ? { responseModalities: options.request.responseModalities }
        : {}),
      ...(options.request.imageAspectRatio
        ? { imageAspectRatio: options.request.imageAspectRatio }
        : {}),
      ...(options.request.imageSize ? { imageSize: options.request.imageSize } : {}),
      ...(options.request.thinkingLevel ? { thinkingLevel: options.request.thinkingLevel } : {}),
      ...(options.request.mediaResolution
        ? { mediaResolution: options.request.mediaResolution }
        : {}),
      ...(options.request.openAiTextFormat
        ? { openAiTextFormat: sanitiseLogValue(options.request.openAiTextFormat) }
        : {}),
      ...(getCurrentToolCallContext() ? { toolContext: getCurrentToolCallContext() } : {}),
    },
    attachments,
  });
}

function startLlmCallLoggerFromPayload(options: {
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly requestPayload: unknown;
  readonly step: number;
}): AgentLlmCallLogger | undefined {
  const session = getCurrentAgentLoggingSession();
  if (!session) {
    return undefined;
  }
  const attachments: AgentLlmCallAttachment[] = [];
  collectPayloadAttachments(options.requestPayload, {
    prefix: "input",
    attachments,
    seen: new WeakSet<object>(),
    counter: 1,
  });
  const toolCallResponseText =
    options.provider === "openai" || options.provider === "chatgpt"
      ? extractToolCallResponseTextFromOpenAiInput(
          (options.requestPayload as { input?: unknown }).input,
        )
      : options.provider === "fireworks"
        ? extractToolCallResponseTextFromFireworksMessages(
            (options.requestPayload as { messages?: unknown }).messages,
          )
        : extractToolCallResponseTextFromGeminiContents(
            (options.requestPayload as { contents?: unknown }).contents,
          );
  const toolCallResponsePayload =
    options.provider === "openai" || options.provider === "chatgpt"
      ? extractToolCallResponsePayloadFromOpenAiInput(
          (options.requestPayload as { input?: unknown }).input,
        )
      : options.provider === "fireworks"
        ? extractToolCallResponsePayloadFromFireworksMessages(
            (options.requestPayload as { messages?: unknown }).messages,
          )
        : extractToolCallResponsePayloadFromGeminiContents(
            (options.requestPayload as { contents?: unknown }).contents,
          );
  return session.startLlmCall({
    provider: options.provider,
    modelId: options.modelId,
    requestText: serialiseRequestPayloadForLogging(options.requestPayload),
    requestMetadata: {
      step: options.step,
      ...(getCurrentToolCallContext() ? { toolContext: getCurrentToolCallContext() } : {}),
    },
    attachments,
    toolCallResponseText,
    toolCallResponsePayload,
  });
}

async function runTextCall(params: {
  request: LlmTextRequest;
  queue: AsyncQueue<LlmStreamEvent>;
  abortController: AbortController;
  onEvent?: (event: LlmStreamEvent) => void;
}): Promise<LlmTextResult> {
  const { request, queue, abortController } = params;
  const providerInfo = resolveProvider(request.model);
  const provider = providerInfo.provider;
  const modelForProvider = providerInfo.model;
  const contents = resolveTextContents(request);
  if (contents.length === 0) {
    throw new Error("LLM call received an empty prompt.");
  }
  const callLogger = startLlmCallLoggerFromContents({
    provider,
    request,
    contents,
  });

  let modelVersion: string = request.model;
  let blocked = false;
  let grounding: GroundingMetadata | undefined;
  const responseParts: LlmContentPart[] = [];
  let responseRole: LlmRole | undefined;
  let latestUsage: LlmUsageTokens | undefined;
  let responseImages = 0;
  let sawResponseDelta = false;
  let sawThoughtDelta = false;

  const pushEvent = (event: LlmStreamEvent): void => {
    queue.push(event);
    params.onEvent?.(event);
  };

  const pushDelta = (channel: "response" | "thought", text: string): void => {
    if (!text) {
      return;
    }
    responseParts.push({ type: "text", text, ...(channel === "thought" ? { thought: true } : {}) });
    if (channel === "thought") {
      sawThoughtDelta = true;
      callLogger?.appendThoughtDelta(text);
    } else {
      sawResponseDelta = true;
      callLogger?.appendResponseDelta(text);
    }
    pushEvent({ type: "delta", channel, text });
  };

  const pushInline = (data: string, mimeType: string | undefined): void => {
    if (!data) {
      return;
    }
    responseParts.push({ type: "inlineData", data, mimeType });
    if (isInlineImageMime(mimeType)) {
      responseImages += 1;
    }
  };

  const resolveAbortSignal = (): AbortSignal => {
    if (!request.signal) {
      return abortController.signal;
    }
    // Fan-in cancellation: abort if either signal aborts.
    if (request.signal.aborted) {
      abortController.abort(request.signal.reason);
    } else {
      request.signal.addEventListener(
        "abort",
        () => abortController.abort(request.signal?.reason),
        { once: true },
      );
    }
    return abortController.signal;
  };

  const signal = resolveAbortSignal();

  const { result } = await collectFileUploadMetrics(async () => {
    try {
      if (provider === "openai") {
        if (isOpenAiImageModelId(request.model)) {
          throw new Error("gpt-image-2 is an image generation model; use generateImages().");
        }
        const openAiInput = await maybePrepareOpenAiPromptInput(
          toOpenAiInput(contents, {
            defaultMediaResolution: request.mediaResolution,
            model: request.model,
          }),
          { model: request.model, provider: "openai" },
        );
        const openAiTools = toOpenAiTools(request.tools, { provider: "openai" });
        const reasoningEffort = resolveOpenAiReasoningEffort(
          modelForProvider,
          request.thinkingLevel,
        );
        const openAiTextConfig = {
          format: request.openAiTextFormat ?? { type: "text" },
          verbosity: resolveOpenAiVerbosity(modelForProvider),
        };
        const reasoning = {
          effort: toOpenAiReasoningEffort(reasoningEffort),
          summary: "detailed" as const,
        };

        await runOpenAiCall(async (client) => {
          const stream = client.responses.stream(
            {
              model: modelForProvider,
              input: openAiInput as any,
              ...(providerInfo.serviceTier ? { service_tier: providerInfo.serviceTier } : {}),
              reasoning,
              text: openAiTextConfig as any,
              ...(openAiTools ? { tools: openAiTools as any } : {}),
              include: ["code_interpreter_call.outputs", "reasoning.encrypted_content"] as any,
            },
            { signal } as any,
          );

          for await (const event of stream as any) {
            switch (event.type) {
              case "response.output_text.delta": {
                const delta = event.delta ?? "";
                pushDelta("response", typeof delta === "string" ? delta : "");
                break;
              }
              case "response.reasoning_summary_text.delta": {
                const delta = event.delta ?? "";
                pushDelta("thought", typeof delta === "string" ? delta : "");
                break;
              }
              case "response.refusal.delta": {
                blocked = true;
                pushEvent({ type: "blocked" });
                break;
              }
              default:
                break;
            }
          }

          const finalResponse = await (stream as any).finalResponse();
          modelVersion =
            typeof finalResponse.model === "string" ? finalResponse.model : request.model;
          pushEvent({ type: "model", modelVersion });
          if (finalResponse.error) {
            const message =
              typeof finalResponse.error.message === "string"
                ? finalResponse.error.message
                : "OpenAI response failed";
            throw new Error(message);
          }
          if (
            finalResponse.status &&
            finalResponse.status !== "completed" &&
            finalResponse.status !== "in_progress"
          ) {
            const detail = finalResponse.incomplete_details?.reason;
            throw new Error(
              `OpenAI response status ${finalResponse.status}${detail ? ` (${detail})` : ""}`,
            );
          }
          latestUsage = extractOpenAiUsageTokens(finalResponse.usage);

          // Fallback: if the stream did not deliver text deltas (rare), extract from final output.
          if (!sawResponseDelta || !sawThoughtDelta) {
            const needsResponseFallback = !sawResponseDelta;
            const needsThoughtFallback = !sawThoughtDelta;
            const fallback = extractOpenAiResponseParts(finalResponse);
            blocked = blocked || fallback.blocked;
            for (const part of fallback.parts) {
              if (part.type === "text") {
                const channel = part.thought === true ? "thought" : "response";
                if (
                  (channel === "response" && needsResponseFallback) ||
                  (channel === "thought" && needsThoughtFallback)
                ) {
                  pushDelta(channel, part.text);
                }
              } else if (part.type === "inlineData") {
                pushInline(part.data, part.mimeType);
              }
            }
          }
        }, modelForProvider);
      } else if (provider === "chatgpt") {
        const chatGptInput = toChatGptInput(contents, {
          defaultMediaResolution: request.mediaResolution,
          model: request.model,
        });
        const preparedChatGptInput = await maybePrepareOpenAiPromptInput(chatGptInput.input, {
          model: request.model,
          provider: "chatgpt",
        });
        const reasoningEffort = resolveOpenAiReasoningEffort(request.model, request.thinkingLevel);
        const openAiTools = toOpenAiTools(request.tools, { provider: "chatgpt" });
        const requestPayload = {
          model: modelForProvider,
          store: false,
          stream: true,
          ...(providerInfo.serviceTier ? { service_tier: providerInfo.serviceTier } : {}),
          instructions: chatGptInput.instructions ?? "You are a helpful assistant.",
          input: preparedChatGptInput,
          include: ["reasoning.encrypted_content"],
          reasoning: {
            effort: toOpenAiReasoningEffort(reasoningEffort),
            summary: "detailed" as const,
          },
          text: {
            format: request.openAiTextFormat ?? { type: "text" },
            verbosity: resolveOpenAiVerbosity(request.model),
          },
          ...(openAiTools ? { tools: openAiTools as any } : {}),
        };

        let sawResponseDelta = false;
        let sawThoughtDelta = false;
        const result = await collectChatGptCodexResponseWithRetry({
          request: requestPayload as any,
          signal,
          onDelta: (delta) => {
            if (delta.thoughtDelta) {
              sawThoughtDelta = true;
              pushDelta("thought", delta.thoughtDelta);
            }
            if (delta.textDelta) {
              sawResponseDelta = true;
              pushDelta("response", delta.textDelta);
            }
          },
        });

        blocked = blocked || result.blocked;
        if (blocked) {
          pushEvent({ type: "blocked" });
        }
        if (result.model) {
          modelVersion =
            providerInfo.serviceTier || isExperimentalChatGptModelId(request.model)
              ? request.model
              : `chatgpt-${result.model}`;
          pushEvent({ type: "model", modelVersion });
        }
        latestUsage = extractChatGptUsageTokens(result.usage);

        // Fallback for rare cases where the SSE stream does not emit deltas.
        const fallbackText = typeof result.text === "string" ? result.text : "";
        const fallbackThoughts =
          typeof result.reasoningSummaryText === "string" && result.reasoningSummaryText.length > 0
            ? result.reasoningSummaryText
            : typeof result.reasoningText === "string"
              ? result.reasoningText
              : "";
        if (!sawThoughtDelta && fallbackThoughts.length > 0) {
          pushDelta("thought", fallbackThoughts);
        }
        if (!sawResponseDelta && fallbackText.length > 0) {
          pushDelta("response", fallbackText);
        }
      } else if (provider === "fireworks") {
        if (request.tools && request.tools.length > 0) {
          throw new Error(
            "Fireworks provider does not support provider-native tools in generateText; use runToolLoop for function tools.",
          );
        }

        const fireworksMessages = toFireworksMessages(contents, {
          responseMimeType: request.responseMimeType,
          responseJsonSchema: request.responseJsonSchema,
        });

        await runFireworksCall(async (client) => {
          const responseFormat = request.responseJsonSchema
            ? {
                type: "json_schema" as const,
                json_schema: {
                  name: "llm-response",
                  schema: request.responseJsonSchema,
                },
              }
            : request.responseMimeType === "application/json"
              ? { type: "json_object" as const }
              : undefined;

          const response = await client.chat.completions.create(
            {
              model: modelForProvider,
              messages: fireworksMessages as any,
              ...(responseFormat ? { response_format: responseFormat } : {}),
            } as any,
            { signal } as any,
          );

          modelVersion = typeof response.model === "string" ? response.model : request.model;
          pushEvent({ type: "model", modelVersion });

          const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
          if (choice?.finish_reason === "content_filter") {
            blocked = true;
            pushEvent({ type: "blocked" });
          }

          const textOutput = extractFireworksMessageText(
            (choice as { message?: unknown } | undefined)?.message,
          );
          if (textOutput.length > 0) {
            pushDelta("response", textOutput);
          }

          latestUsage = extractFireworksUsageTokens(response.usage);
        }, modelForProvider);
      } else {
        const geminiContents = await maybePrepareGeminiPromptContents(
          contents.map((content) =>
            convertLlmContentToGeminiContent(content, {
              defaultMediaResolution: request.mediaResolution,
            }),
          ),
        );
        const thinkingConfig = resolveGeminiThinkingConfig(modelForProvider, request.thinkingLevel);
        const mediaResolution = toGeminiMediaResolution(request.mediaResolution);
        const config: GenerateContentConfig = {
          maxOutputTokens: 32_000,
          ...(thinkingConfig ? { thinkingConfig } : {}),
          ...(mediaResolution ? { mediaResolution } : {}),
          ...(request.responseMimeType ? { responseMimeType: request.responseMimeType } : {}),
          ...(request.responseJsonSchema ? { responseJsonSchema: request.responseJsonSchema } : {}),
          ...(request.responseModalities
            ? { responseModalities: Array.from(request.responseModalities) }
            : {}),
          ...(request.imageAspectRatio || request.imageSize
            ? {
                imageConfig: {
                  ...(request.imageAspectRatio ? { aspectRatio: request.imageAspectRatio } : {}),
                  ...(request.imageSize ? { imageSize: request.imageSize } : {}),
                },
              }
            : {}),
        };
        const geminiTools = toGeminiTools(request.tools);
        if (geminiTools) {
          config.tools = geminiTools;
        }

        await runGeminiCall(async (client) => {
          const stream = await client.models.generateContentStream({
            model: modelForProvider,
            contents: geminiContents,
            config,
          });
          let latestGrounding: GroundingMetadata | undefined;
          for await (const chunk of stream) {
            if (chunk.modelVersion) {
              modelVersion = chunk.modelVersion;
              pushEvent({ type: "model", modelVersion });
            }
            if (chunk.promptFeedback?.blockReason) {
              blocked = true;
              pushEvent({ type: "blocked" });
            }
            latestUsage = mergeTokenUpdates(
              latestUsage,
              extractGeminiUsageTokens(chunk.usageMetadata),
            );
            const candidates = chunk.candidates;
            if (!candidates || candidates.length === 0) {
              continue;
            }
            const primary = candidates[0];
            if (primary && isModerationFinish(primary.finishReason)) {
              blocked = true;
              pushEvent({ type: "blocked" });
            }
            for (const candidate of candidates) {
              const candidateContent = candidate.content;
              if (!candidateContent) {
                continue;
              }
              if (candidate.groundingMetadata) {
                latestGrounding = candidate.groundingMetadata;
              }
              const content = convertGeminiContentToLlmContent(candidateContent);
              if (!responseRole) {
                responseRole = content.role;
              }
              for (const part of content.parts) {
                if (part.type === "text") {
                  pushDelta(part.thought === true ? "thought" : "response", part.text);
                } else if (part.type === "inlineData") {
                  pushInline(part.data, part.mimeType);
                }
              }
            }
          }
          grounding = latestGrounding;
        }, modelForProvider);
      }

      const mergedParts = mergeConsecutiveTextParts(responseParts);
      const content =
        mergedParts.length > 0
          ? { role: responseRole ?? "assistant", parts: mergedParts }
          : undefined;
      const { text, thoughts } = extractTextByChannel(content);
      const outputAttachments = collectLoggedAttachmentsFromLlmParts(mergedParts, "output");

      const costUsd = estimateCallCostUsd({
        modelId: modelVersion,
        tokens: latestUsage,
        responseImages,
        imageSize: request.imageSize,
      });

      if (latestUsage) {
        pushEvent({ type: "usage", usage: latestUsage, costUsd, modelVersion });
      }

      callLogger?.complete({
        responseText: text,
        attachments: outputAttachments,
        metadata: {
          provider,
          model: request.model,
          modelVersion,
          blocked,
          costUsd,
          usage: latestUsage,
          grounding: grounding ? sanitiseLogValue(grounding) : undefined,
          responseChars: text.length,
          thoughtChars: thoughts.length,
          responseImages,
          uploads: getCurrentFileUploadMetrics(),
        },
      });

      return {
        provider,
        model: request.model,
        modelVersion,
        content,
        text,
        thoughts,
        blocked,
        usage: latestUsage,
        costUsd,
        grounding,
      };
    } catch (error) {
      const partialParts = mergeConsecutiveTextParts(responseParts);
      const partialContent =
        partialParts.length > 0
          ? { role: responseRole ?? "assistant", parts: partialParts }
          : undefined;
      const { text: partialText } = extractTextByChannel(partialContent);
      callLogger?.fail(error, {
        responseText: partialText,
        attachments: collectLoggedAttachmentsFromLlmParts(partialParts, "output"),
        metadata: {
          provider,
          model: request.model,
          modelVersion,
          blocked,
          usage: latestUsage,
          partialResponseParts: responseParts.length,
          responseImages,
          uploads: getCurrentFileUploadMetrics(),
        },
      });
      throw error;
    }
  });

  return result;
}

function startTextStream(
  request: LlmTextRequest,
  operation: "generateText" | "streamText",
): LlmTextStream {
  const queue = createAsyncQueue<LlmStreamEvent>();
  const abortController = new AbortController();
  const provider = resolveProvider(request.model).provider;
  const telemetry = createLlmTelemetryEmitter({
    telemetry: request.telemetry,
    operation,
    provider,
    model: request.model,
  });
  const startedAtMs = Date.now();

  telemetry.emit({
    type: "llm.call.started",
    inputMode: typeof request.input === "string" ? "string" : "messages",
    toolCount: request.tools?.length ?? 0,
    responseModalities: request.responseModalities,
  });

  const result = (async () => {
    let uploadMetrics = emptyFileUploadMetrics();
    try {
      let output: LlmTextResult | undefined;
      await collectFileUploadMetrics(async () => {
        try {
          output = await runTextCall({
            request,
            queue,
            abortController,
            onEvent: telemetry.includeStreamEvents
              ? (event) => {
                  telemetry.emit({ type: "llm.call.stream", event });
                }
              : undefined,
          });
        } finally {
          uploadMetrics = getCurrentFileUploadMetrics();
        }
      });
      if (!output) {
        throw new Error("LLM text call returned no result.");
      }
      telemetry.emit({
        type: "llm.call.completed",
        success: true,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        modelVersion: output.modelVersion,
        blocked: output.blocked,
        usage: output.usage,
        costUsd: output.costUsd,
        outputTextChars: output.text.length,
        thoughtChars: output.thoughts.length,
        responseImages: countInlineImagesInContent(output.content),
        uploadCount: uploadMetrics.count,
        uploadBytes: uploadMetrics.totalBytes,
        uploadLatencyMs: uploadMetrics.totalLatencyMs,
      });
      queue.close();
      return output;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      telemetry.emit({
        type: "llm.call.completed",
        success: false,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        uploadCount: uploadMetrics.count,
        uploadBytes: uploadMetrics.totalBytes,
        uploadLatencyMs: uploadMetrics.totalLatencyMs,
        error: err.message,
      });
      queue.fail(err);
      throw err;
    } finally {
      await telemetry.flush();
    }
  })();

  return {
    events: queue.iterable,
    result,
    abort: () => abortController.abort(),
  };
}

export function streamText(request: LlmTextRequest): LlmTextStream {
  return startTextStream(request, "streamText");
}

export async function generateText(request: LlmTextRequest): Promise<LlmTextResult> {
  const call = startTextStream(request, "generateText");
  // Drain events so the call runs even if the caller doesn't.
  for await (const _event of call.events) {
    // no-op
  }
  return await call.result;
}

function buildJsonSchemaConfig<T>(request: LlmJsonRequest<T>): {
  providerInfo: { provider: LlmProvider; model: string };
  responseJsonSchema: JsonSchema;
  openAiTextFormat?: ResponseTextConfig["format"];
} {
  const schemaName = (request.openAiSchemaName ?? "llm-response").trim() || "llm-response";
  const providerInfo = resolveProvider(request.model);
  const isOpenAiVariant = providerInfo.provider === "openai" || providerInfo.provider === "chatgpt";
  const isGeminiVariant = providerInfo.provider === "gemini";
  const baseJsonSchema = zodToJsonSchema(request.schema, {
    name: schemaName,
    target: isOpenAiVariant ? "openAi" : "jsonSchema7",
  }) as JsonSchema;

  const responseJsonSchema = isOpenAiVariant
    ? resolveOpenAiSchemaRoot(baseJsonSchema)
    : isGeminiVariant
      ? addGeminiPropertyOrdering(resolveOpenAiSchemaRoot(baseJsonSchema))
      : resolveOpenAiSchemaRoot(baseJsonSchema);

  if (isOpenAiVariant && !isJsonSchemaObject(responseJsonSchema)) {
    throw new Error("OpenAI structured outputs require a JSON object schema at the root.");
  }

  const openAiTextFormat = isOpenAiVariant
    ? {
        type: "json_schema" as const,
        name: schemaName,
        strict: true,
        schema: normalizeOpenAiSchema(responseJsonSchema),
      }
    : undefined;

  return { providerInfo, responseJsonSchema, openAiTextFormat };
}

function startJsonStream<T>(
  request: LlmJsonStreamRequest<T>,
  operation: "generateJson" | "streamJson",
): LlmJsonStream<T> {
  const queue = createAsyncQueue<LlmJsonStreamEvent<T>>();
  const abortController = new AbortController();
  const provider = resolveProvider(request.model).provider;
  const telemetry = createLlmTelemetryEmitter({
    telemetry: request.telemetry,
    operation,
    provider,
    model: request.model,
  });
  const startedAtMs = Date.now();
  const maxAttempts = Math.max(1, Math.floor(request.maxAttempts ?? 2));
  const streamMode = request.streamMode ?? "partial";

  telemetry.emit({
    type: "llm.call.started",
    inputMode: typeof request.input === "string" ? "string" : "messages",
    toolCount: request.tools?.length ?? 0,
    maxAttempts,
    streamMode,
  });

  const resolveAbortSignal = (): AbortSignal => {
    if (!request.signal) {
      return abortController.signal;
    }
    // Fan-in cancellation: abort if either signal aborts.
    if (request.signal.aborted) {
      abortController.abort(request.signal.reason);
    } else {
      request.signal.addEventListener(
        "abort",
        () => abortController.abort(request.signal?.reason),
        {
          once: true,
        },
      );
    }
    return abortController.signal;
  };

  const result = (async () => {
    let uploadMetrics = emptyFileUploadMetrics();
    let attemptsUsed = 0;
    try {
      let output:
        | {
            readonly value: T;
            readonly rawText: string;
            readonly result: LlmTextResult;
          }
        | undefined;
      await collectFileUploadMetrics(async () => {
        try {
          const signal = resolveAbortSignal();
          const { providerInfo, responseJsonSchema, openAiTextFormat } =
            buildJsonSchemaConfig(request);
          const failures: Array<{ attempt: number; rawText: string; error: unknown }> = [];
          let openAiTextFormatForAttempt: ResponseTextConfig["format"] | undefined =
            openAiTextFormat;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            attemptsUsed = attempt;
            let rawText = "";
            let lastPartial = "";
            try {
              const call = streamText({
                model: request.model,
                input: request.input,
                instructions: request.instructions,
                tools: request.tools,
                responseMimeType: request.responseMimeType ?? "application/json",
                responseJsonSchema,
                thinkingLevel: request.thinkingLevel,
                ...(openAiTextFormatForAttempt
                  ? { openAiTextFormat: openAiTextFormatForAttempt }
                  : {}),
                telemetry: false,
                signal,
              });

              try {
                for await (const event of call.events) {
                  queue.push(event);
                  if (telemetry.includeStreamEvents) {
                    telemetry.emit({ type: "llm.call.stream", event });
                  }
                  if (event.type === "delta" && event.channel === "response") {
                    rawText += event.text;
                    if (streamMode === "partial") {
                      const partial = parsePartialJsonFromLlmText(rawText);
                      if (partial !== null) {
                        const serialized = JSON.stringify(partial);
                        if (serialized !== lastPartial) {
                          lastPartial = serialized;
                          queue.push({
                            type: "json",
                            stage: "partial",
                            value: partial as DeepPartial<T>,
                          });
                        }
                      }
                    }
                  }
                }
              } catch (streamError) {
                // Ensure the rejected result promise is observed before we retry.
                await call.result.catch(() => undefined);
                throw streamError;
              }
              const result = await call.result;
              rawText = rawText || result.text;

              const cleanedText = normalizeJsonText(rawText);
              const repairedText = escapeNewlinesInStrings(cleanedText);
              const payload: unknown = JSON.parse(repairedText);
              const normalized =
                typeof request.normalizeJson === "function"
                  ? request.normalizeJson(payload)
                  : payload;
              const parsed = request.schema.parse(normalized);
              queue.push({ type: "json", stage: "final", value: parsed });
              output = { value: parsed, rawText, result };
              return;
            } catch (error) {
              const handled = error instanceof Error ? error : new Error(String(error));
              failures.push({ attempt, rawText, error: handled });
              if (providerInfo.provider === "chatgpt" && openAiTextFormatForAttempt) {
                // Best-effort fallback: some ChatGPT accounts/models may not support json_schema.
                openAiTextFormatForAttempt = undefined;
              }
              if (attempt >= maxAttempts) {
                throw new LlmJsonCallError(
                  `LLM JSON call failed after ${attempt} attempt(s)`,
                  failures,
                );
              }
            }
          }

          throw new LlmJsonCallError("LLM JSON call failed", failures);
        } finally {
          uploadMetrics = getCurrentFileUploadMetrics();
        }
      });
      if (!output) {
        throw new Error("LLM JSON call returned no result.");
      }
      telemetry.emit({
        type: "llm.call.completed",
        success: true,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        modelVersion: output.result.modelVersion,
        blocked: output.result.blocked,
        usage: output.result.usage,
        costUsd: output.result.costUsd,
        rawTextChars: output.rawText.length,
        attempts: attemptsUsed,
        uploadCount: uploadMetrics.count,
        uploadBytes: uploadMetrics.totalBytes,
        uploadLatencyMs: uploadMetrics.totalLatencyMs,
      });
      queue.close();
      return output;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      telemetry.emit({
        type: "llm.call.completed",
        success: false,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        attempts: attemptsUsed > 0 ? attemptsUsed : undefined,
        uploadCount: uploadMetrics.count,
        uploadBytes: uploadMetrics.totalBytes,
        uploadLatencyMs: uploadMetrics.totalLatencyMs,
        error: err.message,
      });
      queue.fail(err);
      throw err;
    } finally {
      await telemetry.flush();
    }
  })();

  return {
    events: queue.iterable,
    result,
    abort: () => abortController.abort(),
  };
}

export function streamJson<T>(request: LlmJsonStreamRequest<T>): LlmJsonStream<T> {
  return startJsonStream(request, "streamJson");
}

export async function generateJson<T>(request: LlmJsonRequest<T>): Promise<{
  readonly value: T;
  readonly rawText: string;
  readonly result: LlmTextResult;
}> {
  const call = startJsonStream(
    {
      ...request,
      streamMode: "final",
    },
    "generateJson",
  );
  try {
    for await (const event of call.events) {
      if (event.type !== "json") {
        request.onEvent?.(event);
      }
    }
  } catch (streamError) {
    await call.result.catch(() => undefined);
    throw streamError;
  }
  return await call.result;
}

// --- Tool Loop ---

const DEFAULT_TOOL_LOOP_MAX_STEPS = 8;

function resolveToolLoopContents(input: LlmInput): readonly LlmContent[] {
  return resolveTextContents(input);
}

type ToolLoopSteeringInternalState = {
  readonly drainPendingContents: () => readonly LlmContent[];
  readonly close: () => void;
};

const toolLoopSteeringInternals = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.toolLoopSteeringInternals"),
  () => new WeakMap<LlmToolLoopSteeringChannel, ToolLoopSteeringInternalState>(),
);

export function createToolLoopSteeringChannel(): LlmToolLoopSteeringChannel {
  const pending: LlmContent[] = [];
  let closed = false;

  const channel: LlmToolLoopSteeringChannel = {
    append: (input) => {
      if (closed) {
        return { accepted: false, queuedCount: pending.length };
      }
      const normalized = normalizeToolLoopSteeringInput(input);
      if (normalized.length === 0) {
        return { accepted: false, queuedCount: pending.length };
      }
      pending.push(...normalized);
      return { accepted: true, queuedCount: pending.length };
    },
    steer: (input) => channel.append(input),
    pendingCount: () => pending.length,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      pending.length = 0;
    },
  };

  const internalState: ToolLoopSteeringInternalState = {
    drainPendingContents: () => {
      if (pending.length === 0) {
        return [];
      }
      return pending.splice(0, pending.length);
    },
    close: channel.close,
  };
  toolLoopSteeringInternals.set(channel, internalState);
  return channel;
}

function resolveToolLoopSteeringInternal(
  steering: LlmToolLoopSteeringChannel | undefined,
): ToolLoopSteeringInternalState | undefined {
  if (!steering) {
    return undefined;
  }
  const internal = toolLoopSteeringInternals.get(steering);
  if (!internal) {
    throw new Error(
      "Invalid tool loop steering channel. Use createToolLoopSteeringChannel() to construct one.",
    );
  }
  return internal;
}

function normalizeToolLoopSteeringInput(input: LlmToolLoopSteeringInput): LlmContent[] {
  const messages =
    typeof input === "string"
      ? ([{ role: "user", content: input }] as const)
      : Array.isArray(input)
        ? input
        : [input];

  const normalized: LlmContent[] = [];
  for (const message of messages) {
    const role = message.role ?? "user";
    if (role !== "user") {
      throw new Error("Tool loop steering only accepts role='user' messages.");
    }
    if (typeof message.content === "string") {
      if (message.content.length === 0) {
        continue;
      }
      normalized.push({
        role: "user",
        parts: [{ type: "text", text: message.content }],
      });
      continue;
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      continue;
    }
    const parts: LlmContentPart[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else {
        parts.push({
          type: "inlineData",
          data: part.data,
          mimeType: part.mimeType,
          filename: part.filename,
        });
      }
    }
    if (parts.length > 0) {
      normalized.push({ role: "user", parts });
    }
  }
  return normalized;
}

function toChatGptAssistantMessage(text: string): ChatGptInputItem | undefined {
  if (!text) {
    return undefined;
  }
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function isCustomTool(
  toolDef: LlmExecutableTool<z.ZodType, unknown>,
): toolDef is LlmCustomTool<unknown> {
  return (toolDef as { type?: unknown }).type === "custom";
}

function buildOpenAiToolsFromToolSet(tools: LlmToolSet): unknown[] {
  const toolEntries = Object.entries(tools);
  return toolEntries.map(([name, toolDef]) => {
    if (isCustomTool(toolDef)) {
      return {
        type: "custom",
        name,
        description: toolDef.description ?? undefined,
        ...(toolDef.format ? { format: toolDef.format } : {}),
      };
    }
    return {
      type: "function",
      name,
      description: toolDef.description ?? undefined,
      parameters: buildOpenAiToolSchema(toolDef.inputSchema, name),
      strict: true,
    };
  });
}

function buildFireworksToolsFromToolSet(tools: LlmToolSet): unknown[] {
  const toolEntries = Object.entries(tools);
  return toolEntries.map(([name, toolDef]) => {
    if (isCustomTool(toolDef)) {
      throw new Error(
        `Fireworks provider does not support custom/freeform tools (${name}). Use JSON function tools instead.`,
      );
    }
    return {
      type: "function",
      function: {
        name,
        description: toolDef.description ?? undefined,
        parameters: buildOpenAiToolSchema(toolDef.inputSchema, name),
      },
    };
  });
}
function buildOpenAiToolSchema(schema: z.ZodType, name: string): JsonSchema {
  const rawSchema = zodToJsonSchema(schema, { name, target: "openAi" }) as JsonSchema;
  const normalized = normalizeOpenAiSchema(resolveOpenAiSchemaRoot(rawSchema));
  if (!isJsonSchemaObject(normalized)) {
    throw new Error(`OpenAI tool schema for ${name} must be a JSON object at the root.`);
  }
  return normalized;
}

function buildGeminiFunctionDeclarations(tools: LlmToolSet): GeminiTool[] {
  const toolEntries = Object.entries(tools);
  const functionDeclarations = toolEntries.map(([name, toolDef]) => {
    if (isCustomTool(toolDef)) {
      throw new Error(
        `Gemini provider does not support custom/freeform tools (${name}). Use JSON function tools instead.`,
      );
    }
    return {
      name,
      description: toolDef.description ?? "",
      parametersJsonSchema: buildGeminiToolSchema(toolDef.inputSchema, name),
    };
  });
  return [{ functionDeclarations }];
}

function buildGeminiToolSchema(schema: z.ZodType, name: string): JsonSchema {
  const jsonSchema = toGeminiJsonSchema(schema, { name });
  if (!isJsonSchemaObject(jsonSchema)) {
    throw new Error(`Gemini tool schema for ${name} must be a JSON object at the root.`);
  }
  return jsonSchema;
}

function extractOpenAiReasoningSummary(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  let summary = "";
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if ((item as { type?: unknown }).type !== "reasoning") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const entryType = (entry as { type?: unknown }).type;
      if (entryType === "reasoning_summary_text") {
        const text = (entry as { text?: unknown }).text;
        if (typeof text === "string") {
          summary += text;
        }
      }
    }
  }
  return summary;
}

export async function runToolLoop(request: LlmToolLoopRequest): Promise<LlmToolLoopResult> {
  const toolEntries = Object.entries(request.tools);
  if (toolEntries.length === 0) {
    throw new Error("Tool loop requires at least one tool definition.");
  }

  const contents = resolveToolLoopContents(request);
  if (contents.length === 0) {
    throw new Error("Tool loop prompt must not be empty.");
  }

  const maxSteps = Math.max(1, Math.floor(request.maxSteps ?? DEFAULT_TOOL_LOOP_MAX_STEPS));
  const providerInfo = resolveProvider(request.model);
  const steeringInternal = resolveToolLoopSteeringInternal(request.steering);

  const steps: LlmToolLoopStep[] = [];
  let totalCostUsd = 0;
  let finalText = "";
  let finalThoughts = "";

  try {
    if (providerInfo.provider === "openai") {
      const openAiAgentTools = buildOpenAiToolsFromToolSet(request.tools);
      const openAiNativeTools = toOpenAiTools(request.modelTools, { provider: "openai" });
      const openAiTools = openAiNativeTools
        ? [...openAiNativeTools, ...openAiAgentTools]
        : [...openAiAgentTools];
      const reasoningEffort = resolveOpenAiReasoningEffort(
        providerInfo.model,
        request.thinkingLevel,
      );
      const textConfig = {
        format: { type: "text" },
        verbosity: resolveOpenAiVerbosity(providerInfo.model),
      };
      const reasoning = {
        effort: toOpenAiReasoningEffort(reasoningEffort),
        summary: "detailed" as const,
      };

      let previousResponseId: string | undefined;
      let input: any = toOpenAiInput(contents, {
        defaultMediaResolution: request.mediaResolution,
        model: request.model,
      });

      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
        const turn = stepIndex + 1;
        const stepStartedAtMs = Date.now();
        let firstModelEventAtMs: number | undefined;
        let schedulerMetrics: CallSchedulerRunMetrics | undefined;
        const abortController = new AbortController();
        if (request.signal) {
          if (request.signal.aborted) {
            abortController.abort(request.signal.reason);
          } else {
            request.signal.addEventListener(
              "abort",
              () => abortController.abort(request.signal?.reason),
              { once: true },
            );
          }
        }

        const onEvent = request.onEvent;
        let modelVersion: string = request.model;
        let usageTokens: LlmUsageTokens | undefined;
        let thoughtDeltaEmitted = false;
        let blocked = false;
        let responseText = "";
        let reasoningSummary = "";
        let stepToolCallText: string | undefined;
        let stepToolCallPayload: ReadonlyArray<Record<string, unknown>> | undefined;
        const preparedInput = await maybePrepareOpenAiPromptInput(input, {
          model: request.model,
          provider: "openai",
        });
        const stepRequestPayload = {
          model: providerInfo.model,
          input: preparedInput,
          ...(providerInfo.serviceTier ? { service_tier: providerInfo.serviceTier } : {}),
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
          ...(openAiTools.length > 0 ? { parallel_tool_calls: true } : {}),
          reasoning,
          text: textConfig,
          include: ["reasoning.encrypted_content"],
        };
        const stepCallLogger = startLlmCallLoggerFromPayload({
          provider: "openai",
          modelId: request.model,
          requestPayload: stepRequestPayload,
          step: turn,
        });

        const emitEvent = (ev: LlmStreamEvent) => {
          onEvent?.(ev);
        };

        const markFirstModelEvent = () => {
          if (firstModelEventAtMs === undefined) {
            firstModelEventAtMs = Date.now();
          }
        };

        try {
          const finalResponse = await runOpenAiCall(
            async (client) => {
              const stream = client.responses.stream(
                {
                  model: providerInfo.model,
                  input: preparedInput as any,
                  ...(providerInfo.serviceTier ? { service_tier: providerInfo.serviceTier } : {}),
                  ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
                  ...(openAiTools.length > 0 ? { tools: openAiTools as any } : {}),
                  ...(openAiTools.length > 0 ? { parallel_tool_calls: true } : {}),
                  reasoning,
                  text: textConfig as any,
                  include: ["reasoning.encrypted_content"] as any,
                },
                { signal: abortController.signal } as any,
              );

              for await (const event of stream as any) {
                markFirstModelEvent();
                switch (event.type) {
                  case "response.output_text.delta": {
                    const text = typeof event.delta === "string" ? event.delta : "";
                    if (text.length > 0) {
                      stepCallLogger?.appendResponseDelta(text);
                    }
                    emitEvent({
                      type: "delta",
                      channel: "response",
                      text,
                    });
                    break;
                  }
                  case "response.reasoning_summary_text.delta": {
                    thoughtDeltaEmitted = true;
                    const text = typeof event.delta === "string" ? event.delta : "";
                    if (text.length > 0) {
                      stepCallLogger?.appendThoughtDelta(text);
                    }
                    emitEvent({
                      type: "delta",
                      channel: "thought",
                      text,
                    });
                    break;
                  }
                  case "response.refusal.delta":
                    blocked = true;
                    emitEvent({ type: "blocked" });
                    break;
                  default:
                    break;
                }
              }
              return await (stream as any).finalResponse();
            },
            providerInfo.model,
            {
              onSettled: (metrics) => {
                schedulerMetrics = metrics;
              },
            },
          );

          modelVersion =
            typeof (finalResponse as any).model === "string"
              ? (finalResponse as any).model
              : request.model;
          emitEvent({ type: "model", modelVersion });
          if ((finalResponse as any).error) {
            const message =
              typeof (finalResponse as any).error.message === "string"
                ? (finalResponse as any).error.message
                : "OpenAI response failed";
            throw new Error(message);
          }
          usageTokens = extractOpenAiUsageTokens((finalResponse as any).usage);

          responseText = extractOpenAiResponseParts(finalResponse)
            .parts.filter((p) => p.type === "text" && p.thought !== true)
            .map((p) => (p as any).text as string)
            .join("")
            .trim();
          reasoningSummary = extractOpenAiReasoningSummary(finalResponse).trim();
          if (!thoughtDeltaEmitted && reasoningSummary.length > 0) {
            stepCallLogger?.appendThoughtDelta(reasoningSummary);
            emitEvent({ type: "delta", channel: "thought", text: reasoningSummary });
          }
          const modelCompletedAtMs = Date.now();

          const stepCostUsd = estimateCallCostUsd({
            modelId: modelVersion,
            tokens: usageTokens,
            responseImages: 0,
          });
          totalCostUsd += stepCostUsd;

          if (usageTokens) {
            emitEvent({ type: "usage", usage: usageTokens, costUsd: stepCostUsd, modelVersion });
          }

          const responseToolCalls = extractOpenAiToolCalls((finalResponse as any).output);
          stepToolCallPayload = toLoggedOpenAiStyleToolCalls(
            responseToolCalls.map((call) =>
              call.kind === "custom"
                ? {
                    kind: call.kind,
                    name: call.name,
                    input: call.input,
                    callId: call.call_id,
                    itemId: call.id,
                  }
                : {
                    kind: call.kind,
                    name: call.name,
                    arguments: call.arguments,
                    callId: call.call_id,
                    itemId: call.id,
                  },
            ),
          );
          stepToolCallText = serialiseLogArtifactText(stepToolCallPayload);

          const stepToolCalls: LlmToolCallResult[] = [];
          if (responseToolCalls.length === 0) {
            const steeringInput = steeringInternal?.drainPendingContents() ?? [];
            const steeringItems =
              steeringInput.length > 0
                ? toOpenAiInput(steeringInput, {
                    defaultMediaResolution: request.mediaResolution,
                    model: request.model,
                  })
                : [];
            finalText = responseText;
            finalThoughts = reasoningSummary;
            const stepCompletedAtMs = Date.now();
            const timing = buildStepTiming({
              stepStartedAtMs,
              stepCompletedAtMs,
              modelCompletedAtMs,
              firstModelEventAtMs,
              schedulerMetrics,
              toolExecutionMs: 0,
              waitToolMs: 0,
            });
            steps.push({
              step: steps.length + 1,
              modelVersion,
              text: responseText || undefined,
              thoughts: reasoningSummary || undefined,
              toolCalls: [],
              usage: usageTokens,
              costUsd: stepCostUsd,
              timing,
            });
            stepCallLogger?.complete({
              responseText,
              metadata: {
                provider: "openai",
                model: request.model,
                modelVersion,
                step: turn,
                usage: usageTokens,
                costUsd: stepCostUsd,
                blocked,
                responseChars: responseText.length,
                thoughtChars: reasoningSummary.length,
                toolCalls: 0,
                finalStep: steeringItems.length === 0,
              },
            });
            if (steeringItems.length === 0) {
              return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
            }
            previousResponseId = (finalResponse as any).id;
            input = steeringItems;
            continue;
          }

          const callInputs = responseToolCalls.map((call, index) => {
            const toolIndex = index + 1;
            const toolId = buildToolLogId(turn, toolIndex);
            const toolName = call.name;
            if (call.kind === "custom") {
              return {
                call,
                toolName,
                value: call.input,
                parseError: undefined,
                toolId,
                turn,
                toolIndex,
              };
            }
            const { value, error: parseError } = parseOpenAiToolArguments(call.arguments);
            return { call, toolName, value, parseError, toolId, turn, toolIndex };
          });

          for (const entry of callInputs) {
            emitEvent({
              type: "tool_call",
              phase: "started",
              turn: entry.turn,
              toolIndex: entry.toolIndex,
              toolName: entry.toolName,
              toolId: entry.toolId,
              callKind: entry.call.kind,
              callId: entry.call.call_id,
              input: entry.value,
            });
          }

          const callResults = await maybeSpillCombinedToolCallOutputs(
            await Promise.all(
              callInputs.map(async (entry) => {
                return await toolCallContextStorage.run(
                  {
                    toolName: entry.toolName,
                    toolId: entry.toolId,
                    turn: entry.turn,
                    toolIndex: entry.toolIndex,
                  },
                  async () => {
                    const { result, outputPayload } = await executeToolCall({
                      callKind: entry.call.kind,
                      toolName: entry.toolName,
                      tool: request.tools[entry.toolName],
                      rawInput: entry.value,
                      parseError: entry.parseError,
                      provider: providerInfo.provider,
                    });
                    return { entry, result, outputPayload };
                  },
                );
              }),
            ),
            { provider: providerInfo.provider },
          );

          const toolOutputs: any[] = [];
          let toolExecutionMs = 0;
          let waitToolMs = 0;
          for (const { entry, result, outputPayload } of callResults) {
            stepToolCalls.push({ ...result, callId: entry.call.call_id });
            const callDurationMs = toToolResultDuration(result);
            toolExecutionMs += callDurationMs;
            if (entry.toolName.toLowerCase() === SUBAGENT_WAIT_TOOL_NAME) {
              waitToolMs += callDurationMs;
            }
            emitEvent({
              type: "tool_call",
              phase: "completed",
              turn: entry.turn,
              toolIndex: entry.toolIndex,
              toolName: entry.toolName,
              toolId: entry.toolId,
              callKind: entry.call.kind,
              callId: entry.call.call_id,
              input: entry.value,
              output: result.output,
              error: result.error,
              durationMs: result.durationMs,
            });
            if (entry.call.kind === "custom") {
              toolOutputs.push({
                type: "custom_tool_call_output",
                call_id: entry.call.call_id,
                output: toOpenAiToolOutput(outputPayload, {
                  defaultMediaResolution: request.mediaResolution,
                  model: request.model,
                }),
              });
            } else {
              toolOutputs.push({
                type: "function_call_output",
                call_id: entry.call.call_id,
                output: toOpenAiToolOutput(outputPayload, {
                  defaultMediaResolution: request.mediaResolution,
                  model: request.model,
                }),
              });
            }
          }

          const stepCompletedAtMs = Date.now();
          const timing = buildStepTiming({
            stepStartedAtMs,
            stepCompletedAtMs,
            modelCompletedAtMs,
            firstModelEventAtMs,
            schedulerMetrics,
            toolExecutionMs,
            waitToolMs,
          });
          steps.push({
            step: steps.length + 1,
            modelVersion,
            text: responseText || undefined,
            thoughts: reasoningSummary || undefined,
            toolCalls: stepToolCalls,
            usage: usageTokens,
            costUsd: stepCostUsd,
            timing,
          });
          const terminalToolCall = findTerminalToolCall(request.tools, stepToolCalls);

          const steeringInput = steeringInternal?.drainPendingContents() ?? [];
          const steeringItems =
            steeringInput.length > 0
              ? toOpenAiInput(steeringInput, {
                  defaultMediaResolution: request.mediaResolution,
                  model: request.model,
                })
              : [];
          stepCallLogger?.complete({
            responseText,
            toolCallText: stepToolCallText,
            toolCallPayload: stepToolCallPayload,
            metadata: {
              provider: "openai",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
              costUsd: stepCostUsd,
              blocked,
              responseChars: responseText.length,
              thoughtChars: reasoningSummary.length,
              toolCalls: stepToolCalls.length,
              finalStep: terminalToolCall !== null,
            },
          });
          if (terminalToolCall) {
            finalText = terminalToolCallText(terminalToolCall) || responseText;
            finalThoughts = reasoningSummary;
            return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
          }
          previousResponseId = (finalResponse as any).id;
          input = steeringItems.length > 0 ? toolOutputs.concat(steeringItems) : toolOutputs;
        } catch (error) {
          stepCallLogger?.fail(error, {
            responseText,
            toolCallText: stepToolCallText,
            toolCallPayload: stepToolCallPayload,
            metadata: {
              provider: "openai",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
              blocked,
            },
          });
          throw error;
        }
      }

      throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
    }

    if (providerInfo.provider === "chatgpt") {
      const openAiAgentTools = buildOpenAiToolsFromToolSet(request.tools);
      const openAiNativeTools = toOpenAiTools(request.modelTools, { provider: "chatgpt" });
      const openAiTools = openAiNativeTools
        ? [...openAiNativeTools, ...openAiAgentTools]
        : [...openAiAgentTools];

      const reasoningEffort = resolveOpenAiReasoningEffort(request.model, request.thinkingLevel);
      const toolLoopInput = toChatGptInput(contents, {
        defaultMediaResolution: request.mediaResolution,
        model: request.model,
      });
      // ChatGPT Codex prompt caching is keyed by both prompt_cache_key and session_id.
      const conversationId = `tool-loop-${randomBytes(8).toString("hex")}`;
      const promptCacheKey = conversationId;
      let input: ChatGptInputItem[] = [...toolLoopInput.input];

      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
        const turn = stepIndex + 1;
        const stepStartedAtMs = Date.now();
        let firstModelEventAtMs: number | undefined;
        let thoughtDeltaEmitted = false;
        let sawResponseDelta = false;
        let modelVersion: string = request.model;
        let usageTokens: LlmUsageTokens | undefined;
        let responseText = "";
        let reasoningSummaryText = "";
        let stepToolCallText: string | undefined;
        let stepToolCallPayload: ReadonlyArray<Record<string, unknown>> | undefined;
        const preparedInput = await maybePrepareOpenAiPromptInput(input, {
          model: request.model,
          provider: "chatgpt",
        });
        const markFirstModelEvent = () => {
          if (firstModelEventAtMs === undefined) {
            firstModelEventAtMs = Date.now();
          }
        };
        const stepRequestPayload = {
          model: providerInfo.model,
          store: false,
          stream: true,
          ...(providerInfo.serviceTier ? { service_tier: providerInfo.serviceTier } : {}),
          instructions: toolLoopInput.instructions ?? "You are a helpful assistant.",
          input: preparedInput,
          prompt_cache_key: promptCacheKey,
          include: ["reasoning.encrypted_content"],
          tools: openAiTools,
          tool_choice: "auto" as const,
          parallel_tool_calls: true,
          reasoning: {
            effort: toOpenAiReasoningEffort(reasoningEffort),
            summary: "detailed" as const,
          },
          text: { verbosity: resolveOpenAiVerbosity(request.model) },
        };
        const stepCallLogger = startLlmCallLoggerFromPayload({
          provider: "chatgpt",
          modelId: request.model,
          requestPayload: stepRequestPayload,
          step: turn,
        });
        try {
          const response = await collectChatGptCodexResponseWithRetry({
            sessionId: conversationId,
            request: stepRequestPayload as any,
            signal: request.signal,
            onDelta: (delta) => {
              if (delta.thoughtDelta) {
                markFirstModelEvent();
                thoughtDeltaEmitted = true;
                stepCallLogger?.appendThoughtDelta(delta.thoughtDelta);
                request.onEvent?.({ type: "delta", channel: "thought", text: delta.thoughtDelta });
              }
              if (delta.textDelta) {
                markFirstModelEvent();
                sawResponseDelta = true;
                stepCallLogger?.appendResponseDelta(delta.textDelta);
                request.onEvent?.({ type: "delta", channel: "response", text: delta.textDelta });
              }
            },
          });
          const modelCompletedAtMs = Date.now();

          modelVersion =
            response.model &&
            !providerInfo.serviceTier &&
            !isExperimentalChatGptModelId(request.model)
              ? `chatgpt-${response.model}`
              : request.model;
          usageTokens = extractChatGptUsageTokens(response.usage);
          const stepCostUsd = estimateCallCostUsd({
            modelId: modelVersion,
            tokens: usageTokens,
            responseImages: 0,
          });
          totalCostUsd += stepCostUsd;

          responseText = (response.text ?? "").trim();
          reasoningSummaryText = (response.reasoningSummaryText ?? "").trim();
          if (!thoughtDeltaEmitted && reasoningSummaryText.length > 0) {
            stepCallLogger?.appendThoughtDelta(reasoningSummaryText);
            request.onEvent?.({ type: "delta", channel: "thought", text: reasoningSummaryText });
          }
          if (!sawResponseDelta && responseText.length > 0) {
            stepCallLogger?.appendResponseDelta(responseText);
          }

          const responseToolCalls = response.toolCalls ?? [];
          stepToolCallPayload = toLoggedOpenAiStyleToolCalls(
            responseToolCalls.map((call) =>
              call.kind === "custom"
                ? {
                    kind: call.kind,
                    name: call.name,
                    input: call.input,
                    callId: call.callId,
                    itemId: call.id,
                  }
                : {
                    kind: call.kind,
                    name: call.name,
                    arguments: call.arguments,
                    callId: call.callId,
                    itemId: call.id,
                  },
            ),
          );
          stepToolCallText = serialiseLogArtifactText(stepToolCallPayload);
          if (responseToolCalls.length === 0) {
            const steeringInput = steeringInternal?.drainPendingContents() ?? [];
            const steeringItems =
              steeringInput.length > 0
                ? toChatGptInput(steeringInput, {
                    defaultMediaResolution: request.mediaResolution,
                    model: request.model,
                  }).input
                : [];
            finalText = responseText;
            finalThoughts = reasoningSummaryText;
            const stepCompletedAtMs = Date.now();
            const timing = buildStepTiming({
              stepStartedAtMs,
              stepCompletedAtMs,
              modelCompletedAtMs,
              firstModelEventAtMs,
              toolExecutionMs: 0,
              waitToolMs: 0,
            });
            steps.push({
              step: steps.length + 1,
              modelVersion,
              text: responseText || undefined,
              thoughts: reasoningSummaryText || undefined,
              toolCalls: [],
              usage: usageTokens,
              costUsd: stepCostUsd,
              timing,
            });
            stepCallLogger?.complete({
              responseText,
              metadata: {
                provider: "chatgpt",
                model: request.model,
                modelVersion,
                step: turn,
                usage: usageTokens,
                costUsd: stepCostUsd,
                responseChars: responseText.length,
                thoughtChars: reasoningSummaryText.length,
                toolCalls: 0,
                finalStep: steeringItems.length === 0,
              },
            });
            if (steeringItems.length === 0) {
              return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
            }
            const assistantItem = toChatGptAssistantMessage(responseText);
            input = assistantItem
              ? input.concat(assistantItem, steeringItems)
              : input.concat(steeringItems);
            continue;
          }

          const toolCalls: LlmToolCallResult[] = [];
          const toolOutputs: ChatGptInputItem[] = [];
          const callInputs = responseToolCalls.map((call, index) => {
            const toolIndex = index + 1;
            const toolId = buildToolLogId(turn, toolIndex);
            const toolName = call.name;
            const { value, error: parseError } =
              call.kind === "custom"
                ? { value: call.input, error: undefined }
                : parseOpenAiToolArguments(call.arguments);
            const ids = normalizeChatGptToolIds({
              callKind: call.kind,
              callId: call.callId,
              itemId: call.id,
            });
            return { call, toolName, value, parseError, ids, toolId, turn, toolIndex };
          });

          for (const entry of callInputs) {
            request.onEvent?.({
              type: "tool_call",
              phase: "started",
              turn: entry.turn,
              toolIndex: entry.toolIndex,
              toolName: entry.toolName,
              toolId: entry.toolId,
              callKind: entry.call.kind,
              callId: entry.ids.callId,
              input: entry.value,
            });
          }

          const callResults = await maybeSpillCombinedToolCallOutputs(
            await Promise.all(
              callInputs.map(async (entry) => {
                return await toolCallContextStorage.run(
                  {
                    toolName: entry.toolName,
                    toolId: entry.toolId,
                    turn: entry.turn,
                    toolIndex: entry.toolIndex,
                  },
                  async () => {
                    const { result, outputPayload } = await executeToolCall({
                      callKind: entry.call.kind,
                      toolName: entry.toolName,
                      tool: request.tools[entry.toolName],
                      rawInput: entry.value,
                      parseError: entry.parseError,
                      provider: "chatgpt",
                    });
                    return { entry, result, outputPayload };
                  },
                );
              }),
            ),
            { provider: "chatgpt" },
          );

          let toolExecutionMs = 0;
          let waitToolMs = 0;
          for (const { entry, result, outputPayload } of callResults) {
            toolCalls.push({ ...result, callId: entry.ids.callId });
            const callDurationMs = toToolResultDuration(result);
            toolExecutionMs += callDurationMs;
            if (entry.toolName.toLowerCase() === SUBAGENT_WAIT_TOOL_NAME) {
              waitToolMs += callDurationMs;
            }
            request.onEvent?.({
              type: "tool_call",
              phase: "completed",
              turn: entry.turn,
              toolIndex: entry.toolIndex,
              toolName: entry.toolName,
              toolId: entry.toolId,
              callKind: entry.call.kind,
              callId: entry.ids.callId,
              input: entry.value,
              output: result.output,
              error: result.error,
              durationMs: result.durationMs,
            });
            if (entry.call.kind === "custom") {
              toolOutputs.push({
                type: "custom_tool_call",
                id: entry.ids.itemId,
                call_id: entry.ids.callId,
                name: entry.toolName,
                input: entry.call.input,
                status: "completed",
              } as ChatGptInputItem);
              toolOutputs.push({
                type: "custom_tool_call_output",
                call_id: entry.ids.callId,
                output: toChatGptToolOutput(outputPayload, {
                  defaultMediaResolution: request.mediaResolution,
                  model: request.model,
                }),
              } as ChatGptInputItem);
            } else {
              toolOutputs.push({
                type: "function_call",
                id: entry.ids.itemId,
                call_id: entry.ids.callId,
                name: entry.toolName,
                arguments: entry.call.arguments,
                status: "completed",
              } as ChatGptInputItem);
              toolOutputs.push({
                type: "function_call_output",
                call_id: entry.ids.callId,
                output: toChatGptToolOutput(outputPayload, {
                  defaultMediaResolution: request.mediaResolution,
                  model: request.model,
                }),
              } as ChatGptInputItem);
            }
          }

          const stepCompletedAtMs = Date.now();
          const timing = buildStepTiming({
            stepStartedAtMs,
            stepCompletedAtMs,
            modelCompletedAtMs,
            firstModelEventAtMs,
            toolExecutionMs,
            waitToolMs,
          });
          steps.push({
            step: steps.length + 1,
            modelVersion,
            text: responseText || undefined,
            thoughts: reasoningSummaryText || undefined,
            toolCalls,
            usage: usageTokens,
            costUsd: stepCostUsd,
            timing,
          });
          const terminalToolCall = findTerminalToolCall(request.tools, toolCalls);

          const steeringInput = steeringInternal?.drainPendingContents() ?? [];
          const steeringItems =
            steeringInput.length > 0
              ? toChatGptInput(steeringInput, {
                  defaultMediaResolution: request.mediaResolution,
                  model: request.model,
                }).input
              : [];
          stepCallLogger?.complete({
            responseText,
            toolCallText: stepToolCallText,
            toolCallPayload: stepToolCallPayload,
            metadata: {
              provider: "chatgpt",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
              costUsd: stepCostUsd,
              responseChars: responseText.length,
              thoughtChars: reasoningSummaryText.length,
              toolCalls: toolCalls.length,
              finalStep: terminalToolCall !== null,
            },
          });
          if (terminalToolCall) {
            finalText = terminalToolCallText(terminalToolCall) || responseText;
            finalThoughts = reasoningSummaryText;
            return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
          }
          input =
            steeringItems.length > 0
              ? input.concat(toolOutputs, steeringItems)
              : input.concat(toolOutputs);
        } catch (error) {
          stepCallLogger?.fail(error, {
            responseText,
            toolCallText: stepToolCallText,
            toolCallPayload: stepToolCallPayload,
            metadata: {
              provider: "chatgpt",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
            },
          });
          throw error;
        }
      }

      throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
    }

    if (providerInfo.provider === "fireworks") {
      if (request.modelTools && request.modelTools.length > 0) {
        throw new Error(
          "Fireworks provider does not support provider-native modelTools in runToolLoop.",
        );
      }

      const fireworksTools = buildFireworksToolsFromToolSet(request.tools);
      const messages: Array<Record<string, unknown>> = toFireworksMessages(contents);

      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
        const turn = stepIndex + 1;
        const stepStartedAtMs = Date.now();
        let schedulerMetrics: CallSchedulerRunMetrics | undefined;
        let modelVersion: string = request.model;
        let usageTokens: LlmUsageTokens | undefined;
        let responseText = "";
        let blocked = false;
        let stepToolCallText: string | undefined;
        let stepToolCallPayload: ReadonlyArray<Record<string, unknown>> | undefined;
        const stepRequestPayload = {
          model: providerInfo.model,
          messages,
          tools: fireworksTools,
          tool_choice: "auto" as const,
          parallel_tool_calls: true,
        };
        const stepCallLogger = startLlmCallLoggerFromPayload({
          provider: "fireworks",
          modelId: request.model,
          requestPayload: stepRequestPayload,
          step: turn,
        });
        try {
          const response = await runFireworksCall(
            async (client) => {
              return await client.chat.completions.create(
                {
                  model: providerInfo.model,
                  messages: messages as any,
                  tools: fireworksTools as any,
                  tool_choice: "auto" as const,
                  parallel_tool_calls: true,
                } as any,
                { signal: request.signal } as any,
              );
            },
            providerInfo.model,
            {
              onSettled: (metrics) => {
                schedulerMetrics = metrics;
              },
            },
          );
          const modelCompletedAtMs = Date.now();

          modelVersion = typeof response.model === "string" ? response.model : request.model;
          request.onEvent?.({ type: "model", modelVersion });

          const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
          if (choice?.finish_reason === "content_filter") {
            blocked = true;
            request.onEvent?.({ type: "blocked" });
          }
          const message = (choice as { message?: unknown } | undefined)?.message;
          responseText = extractFireworksMessageText(message).trim();
          if (responseText.length > 0) {
            stepCallLogger?.appendResponseDelta(responseText);
            request.onEvent?.({ type: "delta", channel: "response", text: responseText });
          }

          usageTokens = extractFireworksUsageTokens(response.usage);
          const stepCostUsd = estimateCallCostUsd({
            modelId: modelVersion,
            tokens: usageTokens,
            responseImages: 0,
          });
          totalCostUsd += stepCostUsd;

          if (usageTokens) {
            request.onEvent?.({
              type: "usage",
              usage: usageTokens,
              costUsd: stepCostUsd,
              modelVersion,
            });
          }

          const responseToolCalls = extractFireworksToolCalls(message);
          stepToolCallPayload = toLoggedOpenAiStyleToolCalls(
            responseToolCalls.map((call) => ({
              kind: "function" as const,
              name: call.name,
              arguments: call.arguments,
              callId: call.id,
            })),
          );
          stepToolCallText = serialiseLogArtifactText(stepToolCallPayload);
          if (responseToolCalls.length === 0) {
            const steeringInput = steeringInternal?.drainPendingContents() ?? [];
            const steeringMessages =
              steeringInput.length > 0 ? toFireworksMessages(steeringInput) : [];
            finalText = responseText;
            finalThoughts = "";
            const stepCompletedAtMs = Date.now();
            const timing = buildStepTiming({
              stepStartedAtMs,
              stepCompletedAtMs,
              modelCompletedAtMs,
              schedulerMetrics,
              toolExecutionMs: 0,
              waitToolMs: 0,
            });
            steps.push({
              step: steps.length + 1,
              modelVersion,
              text: responseText || undefined,
              thoughts: undefined,
              toolCalls: [],
              usage: usageTokens,
              costUsd: stepCostUsd,
              timing,
            });
            stepCallLogger?.complete({
              responseText,
              metadata: {
                provider: "fireworks",
                model: request.model,
                modelVersion,
                step: turn,
                usage: usageTokens,
                costUsd: stepCostUsd,
                blocked,
                responseChars: responseText.length,
                thoughtChars: 0,
                toolCalls: 0,
                finalStep: steeringMessages.length === 0,
              },
            });
            if (steeringMessages.length === 0) {
              return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
            }
            if (responseText.length > 0) {
              messages.push({ role: "assistant", content: responseText });
            }
            messages.push(...steeringMessages);
            continue;
          }

          const stepToolCalls: LlmToolCallResult[] = [];
          const callInputs = responseToolCalls.map((call, index) => {
            const toolIndex = index + 1;
            const toolId = buildToolLogId(turn, toolIndex);
            const { value, error: parseError } = parseOpenAiToolArguments(call.arguments);
            return { call, toolName: call.name, value, parseError, toolId, turn, toolIndex };
          });

          for (const entry of callInputs) {
            request.onEvent?.({
              type: "tool_call",
              phase: "started",
              turn: entry.turn,
              toolIndex: entry.toolIndex,
              toolName: entry.toolName,
              toolId: entry.toolId,
              callKind: "function",
              callId: entry.call.id,
              input: entry.value,
            });
          }

          const callResults = await maybeSpillCombinedToolCallOutputs(
            await Promise.all(
              callInputs.map(async (entry) => {
                return await toolCallContextStorage.run(
                  {
                    toolName: entry.toolName,
                    toolId: entry.toolId,
                    turn: entry.turn,
                    toolIndex: entry.toolIndex,
                  },
                  async () => {
                    const { result, outputPayload } = await executeToolCall({
                      callKind: "function",
                      toolName: entry.toolName,
                      tool: request.tools[entry.toolName],
                      rawInput: entry.value,
                      parseError: entry.parseError,
                      provider: providerInfo.provider,
                    });
                    return { entry, result, outputPayload };
                  },
                );
              }),
            ),
            { provider: providerInfo.provider },
          );

          const assistantToolCalls: Array<Record<string, unknown>> = [];
          const toolMessages: Array<Record<string, unknown>> = [];
          let toolExecutionMs = 0;
          let waitToolMs = 0;
          for (const { entry, result, outputPayload } of callResults) {
            stepToolCalls.push({ ...result, callId: entry.call.id });
            const callDurationMs = toToolResultDuration(result);
            toolExecutionMs += callDurationMs;
            if (entry.toolName.toLowerCase() === SUBAGENT_WAIT_TOOL_NAME) {
              waitToolMs += callDurationMs;
            }
            request.onEvent?.({
              type: "tool_call",
              phase: "completed",
              turn: entry.turn,
              toolIndex: entry.toolIndex,
              toolName: entry.toolName,
              toolId: entry.toolId,
              callKind: "function",
              callId: entry.call.id,
              input: entry.value,
              output: result.output,
              error: result.error,
              durationMs: result.durationMs,
            });
            assistantToolCalls.push({
              id: entry.call.id,
              type: "function",
              function: {
                name: entry.toolName,
                arguments: entry.call.arguments,
              },
            });
            toolMessages.push({
              role: "tool",
              tool_call_id: entry.call.id,
              content: mergeToolOutput(outputPayload),
            });
          }

          const stepCompletedAtMs = Date.now();
          const timing = buildStepTiming({
            stepStartedAtMs,
            stepCompletedAtMs,
            modelCompletedAtMs,
            schedulerMetrics,
            toolExecutionMs,
            waitToolMs,
          });
          steps.push({
            step: steps.length + 1,
            modelVersion,
            text: responseText || undefined,
            thoughts: undefined,
            toolCalls: stepToolCalls,
            usage: usageTokens,
            costUsd: stepCostUsd,
            timing,
          });
          const terminalToolCall = findTerminalToolCall(request.tools, stepToolCalls);
          stepCallLogger?.complete({
            responseText,
            toolCallText: stepToolCallText,
            toolCallPayload: stepToolCallPayload,
            metadata: {
              provider: "fireworks",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
              costUsd: stepCostUsd,
              blocked,
              responseChars: responseText.length,
              thoughtChars: 0,
              toolCalls: stepToolCalls.length,
              finalStep: terminalToolCall !== null,
            },
          });
          if (terminalToolCall) {
            finalText = terminalToolCallText(terminalToolCall) || responseText;
            finalThoughts = "";
            return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
          }

          messages.push({
            role: "assistant",
            ...(responseText.length > 0 ? { content: responseText } : {}),
            tool_calls: assistantToolCalls,
          });
          messages.push(...toolMessages);
          const steeringInput = steeringInternal?.drainPendingContents() ?? [];
          if (steeringInput.length > 0) {
            messages.push(...toFireworksMessages(steeringInput));
          }
        } catch (error) {
          stepCallLogger?.fail(error, {
            responseText,
            toolCallText: stepToolCallText,
            toolCallPayload: stepToolCallPayload,
            metadata: {
              provider: "fireworks",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
              blocked,
            },
          });
          throw error;
        }
      }

      throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
    }

    // Gemini provider
    const geminiFunctionTools = buildGeminiFunctionDeclarations(request.tools);
    const geminiNativeTools = toGeminiTools(request.modelTools);
    const geminiTools = geminiNativeTools
      ? geminiNativeTools.concat(geminiFunctionTools)
      : geminiFunctionTools;
    const geminiContents = contents.map((content) =>
      convertLlmContentToGeminiContent(content, {
        defaultMediaResolution: request.mediaResolution,
      }),
    );

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const turn = stepIndex + 1;
      const stepStartedAtMs = Date.now();
      let firstModelEventAtMs: number | undefined;
      let schedulerMetrics: CallSchedulerRunMetrics | undefined;
      let modelVersion: string = request.model;
      let usageTokens: LlmUsageTokens | undefined;
      let responseText = "";
      let thoughtsText = "";
      let stepToolCallText: string | undefined;
      let stepToolCallPayload: ReadonlyArray<Record<string, unknown>> | undefined;
      const markFirstModelEvent = () => {
        if (firstModelEventAtMs === undefined) {
          firstModelEventAtMs = Date.now();
        }
      };
      const thinkingConfig = resolveGeminiThinkingConfig(request.model, request.thinkingLevel);
      const mediaResolution = toGeminiMediaResolution(request.mediaResolution);
      const config: GenerateContentConfig = {
        maxOutputTokens: 32_000,
        tools: geminiTools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.VALIDATED,
          },
        },
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(mediaResolution ? { mediaResolution } : {}),
      };

      const onEvent = request.onEvent;
      const preparedGeminiContents = await maybePrepareGeminiPromptContents(geminiContents);
      const stepRequestPayload = {
        model: request.model,
        contents: preparedGeminiContents,
        config,
      };
      const stepCallLogger = startLlmCallLoggerFromPayload({
        provider: "gemini",
        modelId: request.model,
        requestPayload: stepRequestPayload,
        step: turn,
      });
      try {
        type GeminiToolLoopResponse = {
          readonly responseText: string;
          readonly thoughtsText: string;
          readonly functionCalls: Array<NonNullable<GeminiPart["functionCall"]>>;
          readonly modelParts: GeminiPart[];
          readonly usageMetadata?: unknown;
          readonly modelVersion?: string;
        };

        const response: GeminiToolLoopResponse = await runGeminiCall(
          async (client) => {
            const stream = await client.models.generateContentStream({
              model: request.model,
              contents: preparedGeminiContents,
              config,
            });
            let responseText = "";
            let thoughtsText = "";
            const modelParts: GeminiPart[] = [];
            const functionCalls: Array<NonNullable<GeminiPart["functionCall"]>> = [];
            let latestUsageMetadata: unknown;
            let resolvedModelVersion: string | undefined;

            for await (const chunk of stream) {
              markFirstModelEvent();
              if (chunk.modelVersion) {
                resolvedModelVersion = chunk.modelVersion;
                onEvent?.({ type: "model", modelVersion: chunk.modelVersion });
              }
              if (chunk.usageMetadata) {
                latestUsageMetadata = chunk.usageMetadata;
              }
              const candidates = chunk.candidates;
              if (!candidates || candidates.length === 0) {
                continue;
              }
              const primary = candidates[0];
              const parts = primary?.content?.parts ?? [];
              const chunkFunctionCalls =
                (
                  chunk as {
                    functionCalls?: Array<NonNullable<GeminiPart["functionCall"]>>;
                  }
                ).functionCalls ?? [];
              if (parts.length === 0 && chunkFunctionCalls.length === 0) {
                continue;
              }

              for (const part of parts) {
                modelParts.push(part);
                if (typeof part.text === "string" && part.text.length > 0) {
                  if (part.thought) {
                    thoughtsText += part.text;
                    stepCallLogger?.appendThoughtDelta(part.text);
                    onEvent?.({ type: "delta", channel: "thought", text: part.text });
                  } else {
                    responseText += part.text;
                    stepCallLogger?.appendResponseDelta(part.text);
                    onEvent?.({ type: "delta", channel: "response", text: part.text });
                  }
                }
              }
              if (chunkFunctionCalls.length > 0) {
                functionCalls.push(...chunkFunctionCalls);
                continue;
              }
              for (const part of parts) {
                if (part.functionCall) {
                  functionCalls.push(part.functionCall);
                }
              }
            }

            return {
              responseText,
              thoughtsText,
              functionCalls,
              modelParts,
              usageMetadata: latestUsageMetadata,
              modelVersion: resolvedModelVersion ?? request.model,
            };
          },
          request.model,
          {
            onSettled: (metrics) => {
              schedulerMetrics = metrics;
            },
          },
        );
        const modelCompletedAtMs = Date.now();

        usageTokens = extractGeminiUsageTokens(response.usageMetadata);
        modelVersion = response.modelVersion ?? request.model;
        responseText = response.responseText.trim();
        thoughtsText = response.thoughtsText.trim();
        const responseOutputAttachments = collectLoggedAttachmentsFromGeminiParts(
          response.modelParts,
          "output",
        );
        const stepCostUsd = estimateCallCostUsd({
          modelId: modelVersion,
          tokens: usageTokens,
          responseImages: 0,
        });
        totalCostUsd += stepCostUsd;

        stepToolCallPayload = toLoggedGeminiToolCalls(response.functionCalls);
        stepToolCallText = serialiseLogArtifactText(stepToolCallPayload);
        if (response.functionCalls.length === 0) {
          const steeringInput = steeringInternal?.drainPendingContents() ?? [];
          finalText = responseText;
          finalThoughts = thoughtsText;
          const stepCompletedAtMs = Date.now();
          const timing = buildStepTiming({
            stepStartedAtMs,
            stepCompletedAtMs,
            modelCompletedAtMs,
            firstModelEventAtMs,
            schedulerMetrics,
            toolExecutionMs: 0,
            waitToolMs: 0,
          });
          steps.push({
            step: steps.length + 1,
            modelVersion,
            text: finalText || undefined,
            thoughts: finalThoughts || undefined,
            toolCalls: [],
            usage: usageTokens,
            costUsd: stepCostUsd,
            timing,
          });
          stepCallLogger?.complete({
            responseText,
            attachments: responseOutputAttachments,
            metadata: {
              provider: "gemini",
              model: request.model,
              modelVersion,
              step: turn,
              usage: usageTokens,
              costUsd: stepCostUsd,
              responseChars: responseText.length,
              thoughtChars: thoughtsText.length,
              toolCalls: 0,
              finalStep: steeringInput.length === 0,
            },
          });
          if (steeringInput.length === 0) {
            return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
          }
          const modelPartsForHistory = response.modelParts.filter(
            (part) => !(typeof part.text === "string" && part.thought === true),
          );
          if (modelPartsForHistory.length > 0) {
            geminiContents.push({ role: "model", parts: modelPartsForHistory });
          } else if (response.responseText.length > 0) {
            geminiContents.push({ role: "model", parts: [{ text: response.responseText }] });
          }
          geminiContents.push(
            ...steeringInput.map((content) =>
              convertLlmContentToGeminiContent(content, {
                defaultMediaResolution: request.mediaResolution,
              }),
            ),
          );
          continue;
        }

        const toolCalls: LlmToolCallResult[] = [];

        const modelPartsForHistory = response.modelParts.filter(
          (part) => !(typeof part.text === "string" && part.thought === true),
        );
        if (modelPartsForHistory.length > 0) {
          geminiContents.push({ role: "model", parts: modelPartsForHistory });
        } else {
          const parts: GeminiPart[] = [];
          if (response.responseText) {
            parts.push({ text: response.responseText });
          }
          for (const call of response.functionCalls) {
            parts.push({ functionCall: call });
          }
          geminiContents.push({ role: "model", parts });
        }

        const responseParts: GeminiPart[] = [];
        const callInputs = response.functionCalls.map((call, index) => {
          const toolIndex = index + 1;
          const toolId = buildToolLogId(turn, toolIndex);
          const toolName = call.name ?? "unknown";
          const rawInput = call.args ?? {};
          return { call, toolName, rawInput, toolId, turn, toolIndex };
        });

        for (const entry of callInputs) {
          onEvent?.({
            type: "tool_call",
            phase: "started",
            turn: entry.turn,
            toolIndex: entry.toolIndex,
            toolName: entry.toolName,
            toolId: entry.toolId,
            callKind: "function",
            callId: entry.call.id,
            input: entry.rawInput,
          });
        }

        const callResults = await maybeSpillCombinedToolCallOutputs(
          await Promise.all(
            callInputs.map(async (entry) => {
              return await toolCallContextStorage.run(
                {
                  toolName: entry.toolName,
                  toolId: entry.toolId,
                  turn: entry.turn,
                  toolIndex: entry.toolIndex,
                },
                async () => {
                  const { result, outputPayload } = await executeToolCall({
                    callKind: "function",
                    toolName: entry.toolName,
                    tool: request.tools[entry.toolName],
                    rawInput: entry.rawInput,
                    provider: "gemini",
                  });
                  return { entry, result, outputPayload };
                },
              );
            }),
          ),
          { provider: "gemini" },
        );

        let toolExecutionMs = 0;
        let waitToolMs = 0;
        for (const { entry, result, outputPayload } of callResults) {
          toolCalls.push({ ...result, callId: entry.call.id });
          const callDurationMs = toToolResultDuration(result);
          toolExecutionMs += callDurationMs;
          if (entry.toolName.toLowerCase() === SUBAGENT_WAIT_TOOL_NAME) {
            waitToolMs += callDurationMs;
          }
          onEvent?.({
            type: "tool_call",
            phase: "completed",
            turn: entry.turn,
            toolIndex: entry.toolIndex,
            toolName: entry.toolName,
            toolId: entry.toolId,
            callKind: "function",
            callId: entry.call.id,
            input: entry.rawInput,
            output: result.output,
            error: result.error,
            durationMs: result.durationMs,
          });
          responseParts.push(
            ...buildGeminiFunctionResponseParts({
              toolName: entry.toolName,
              callId: entry.call.id,
              outputPayload,
              defaultMediaResolution: request.mediaResolution,
            }),
          );
        }

        const stepCompletedAtMs = Date.now();
        const timing = buildStepTiming({
          stepStartedAtMs,
          stepCompletedAtMs,
          modelCompletedAtMs,
          firstModelEventAtMs,
          schedulerMetrics,
          toolExecutionMs,
          waitToolMs,
        });
        steps.push({
          step: steps.length + 1,
          modelVersion,
          text: responseText || undefined,
          thoughts: thoughtsText || undefined,
          toolCalls,
          usage: usageTokens,
          costUsd: stepCostUsd,
          timing,
        });
        const terminalToolCall = findTerminalToolCall(request.tools, toolCalls);
        stepCallLogger?.complete({
          responseText,
          attachments: responseOutputAttachments,
          toolCallText: stepToolCallText,
          toolCallPayload: stepToolCallPayload,
          metadata: {
            provider: "gemini",
            model: request.model,
            modelVersion,
            step: turn,
            usage: usageTokens,
            costUsd: stepCostUsd,
            responseChars: responseText.length,
            thoughtChars: thoughtsText.length,
            toolCalls: toolCalls.length,
            finalStep: terminalToolCall !== null,
          },
        });
        if (terminalToolCall) {
          finalText = terminalToolCallText(terminalToolCall) || responseText;
          finalThoughts = thoughtsText;
          return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
        }

        geminiContents.push({ role: "user", parts: responseParts });
        const steeringInput = steeringInternal?.drainPendingContents() ?? [];
        if (steeringInput.length > 0) {
          geminiContents.push(
            ...steeringInput.map((content) =>
              convertLlmContentToGeminiContent(content, {
                defaultMediaResolution: request.mediaResolution,
              }),
            ),
          );
        }
      } catch (error) {
        stepCallLogger?.fail(error, {
          responseText,
          toolCallText: stepToolCallText,
          toolCallPayload: stepToolCallPayload,
          metadata: {
            provider: "gemini",
            model: request.model,
            modelVersion,
            step: turn,
            usage: usageTokens,
            responseChars: responseText.length,
            thoughtChars: thoughtsText.length,
          },
        });
        throw error;
      }
    }

    throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
  } finally {
    steeringInternal?.close();
  }
}

function mergeAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  if (first.aborted) {
    abortFrom(first);
  } else {
    first.addEventListener("abort", () => abortFrom(first), { once: true });
  }
  if (second.aborted) {
    abortFrom(second);
  } else {
    second.addEventListener("abort", () => abortFrom(second), { once: true });
  }
  return controller.signal;
}

export function streamToolLoop(request: LlmToolLoopRequest): LlmToolLoopStream {
  const queue = createAsyncQueue<LlmStreamEvent>();
  const abortController = new AbortController();
  const steering = request.steering ?? createToolLoopSteeringChannel();
  const signal = mergeAbortSignals(request.signal, abortController.signal);
  const sourceOnEvent = request.onEvent;

  const result = (async () => {
    try {
      const output = await runToolLoop({
        ...request,
        steering,
        ...(signal ? { signal } : {}),
        onEvent: (event) => {
          sourceOnEvent?.(event);
          queue.push(event);
        },
      });
      queue.close();
      return output;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      queue.fail(err);
      throw err;
    }
  })();

  return {
    events: queue.iterable,
    result,
    append: steering.append,
    steer: steering.steer,
    pendingSteeringCount: steering.pendingCount,
    abort: () => abortController.abort(),
  };
}

// --- Images (Gemini image-preview) ---

const IMAGE_GRADE_VALUE_SCHEMA = z.enum(["pass", "fail"]);
const IMAGE_GRADE_SCHEMA = z.object({
  grade: IMAGE_GRADE_VALUE_SCHEMA,
});

async function gradeGeneratedImage(params: {
  gradingPrompt: string;
  imagePrompt: string;
  image: LlmImageData;
  model: LlmTextModelId;
}): Promise<{
  readonly grade: z.infer<typeof IMAGE_GRADE_VALUE_SCHEMA>;
  readonly result: LlmTextResult;
}> {
  const parts: LlmContentPart[] = [
    {
      type: "text",
      text: [
        params.gradingPrompt,
        "",
        "Image prompt to grade:",
        params.imagePrompt,
        "",
        'Respond with JSON like {"grade":"pass"} or {"grade":"fail"}.',
      ].join("\\n"),
    },
    {
      type: "inlineData",
      data: params.image.data.toString("base64"),
      mimeType: params.image.mimeType ?? "image/png",
    },
  ];
  const { value, result } = await generateJson({
    model: params.model,
    input: [{ role: "user", content: parts }],
    schema: IMAGE_GRADE_SCHEMA,
    telemetry: false,
  });
  return { grade: value.grade, result };
}

function resolveOpenAiImageMimeType(outputFormat: LlmOpenAiImageOutputFormat | undefined): string {
  switch (outputFormat) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    case undefined:
      return "image/png";
  }
}

function buildOpenAiImagePrompt(params: {
  stylePrompt: string;
  imagePrompt: string;
  hasStyleImages: boolean;
}): string {
  return [
    "Follow the requested visual style.",
    "",
    "Style:",
    params.stylePrompt.trim(),
    ...(params.hasStyleImages
      ? [
          "",
          "Use the attached reference image or images for palette, lighting, mood, composition, and material feel.",
        ]
      : []),
    "",
    "Image:",
    params.imagePrompt.trim(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function resolveOpenAiImageRequestParams(request: LlmOpenAiGenerateImagesRequest): {
  readonly size: LlmOpenAiImageResolution;
  readonly quality: LlmOpenAiImageQuality;
  readonly outputFormat: LlmOpenAiImageOutputFormat | undefined;
  readonly n: LlmOpenAiImageNumImages;
  readonly background: LlmOpenAiImageBackground | undefined;
  readonly moderation: LlmOpenAiImageModeration | undefined;
} {
  if (request.partialImages !== undefined) {
    throw new Error("partialImages is only supported for streaming image generation.");
  }
  if (
    request.outputCompression !== undefined &&
    (!Number.isInteger(request.outputCompression) ||
      request.outputCompression < 0 ||
      request.outputCompression > 100)
  ) {
    throw new Error("outputCompression must be an integer from 0 to 100.");
  }
  if (
    request.outputCompression !== undefined &&
    request.outputFormat !== "jpeg" &&
    request.outputFormat !== "webp"
  ) {
    throw new Error("outputCompression requires outputFormat to be jpeg or webp.");
  }
  const size = request.imageResolution ?? "auto";
  const sizeValidation = validateOpenAiGptImage2Resolution(size);
  if (!sizeValidation.valid) {
    throw new Error(
      `imageResolution ${JSON.stringify(size)} is not supported by gpt-image-2: ${sizeValidation.reason}`,
    );
  }
  return {
    size,
    quality: request.imageQuality ?? "auto",
    outputFormat: request.outputFormat,
    n: request.numImages ?? 1,
    background: request.background,
    moderation: request.moderation,
  };
}

async function createOpenAiStyleImageFiles(
  styleImages: readonly LlmImageData[] | undefined,
): Promise<unknown[] | undefined> {
  if (!styleImages || styleImages.length === 0) {
    return undefined;
  }
  return await Promise.all(
    styleImages.map(async (image, index) => {
      const mimeType = image.mimeType ?? "image/png";
      const extension = resolveAttachmentExtension(mimeType);
      return await toFile(image.data, `style-${index + 1}.${extension}`, { type: mimeType });
    }),
  );
}

async function generateImagesWithOpenAiImageApi(
  request: LlmOpenAiGenerateImagesRequest,
): Promise<LlmImageData[]> {
  const promptEntries = Array.from(request.imagePrompts, (rawPrompt, index) => {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      throw new Error(`imagePrompts[${index}] must be a non-empty string`);
    }
    return prompt;
  });
  if (promptEntries.length === 0) {
    return [];
  }

  const provider = resolveProvider(request.model).provider;
  const telemetry = createLlmTelemetryEmitter({
    telemetry: request.telemetry,
    operation: "generateImages",
    provider,
    model: request.model,
  });
  const startedAtMs = Date.now();
  const params = resolveOpenAiImageRequestParams(request);
  const styleImages = await createOpenAiStyleImageFiles(request.styleImages);
  const hasStyleImages = Boolean(styleImages && styleImages.length > 0);
  const outputMimeType = resolveOpenAiImageMimeType(params.outputFormat);
  let totalUsage: LlmUsageTokens | undefined;
  let costUsd = 0;
  let outputImages = 0;

  telemetry.emit({
    type: "llm.call.started",
    imagePromptCount: promptEntries.length,
    styleImageCount: request.styleImages?.length ?? 0,
    numImagesPerPrompt: params.n,
  });

  try {
    const images: LlmImageData[] = [];
    for (const imagePrompt of promptEntries) {
      const prompt = buildOpenAiImagePrompt({
        stylePrompt: request.stylePrompt,
        imagePrompt,
        hasStyleImages,
      });
      const response = await runOpenAiCall(async (client) => {
        const payload = {
          model: request.model,
          prompt,
          n: params.n,
          size: params.size,
          quality: params.quality,
          ...(params.outputFormat ? { output_format: params.outputFormat } : {}),
          ...(request.outputCompression !== undefined
            ? { output_compression: request.outputCompression }
            : {}),
          ...(params.background ? { background: params.background } : {}),
          ...(params.moderation ? { moderation: params.moderation } : {}),
        };
        if (styleImages && styleImages.length > 0) {
          return await client.images.edit(
            {
              ...payload,
              image: styleImages,
            } as any,
            { signal: request.signal } as any,
          );
        }
        return await client.images.generate(payload as any, { signal: request.signal } as any);
      }, request.model);

      const data = Array.isArray((response as { data?: unknown }).data)
        ? ((response as { data?: Array<{ b64_json?: unknown }> }).data ?? [])
        : [];
      for (const item of data) {
        if (typeof item.b64_json !== "string" || item.b64_json.length === 0) {
          continue;
        }
        images.push({
          mimeType: outputMimeType,
          data: Buffer.from(item.b64_json, "base64"),
        });
      }
      outputImages = images.length;
      const usage = extractOpenAiUsageTokens((response as { usage?: unknown }).usage);
      totalUsage = sumUsageTokens(totalUsage, usage);
      costUsd += estimateCallCostUsd({
        modelId: request.model,
        tokens: usage,
        responseImages: data.length,
        imageSize: params.size,
        imageQuality: params.quality,
      });
    }

    telemetry.emit({
      type: "llm.call.completed",
      success: true,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      usage: totalUsage,
      costUsd,
      imageCount: images.length,
      attempts: promptEntries.length,
    });
    return images;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    telemetry.emit({
      type: "llm.call.completed",
      success: false,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      usage: totalUsage,
      costUsd,
      imageCount: outputImages,
      error: err.message,
    });
    throw err;
  } finally {
    await telemetry.flush();
  }
}

export async function generateImages(request: LlmGenerateImagesRequest): Promise<LlmImageData[]> {
  if (isOpenAiGenerateImagesRequest(request)) {
    return await generateImagesWithOpenAiImageApi(request);
  }

  const maxAttempts = Math.max(1, Math.floor(request.maxAttempts ?? 4));
  const promptList = Array.from(request.imagePrompts);
  if (promptList.length === 0) {
    return [];
  }
  const numImages = promptList.length;

  type PromptEntry = { index: number; prompt: string };
  const promptEntries: PromptEntry[] = promptList.map((rawPrompt, arrayIndex) => {
    const trimmedPrompt = rawPrompt.trim();
    if (!trimmedPrompt) {
      throw new Error(`imagePrompts[${arrayIndex}] must be a non-empty string`);
    }
    return { index: arrayIndex + 1, prompt: trimmedPrompt };
  });

  const gradingPrompt = request.imageGradingPrompt?.trim() ?? "";
  if (!gradingPrompt) {
    throw new Error("imageGradingPrompt must be a non-empty string");
  }

  const telemetry = createLlmTelemetryEmitter({
    telemetry: request.telemetry,
    operation: "generateImages",
    provider: resolveProvider(request.model).provider,
    model: request.model,
  });
  const startedAtMs = Date.now();

  telemetry.emit({
    type: "llm.call.started",
    imagePromptCount: promptList.length,
    styleImageCount: request.styleImages?.length ?? 0,
    maxAttempts,
  });

  const addText = (parts: LlmContentPart[], text: string) => {
    const lastPart = parts[parts.length - 1];
    if (lastPart !== undefined && lastPart.type === "text") {
      (lastPart as any).text = `${(lastPart as any).text}\\n${text}`;
    } else {
      parts.push({ type: "text", text });
    }
  };

  const buildInitialPromptParts = (): LlmContentPart[] => {
    const parts: LlmContentPart[] = [];
    addText(
      parts,
      [
        `Please make all ${numImages} requested images:`,
        "",
        "Follow the style:",
        request.stylePrompt,
      ].join("\\n"),
    );
    if (request.styleImages && request.styleImages.length > 0) {
      addText(
        parts,
        "\\nFollow the visual style, composition and the characters from these images:",
      );
      for (const styleImage of request.styleImages) {
        parts.push({
          type: "inlineData",
          data: styleImage.data.toString("base64"),
          mimeType: styleImage.mimeType,
        });
      }
    }
    const lines: string[] = ["", "Image descriptions:"];
    for (const entry of promptEntries) {
      lines.push(`\\nImage ${entry.index}: ${entry.prompt}`);
    }
    lines.push("");
    lines.push(`Please make all ${numImages} images.`);
    addText(parts, lines.join("\\n"));
    return parts;
  };

  const buildContinuationPromptParts = (pending: PromptEntry[]): LlmContentPart[] => {
    const pendingIds = pending.map((entry) => entry.index).join(", ");
    const lines: string[] = [
      `Please continue generating the remaining images: ${pendingIds}.`,
      "",
      "Image descriptions:",
    ];
    for (const entry of pending) {
      lines.push(`\\nImage ${entry.index}: ${entry.prompt}`);
    }
    lines.push(`\\nPlease make all ${pending.length} remaining images.`);
    return [{ type: "text", text: lines.join("\\n") }];
  };

  const inputMessages: LlmInputMessage[] = [{ role: "user", content: buildInitialPromptParts() }];

  const orderedEntries = [...promptEntries];
  const resolvedImages = new Map<number, LlmImageData>();
  let totalCostUsd = 0;
  let totalUsage: LlmUsageTokens | undefined;
  let attemptsUsed = 0;

  const removeResolvedEntries = (resolved: ReadonlySet<number>) => {
    if (resolved.size === 0) {
      return;
    }
    for (let i = promptEntries.length - 1; i >= 0; i -= 1) {
      const entry = promptEntries[i];
      if (!entry) {
        continue;
      }
      if (resolved.has(entry.index)) {
        promptEntries.splice(i, 1);
      }
    }
  };

  let uploadMetrics = emptyFileUploadMetrics();
  try {
    await collectFileUploadMetrics(async () => {
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          attemptsUsed = attempt;
          const result = await generateText({
            model: request.model,
            input: inputMessages,
            responseModalities: ["IMAGE", "TEXT"],
            imageAspectRatio: request.imageAspectRatio,
            imageSize: request.imageSize ?? "2K",
            telemetry: false,
          });
          totalCostUsd += result.costUsd;
          totalUsage = sumUsageTokens(totalUsage, result.usage);
          if (result.blocked || !result.content) {
            continue;
          }
          const images = extractImages(result.content);
          if (images.length > 0 && promptEntries.length > 0) {
            const assignedCount = Math.min(images.length, promptEntries.length);
            const pendingAssignments = promptEntries.slice(0, assignedCount);
            const assignedImages = images.slice(0, assignedCount);
            const gradeResults = await Promise.all(
              pendingAssignments.map((entry, index) =>
                gradeGeneratedImage({
                  gradingPrompt,
                  imagePrompt: entry.prompt,
                  image: (() => {
                    const image = assignedImages[index];
                    if (!image) {
                      throw new Error("Image generation returned fewer images than expected.");
                    }
                    return image as LlmImageData;
                  })(),
                  model: "gpt-5.4-mini",
                }),
              ),
            );
            const passedEntries = new Set<number>();
            for (let i = 0; i < gradeResults.length; i += 1) {
              const gradeResult = gradeResults[i];
              const entry = pendingAssignments[i];
              const image = assignedImages[i];
              if (!gradeResult || !entry || !image) {
                continue;
              }
              totalCostUsd += gradeResult.result.costUsd;
              totalUsage = sumUsageTokens(totalUsage, gradeResult.result.usage);
              if (gradeResult.grade === "pass") {
                resolvedImages.set(entry.index, image as LlmImageData);
                passedEntries.add(entry.index);
              }
            }
            removeResolvedEntries(passedEntries);
          }
          if (promptEntries.length === 0) {
            break;
          }
          inputMessages.push({
            role: "assistant",
            content: result.content.parts,
          });
          inputMessages.push({
            role: "user",
            content: buildContinuationPromptParts(promptEntries),
          });
        }
      } finally {
        uploadMetrics = getCurrentFileUploadMetrics();
      }
    });

    const orderedImages: LlmImageData[] = [];
    for (const entry of orderedEntries) {
      const image = resolvedImages.get(entry.index);
      if (image) {
        orderedImages.push(image);
      }
    }

    const outputImages = orderedImages.slice(0, numImages);
    telemetry.emit({
      type: "llm.call.completed",
      success: true,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      usage: totalUsage,
      costUsd: totalCostUsd,
      imageCount: outputImages.length,
      attempts: attemptsUsed,
      uploadCount: uploadMetrics.count,
      uploadBytes: uploadMetrics.totalBytes,
      uploadLatencyMs: uploadMetrics.totalLatencyMs,
    });
    return outputImages;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    telemetry.emit({
      type: "llm.call.completed",
      success: false,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      usage: totalUsage,
      costUsd: totalCostUsd,
      attempts: attemptsUsed > 0 ? attemptsUsed : undefined,
      uploadCount: uploadMetrics.count,
      uploadBytes: uploadMetrics.totalBytes,
      uploadLatencyMs: uploadMetrics.totalLatencyMs,
      error: err.message,
    });
    throw err;
  } finally {
    await telemetry.flush();
  }
}

export async function generateImageInBatches(
  request: LlmGenerateImagesRequest & { batchSize: number; overlapSize: number },
): Promise<LlmImageData[]> {
  const {
    batchSize,
    overlapSize,
    imagePrompts,
    styleImages: baseStyleImagesInput,
    ...rest
  } = request;
  if (batchSize <= 0) {
    throw new Error("batchSize must be greater than 0");
  }
  if (imagePrompts.length === 0) {
    return [];
  }

  const baseStyleImages = baseStyleImagesInput ? [...baseStyleImagesInput] : [];
  const generatedImages: LlmImageData[] = [];
  const totalPrompts = imagePrompts.length;

  for (let startIndex = 0; startIndex < totalPrompts; startIndex += batchSize) {
    const endIndex = Math.min(startIndex + batchSize, totalPrompts);
    const batchPrompts = imagePrompts.slice(startIndex, endIndex);

    let styleImagesForBatch: readonly LlmImageData[] = baseStyleImages;
    if (overlapSize > 0 && generatedImages.length > 0) {
      const overlapImages = generatedImages.slice(
        Math.max(0, generatedImages.length - overlapSize),
      );
      if (overlapImages.length > 0) {
        styleImagesForBatch = [...baseStyleImages, ...overlapImages];
      }
    }

    const batchImages = await generateImages({
      ...rest,
      imagePrompts: batchPrompts,
      styleImages: styleImagesForBatch,
    });

    generatedImages.push(...batchImages);
  }

  return generatedImages;
}

export function stripCodexCitationMarkers(value: string): {
  text: string;
  stripped: boolean;
} {
  // Codex-style citation markers are private-use unicode characters:
  // cite...  (U+E200/U+E202/U+E201)
  const citationBlockPattern = /\uE200cite\uE202[^\uE201]*\uE201/gu;
  const leftoverMarkersPattern = /[\uE200\uE201\uE202]/gu;

  const withoutBlocks = value.replace(citationBlockPattern, "");
  const withoutMarkers = withoutBlocks.replace(leftoverMarkersPattern, "");
  const stripped = withoutMarkers !== value;
  return { text: withoutMarkers, stripped };
}

function hasMarkdownSourcesSection(value: string): boolean {
  return /^##\s+Sources\s*$/gmu.test(value);
}

export function appendMarkdownSourcesSection(value: string, sources: readonly string[]): string {
  const trimmed = value.trimEnd();
  if (sources.length === 0) {
    return trimmed;
  }
  if (hasMarkdownSourcesSection(trimmed)) {
    return trimmed;
  }
  const lines = sources.map((url) => `- <${url}>`).join("\n");
  return `${trimmed}\n\n## Sources\n${lines}`;
}
