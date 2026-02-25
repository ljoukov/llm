import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import {
  FinishReason,
  FunctionCallingConfigMode,
  type Content as GeminiContent,
  type GenerateContentConfig,
  type GroundingMetadata,
  type Part as GeminiPart,
  type Tool as GeminiTool,
} from "@google/genai";
import { zodToJsonSchema } from "@alcyone-labs/zod-to-json-schema";
import { z } from "zod";
import type { ResponseTextConfig } from "openai/resources/responses/responses";

import { createAsyncQueue, type AsyncQueue } from "./utils/asyncQueue.js";
import { estimateCallCostUsd, type LlmUsageTokens } from "./utils/cost.js";
import { collectChatGptCodexResponse, type ChatGptInputItem } from "./openai/chatgpt-codex.js";
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
  isGeminiImageModelId,
  isGeminiTextModelId,
} from "./google/client.js";
import {
  runOpenAiCall,
  type OpenAiReasoningEffort,
  DEFAULT_OPENAI_REASONING_EFFORT,
} from "./openai/calls.js";
import {
  CHATGPT_MODEL_IDS,
  OPENAI_MODEL_IDS,
  stripChatGptPrefix,
  isChatGptModelId,
  isOpenAiModelId,
} from "./openai/models.js";

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

const toolCallContextStorage = new AsyncLocalStorage<LlmToolCallContext>();

export function getCurrentToolCallContext(): LlmToolCallContext | null {
  return toolCallContextStorage.getStore() ?? null;
}

export type JsonSchema = Record<string, unknown>;

export type LlmRole = "user" | "assistant" | "system" | "developer" | "tool";

type LlmInlineDataPart = {
  type: "inlineData";
  data: string;
  mimeType?: string;
};

export type LlmContentPart = { type: "text"; text: string; thought?: boolean } | LlmInlineDataPart;

export type LlmContent = {
  readonly role: LlmRole;
  readonly parts: readonly LlmContentPart[];
};

export type LlmImageSize = "1K" | "2K" | "4K";

export type LlmWebSearchMode = "cached" | "live";

export type LlmToolConfig =
  | { readonly type: "web-search"; readonly mode?: LlmWebSearchMode }
  | { readonly type: "code-execution" };

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

export type LlmStreamEvent = LlmTextDeltaEvent | LlmUsageEvent | LlmModelEvent | LlmBlockedEvent;

export type LlmProvider = "openai" | "chatgpt" | "gemini" | "fireworks";
export const LLM_TEXT_MODEL_IDS = [
  ...OPENAI_MODEL_IDS,
  ...CHATGPT_MODEL_IDS,
  ...FIREWORKS_MODEL_IDS,
  ...GEMINI_TEXT_MODEL_IDS,
] as const;
export type LlmTextModelId = (typeof LLM_TEXT_MODEL_IDS)[number];

export const LLM_IMAGE_MODEL_IDS = [...GEMINI_IMAGE_MODEL_IDS] as const;
export type LlmImageModelId = (typeof LLM_IMAGE_MODEL_IDS)[number];

export const LLM_MODEL_IDS = [...LLM_TEXT_MODEL_IDS, ...LLM_IMAGE_MODEL_IDS] as const;
export type LlmModelId = (typeof LLM_MODEL_IDS)[number];

export function isLlmTextModelId(value: string): value is LlmTextModelId {
  return (
    isOpenAiModelId(value) ||
    isChatGptModelId(value) ||
    isFireworksModelId(value) ||
    isGeminiTextModelId(value)
  );
}

export function isLlmImageModelId(value: string): value is LlmImageModelId {
  return isGeminiImageModelId(value);
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
  readonly openAiReasoningEffort?: OpenAiReasoningEffort;
  readonly openAiTextFormat?: ResponseTextConfig["format"];
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

export type LlmGenerateImagesRequest = {
  readonly model: LlmImageModelId; // e.g. "gemini-3-pro-image-preview"
  readonly stylePrompt: string;
  readonly styleImages?: readonly LlmImageData[];
  readonly imagePrompts: readonly string[];
  readonly imageGradingPrompt: string;
  readonly maxAttempts?: number;
  readonly imageAspectRatio?: string;
  readonly imageSize?: LlmImageSize;
  readonly signal?: AbortSignal;
};

export type LlmFunctionTool<Schema extends z.ZodType, Output> = {
  readonly type?: "function";
  readonly description?: string;
  readonly inputSchema: Schema;
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
  readonly execute: (input: string) => Promise<Output> | Output;
};

export type LlmExecutableTool<Schema extends z.ZodType, Output> =
  | LlmFunctionTool<Schema, Output>
  | LlmCustomTool<Output>;

export type LlmToolSet = Record<string, LlmExecutableTool<z.ZodType, unknown>>;

export function tool<Schema extends z.ZodType, Output>(options: {
  readonly description?: string;
  readonly inputSchema: Schema;
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
};

export type LlmToolLoopStep = {
  readonly step: number;
  readonly modelVersion: string;
  readonly text?: string;
  readonly thoughts?: string;
  readonly toolCalls: readonly LlmToolCallResult[];
  readonly usage?: LlmUsageTokens;
  readonly costUsd: number;
};

export type LlmToolLoopResult = {
  readonly text: string;
  readonly thoughts: string;
  readonly steps: readonly LlmToolLoopStep[];
  readonly totalCostUsd: number;
};

export type LlmToolLoopRequest = LlmInput & {
  readonly model: LlmTextModelId;
  readonly tools: LlmToolSet;
  readonly modelTools?: readonly LlmToolConfig[];
  readonly maxSteps?: number;
  readonly openAiReasoningEffort?: OpenAiReasoningEffort;
  readonly onEvent?: (event: LlmStreamEvent) => void;
  readonly signal?: AbortSignal;
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
        data: `[omitted:${omittedBytes}b]`,
      };
    }
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
      });
      continue;
    }
    if (part.fileData?.fileUri) {
      throw new Error("fileData parts are not supported");
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

function toGeminiPart(part: LlmContentPart): GeminiPart {
  switch (part.type) {
    case "text":
      return {
        text: part.text,
        thought: part.thought === true ? true : undefined,
      };
    case "inlineData":
      return {
        inlineData: {
          data: part.data,
          mimeType: part.mimeType,
        },
      };
    default:
      throw new Error("Unsupported LLM content part");
  }
}

function convertLlmContentToGeminiContent(content: LlmContent): GeminiContent {
  const role = content.role === "assistant" ? "model" : "user";
  return {
    role,
    parts: content.parts.map(toGeminiPart),
  };
}

function resolveProvider(model: LlmModelId): { provider: LlmProvider; model: string } {
  if (isChatGptModelId(model)) {
    return { provider: "chatgpt", model: stripChatGptPrefix(model) };
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
  if (isOpenAiModelId(model)) {
    return { provider: "openai", model };
  }
  throw new Error(`Unsupported text model: ${model}`);
}

function isOpenAiCodexModel(modelId: string): boolean {
  return modelId.includes("codex");
}

function resolveOpenAiReasoningEffort(
  modelId: string,
  override?: OpenAiReasoningEffort,
): OpenAiReasoningEffort {
  if (override) {
    return override;
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

function mergeConsecutiveTextParts(parts: readonly LlmContentPart[]): LlmContentPart[] {
  if (parts.length === 0) {
    return [];
  }
  const merged: LlmContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      merged.push({ type: "inlineData", data: part.data, mimeType: part.mimeType });
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
      parts: parts.map((part) =>
        part.type === "text"
          ? {
              type: "text",
              text: part.text,
              thought: "thought" in part && part.thought === true ? true : undefined,
            }
          : { type: "inlineData", data: part.data, mimeType: part.mimeType },
      ),
    });
  }

  return contents;
}

function toOpenAiInput(contents: readonly LlmContent[]): unknown[] {
  // Keep the shape compatible with OpenAI Responses API input.
  const OPENAI_ROLE_FROM_LLM: Record<LlmRole, string> = {
    user: "user",
    assistant: "assistant",
    system: "system",
    developer: "developer",
    tool: "assistant",
  };

  return contents.map((content) => {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content.parts) {
      if (part.type === "text") {
        parts.push({ type: "input_text", text: part.text });
        continue;
      }
      const mimeType = part.mimeType;
      if (isInlineImageMime(mimeType)) {
        const dataUrl = `data:${mimeType};base64,${part.data}`;
        parts.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
        continue;
      }
      const fileData = decodeInlineDataBuffer(part.data).toString("base64");
      parts.push({
        type: "input_file",
        filename: guessInlineDataFilename(mimeType),
        file_data: fileData,
      });
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

function toChatGptInput(contents: readonly LlmContent[]): {
  instructions?: string;
  input: ChatGptInputItem[];
} {
  const instructionsParts: string[] = [];
  const input: ChatGptInputItem[] = [];
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
        const mimeType = part.mimeType ?? "application/octet-stream";
        parts.push({
          type: "output_text",
          text: isInlineImageMime(part.mimeType) ? `[image:${mimeType}]` : `[file:${mimeType}]`,
        });
      } else {
        if (isInlineImageMime(part.mimeType)) {
          const mimeType = part.mimeType ?? "application/octet-stream";
          const dataUrl = `data:${mimeType};base64,${part.data}`;
          parts.push({
            type: "input_image",
            image_url: dataUrl,
            detail: "auto",
          });
        } else {
          const fileData = decodeInlineDataBuffer(part.data).toString("base64");
          parts.push({
            type: "input_file",
            filename: guessInlineDataFilename(part.mimeType),
            file_data: fileData,
          });
        }
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
        const mimeType = part.mimeType ?? "application/octet-stream";
        if (isInlineImageMime(mimeType)) {
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
      default:
        throw new Error("Unsupported tool configuration");
    }
  });
}

function toOpenAiTools(tools: readonly LlmToolConfig[] | undefined): unknown[] | undefined {
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
    cachedTokens: next.cachedTokens ?? current.cachedTokens,
    responseTokens: next.responseTokens ?? current.responseTokens,
    responseImageTokens: next.responseImageTokens ?? current.responseImageTokens,
    thinkingTokens: next.thinkingTokens ?? current.thinkingTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    toolUsePromptTokens: next.toolUsePromptTokens ?? current.toolUsePromptTokens,
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

async function executeToolCall(params: {
  callKind: "function" | "custom";
  toolName: string;
  tool: LlmExecutableTool<z.ZodType, unknown> | undefined;
  rawInput: unknown;
  parseError?: string;
}): Promise<{ result: LlmToolCallResult; outputPayload: unknown }> {
  const { callKind, toolName, tool, rawInput, parseError } = params;
  if (!tool) {
    const message = `Unknown tool: ${toolName}`;
    return {
      result: { toolName, input: rawInput, output: { error: message }, error: message },
      outputPayload: buildToolErrorOutput(message),
    };
  }
  if (callKind === "custom") {
    if (!isCustomTool(tool)) {
      const message = `Tool ${toolName} was called as custom_tool_call but is declared as function.`;
      const outputPayload = buildToolErrorOutput(message);
      return {
        result: { toolName, input: rawInput, output: outputPayload, error: message },
        outputPayload,
      };
    }
    const input = typeof rawInput === "string" ? rawInput : String(rawInput ?? "");
    try {
      const output = await tool.execute(input);
      return {
        result: { toolName, input, output },
        outputPayload: output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outputPayload = buildToolErrorOutput(`Tool ${toolName} failed: ${message}`);
      return {
        result: { toolName, input, output: outputPayload, error: message },
        outputPayload,
      };
    }
  }
  if (isCustomTool(tool)) {
    const message = `Tool ${toolName} was called as function_call but is declared as custom.`;
    const outputPayload = buildToolErrorOutput(message);
    return {
      result: { toolName, input: rawInput, output: outputPayload, error: message },
      outputPayload,
    };
  }
  if (parseError) {
    const message = `Invalid JSON for tool ${toolName}: ${parseError}`;
    return {
      result: { toolName, input: rawInput, output: { error: message }, error: message },
      outputPayload: buildToolErrorOutput(message),
    };
  }
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const message = `Invalid tool arguments for ${toolName}: ${formatZodIssues(parsed.error.issues)}`;
    const outputPayload = buildToolErrorOutput(message, parsed.error.issues);
    return {
      result: { toolName, input: rawInput, output: outputPayload, error: message },
      outputPayload,
    };
  }
  try {
    const output = await tool.execute(parsed.data);
    return {
      result: { toolName, input: parsed.data, output },
      outputPayload: output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outputPayload = buildToolErrorOutput(`Tool ${toolName} failed: ${message}`);
    return {
      result: { toolName, input: parsed.data, output: outputPayload, error: message },
      outputPayload,
    };
  }
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
function resolveGeminiThinkingConfig(modelId: string): GenerateContentConfig["thinkingConfig"] {
  switch (modelId) {
    case "gemini-3-pro-preview":
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

async function runTextCall(params: {
  request: LlmTextRequest;
  queue: AsyncQueue<LlmStreamEvent>;
  abortController: AbortController;
}): Promise<LlmTextResult> {
  const { request, queue, abortController } = params;
  const providerInfo = resolveProvider(request.model);
  const provider = providerInfo.provider;
  const modelForProvider = providerInfo.model;
  const contents = resolveTextContents(request);
  if (contents.length === 0) {
    throw new Error("LLM call received an empty prompt.");
  }

  let modelVersion: string = request.model;
  let blocked = false;
  let grounding: GroundingMetadata | undefined;
  const responseParts: LlmContentPart[] = [];
  let responseRole: LlmRole | undefined;
  let latestUsage: LlmUsageTokens | undefined;
  let responseImages = 0;

  const pushDelta = (channel: "response" | "thought", text: string): void => {
    if (!text) {
      return;
    }
    responseParts.push({ type: "text", text, ...(channel === "thought" ? { thought: true } : {}) });
    queue.push({ type: "delta", channel, text });
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

  if (provider === "openai") {
    const openAiInput = toOpenAiInput(contents);
    const openAiTools = toOpenAiTools(request.tools);
    const reasoningEffort = resolveOpenAiReasoningEffort(
      modelForProvider,
      request.openAiReasoningEffort,
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
            queue.push({ type: "blocked" });
            break;
          }
          default:
            break;
        }
      }

      const finalResponse = await (stream as any).finalResponse();
      modelVersion = typeof finalResponse.model === "string" ? finalResponse.model : request.model;
      queue.push({ type: "model", modelVersion });
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

      // Fallback: if the stream did not deliver deltas (rare), extract from final output.
      if (responseParts.length === 0) {
        const fallback = extractOpenAiResponseParts(finalResponse);
        blocked = blocked || fallback.blocked;
        for (const part of fallback.parts) {
          if (part.type === "text") {
            pushDelta(part.thought === true ? "thought" : "response", part.text);
          } else {
            pushInline(part.data, part.mimeType);
          }
        }
      }
    }, modelForProvider);
  } else if (provider === "chatgpt") {
    const chatGptInput = toChatGptInput(contents);
    const reasoningEffort = resolveOpenAiReasoningEffort(
      request.model,
      request.openAiReasoningEffort,
    );
    const openAiTools = toOpenAiTools(request.tools);
    const requestPayload = {
      model: modelForProvider,
      store: false,
      stream: true,
      instructions: chatGptInput.instructions ?? "You are a helpful assistant.",
      input: chatGptInput.input,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: toOpenAiReasoningEffort(reasoningEffort), summary: "detailed" as const },
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
      queue.push({ type: "blocked" });
    }
    if (result.model) {
      modelVersion = `chatgpt-${result.model}`;
      queue.push({ type: "model", modelVersion });
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
      queue.push({ type: "model", modelVersion });

      const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
      if (choice?.finish_reason === "content_filter") {
        blocked = true;
        queue.push({ type: "blocked" });
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
    const geminiContents = contents.map(convertLlmContentToGeminiContent);
    const config: GenerateContentConfig = {
      maxOutputTokens: 32_000,
      thinkingConfig: resolveGeminiThinkingConfig(modelForProvider),
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
          queue.push({ type: "model", modelVersion });
        }
        if (chunk.promptFeedback?.blockReason) {
          blocked = true;
          queue.push({ type: "blocked" });
        }
        latestUsage = mergeTokenUpdates(latestUsage, extractGeminiUsageTokens(chunk.usageMetadata));
        const candidates = chunk.candidates;
        if (!candidates || candidates.length === 0) {
          continue;
        }
        const primary = candidates[0];
        if (primary && isModerationFinish(primary.finishReason)) {
          blocked = true;
          queue.push({ type: "blocked" });
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
            } else {
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
    mergedParts.length > 0 ? { role: responseRole ?? "assistant", parts: mergedParts } : undefined;
  const { text, thoughts } = extractTextByChannel(content);

  const costUsd = estimateCallCostUsd({
    modelId: modelVersion,
    tokens: latestUsage,
    responseImages,
    imageSize: request.imageSize,
  });

  if (latestUsage) {
    queue.push({ type: "usage", usage: latestUsage, costUsd, modelVersion });
  }

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
}

export function streamText(request: LlmTextRequest): LlmTextStream {
  const queue = createAsyncQueue<LlmStreamEvent>();
  const abortController = new AbortController();

  const result = (async () => {
    try {
      const output = await runTextCall({ request, queue, abortController });
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
    abort: () => abortController.abort(),
  };
}

export async function generateText(request: LlmTextRequest): Promise<LlmTextResult> {
  const call = streamText(request);
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
      ? addGeminiPropertyOrdering(baseJsonSchema)
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

export function streamJson<T>(request: LlmJsonStreamRequest<T>): LlmJsonStream<T> {
  const queue = createAsyncQueue<LlmJsonStreamEvent<T>>();
  const abortController = new AbortController();

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
    const signal = resolveAbortSignal();
    const maxAttempts = Math.max(1, Math.floor(request.maxAttempts ?? 2));
    const { providerInfo, responseJsonSchema, openAiTextFormat } = buildJsonSchemaConfig(request);
    const streamMode = request.streamMode ?? "partial";

    const failures: Array<{ attempt: number; rawText: string; error: unknown }> = [];
    let openAiTextFormatForAttempt: ResponseTextConfig["format"] | undefined = openAiTextFormat;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
          openAiReasoningEffort: request.openAiReasoningEffort,
          ...(openAiTextFormatForAttempt ? { openAiTextFormat: openAiTextFormatForAttempt } : {}),
          signal,
        });

        try {
          for await (const event of call.events) {
            queue.push(event);
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
          typeof request.normalizeJson === "function" ? request.normalizeJson(payload) : payload;
        const parsed = request.schema.parse(normalized);
        queue.push({ type: "json", stage: "final", value: parsed });
        queue.close();
        return { value: parsed, rawText, result };
      } catch (error) {
        const handled = error instanceof Error ? error : new Error(String(error));
        failures.push({ attempt, rawText, error: handled });
        if (providerInfo.provider === "chatgpt" && openAiTextFormatForAttempt) {
          // Best-effort fallback: some ChatGPT accounts/models may not support json_schema.
          openAiTextFormatForAttempt = undefined;
        }
        if (attempt >= maxAttempts) {
          throw new LlmJsonCallError(`LLM JSON call failed after ${attempt} attempt(s)`, failures);
        }
      }
    }

    throw new LlmJsonCallError("LLM JSON call failed", failures);
  })().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    queue.fail(err);
    throw err;
  });

  return {
    events: queue.iterable,
    result,
    abort: () => abortController.abort(),
  };
}

export async function generateJson<T>(request: LlmJsonRequest<T>): Promise<{
  readonly value: T;
  readonly rawText: string;
  readonly result: LlmTextResult;
}> {
  const maxAttempts = Math.max(1, Math.floor(request.maxAttempts ?? 2));
  const { providerInfo, responseJsonSchema, openAiTextFormat } = buildJsonSchemaConfig(request);
  let openAiTextFormatForAttempt: ResponseTextConfig["format"] | undefined = openAiTextFormat;

  const failures: Array<{ attempt: number; rawText: string; error: unknown }> = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let rawText = "";
    try {
      const call = streamText({
        model: request.model,
        input: request.input,
        instructions: request.instructions,
        tools: request.tools,
        responseMimeType: request.responseMimeType ?? "application/json",
        responseJsonSchema,
        openAiReasoningEffort: request.openAiReasoningEffort,
        ...(openAiTextFormatForAttempt ? { openAiTextFormat: openAiTextFormatForAttempt } : {}),
        signal: request.signal,
      });

      // Collect the raw text output (response channel only).
      try {
        for await (const event of call.events) {
          request.onEvent?.(event);
          if (event.type === "delta" && event.channel === "response") {
            rawText += event.text;
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
        typeof request.normalizeJson === "function" ? request.normalizeJson(payload) : payload;
      const parsed = request.schema.parse(normalized);
      return { value: parsed, rawText, result };
    } catch (error) {
      const handled = error instanceof Error ? error : new Error(String(error));
      failures.push({ attempt, rawText, error: handled });
      if (providerInfo.provider === "chatgpt" && openAiTextFormatForAttempt) {
        // Best-effort fallback: some ChatGPT accounts/models may not support json_schema.
        openAiTextFormatForAttempt = undefined;
      }
      if (attempt >= maxAttempts) {
        throw new LlmJsonCallError(`LLM JSON call failed after ${attempt} attempt(s)`, failures);
      }
    }
  }

  throw new LlmJsonCallError("LLM JSON call failed", failures);
}

// --- Tool Loop ---

const DEFAULT_TOOL_LOOP_MAX_STEPS = 8;

function resolveToolLoopContents(input: LlmInput): readonly LlmContent[] {
  return resolveTextContents(input);
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

  const steps: LlmToolLoopStep[] = [];
  let totalCostUsd = 0;
  let finalText = "";
  let finalThoughts = "";

  if (providerInfo.provider === "openai") {
    const openAiAgentTools = buildOpenAiToolsFromToolSet(request.tools);
    const openAiNativeTools = toOpenAiTools(request.modelTools);
    const openAiTools = openAiNativeTools
      ? [...openAiNativeTools, ...openAiAgentTools]
      : [...openAiAgentTools];
    const reasoningEffort = resolveOpenAiReasoningEffort(
      providerInfo.model,
      request.openAiReasoningEffort,
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
    let input: any = toOpenAiInput(contents);

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const turn = stepIndex + 1;
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

      const emitEvent = (ev: LlmStreamEvent) => {
        onEvent?.(ev);
      };

      const finalResponse = await runOpenAiCall(async (client) => {
        const stream = client.responses.stream(
          {
            model: providerInfo.model,
            input,
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
          switch (event.type) {
            case "response.output_text.delta":
              emitEvent({
                type: "delta",
                channel: "response",
                text: typeof event.delta === "string" ? event.delta : "",
              });
              break;
            case "response.reasoning_summary_text.delta":
              emitEvent({
                type: "delta",
                channel: "thought",
                text: typeof event.delta === "string" ? event.delta : "",
              });
              break;
            case "response.refusal.delta":
              emitEvent({ type: "blocked" });
              break;
            default:
              break;
          }
        }
        return await (stream as any).finalResponse();
      }, providerInfo.model);

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

      const responseText = extractOpenAiResponseParts(finalResponse)
        .parts.filter((p) => p.type === "text" && p.thought !== true)
        .map((p) => (p as any).text as string)
        .join("")
        .trim();
      const reasoningSummary = extractOpenAiReasoningSummary(finalResponse).trim();

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

      const stepToolCalls: LlmToolCallResult[] = [];
      if (responseToolCalls.length === 0) {
        finalText = responseText;
        finalThoughts = reasoningSummary;
        steps.push({
          step: steps.length + 1,
          modelVersion,
          text: responseText || undefined,
          thoughts: reasoningSummary || undefined,
          toolCalls: [],
          usage: usageTokens,
          costUsd: stepCostUsd,
        });
        return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
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

      const callResults = await Promise.all(
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
              });
              return { entry, result, outputPayload };
            },
          );
        }),
      );

      const toolOutputs: any[] = [];
      for (const { entry, result, outputPayload } of callResults) {
        stepToolCalls.push({ ...result, callId: entry.call.call_id });
        if (entry.call.kind === "custom") {
          toolOutputs.push({
            type: "custom_tool_call_output",
            call_id: entry.call.call_id,
            output: mergeToolOutput(outputPayload),
          });
        } else {
          toolOutputs.push({
            type: "function_call_output",
            call_id: entry.call.call_id,
            output: mergeToolOutput(outputPayload),
          });
        }
      }

      steps.push({
        step: steps.length + 1,
        modelVersion,
        text: responseText || undefined,
        thoughts: reasoningSummary || undefined,
        toolCalls: stepToolCalls,
        usage: usageTokens,
        costUsd: stepCostUsd,
      });

      previousResponseId = (finalResponse as any).id;
      input = toolOutputs;
    }

    throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
  }

  if (providerInfo.provider === "chatgpt") {
    const openAiAgentTools = buildOpenAiToolsFromToolSet(request.tools);
    const openAiNativeTools = toOpenAiTools(request.modelTools);
    const openAiTools = openAiNativeTools
      ? [...openAiNativeTools, ...openAiAgentTools]
      : [...openAiAgentTools];

    const reasoningEffort = resolveOpenAiReasoningEffort(
      request.model,
      request.openAiReasoningEffort,
    );
    const toolLoopInput = toChatGptInput(contents);
    // ChatGPT Codex prompt caching is keyed by both prompt_cache_key and session_id.
    const conversationId = `tool-loop-${randomBytes(8).toString("hex")}`;
    const promptCacheKey = conversationId;
    let input: ChatGptInputItem[] = [...toolLoopInput.input];

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const turn = stepIndex + 1;
      const response = await collectChatGptCodexResponseWithRetry({
        sessionId: conversationId,
        request: {
          model: providerInfo.model,
          store: false,
          stream: true,
          instructions: toolLoopInput.instructions ?? "You are a helpful assistant.",
          input,
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
        } as any,
        signal: request.signal,
        onDelta: (delta) => {
          if (delta.thoughtDelta) {
            request.onEvent?.({ type: "delta", channel: "thought", text: delta.thoughtDelta });
          }
          if (delta.textDelta) {
            request.onEvent?.({ type: "delta", channel: "response", text: delta.textDelta });
          }
        },
      });

      const modelVersion = response.model ? `chatgpt-${response.model}` : request.model;
      const usageTokens = extractChatGptUsageTokens(response.usage);
      const stepCostUsd = estimateCallCostUsd({
        modelId: modelVersion,
        tokens: usageTokens,
        responseImages: 0,
      });
      totalCostUsd += stepCostUsd;

      const responseText = (response.text ?? "").trim();
      const reasoningSummaryText = (response.reasoningSummaryText ?? "").trim();

      const responseToolCalls = response.toolCalls ?? [];
      if (responseToolCalls.length === 0) {
        finalText = responseText;
        finalThoughts = reasoningSummaryText;
        steps.push({
          step: steps.length + 1,
          modelVersion,
          text: responseText || undefined,
          thoughts: reasoningSummaryText || undefined,
          toolCalls: [],
          usage: usageTokens,
          costUsd: stepCostUsd,
        });
        return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
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

      const callResults = await Promise.all(
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
              });
              return { entry, result, outputPayload };
            },
          );
        }),
      );

      for (const { entry, result, outputPayload } of callResults) {
        toolCalls.push({ ...result, callId: entry.ids.callId });
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
            output: mergeToolOutput(outputPayload),
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
            output: mergeToolOutput(outputPayload),
          } as ChatGptInputItem);
        }
      }

      steps.push({
        step: steps.length + 1,
        modelVersion,
        text: responseText || undefined,
        thoughts: reasoningSummaryText || undefined,
        toolCalls,
        usage: usageTokens,
        costUsd: stepCostUsd,
      });

      input = input.concat(toolOutputs);
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
      const response = await runFireworksCall(async (client) => {
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
      }, providerInfo.model);

      const modelVersion = typeof response.model === "string" ? response.model : request.model;
      request.onEvent?.({ type: "model", modelVersion });

      const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
      if (choice?.finish_reason === "content_filter") {
        request.onEvent?.({ type: "blocked" });
      }
      const message = (choice as { message?: unknown } | undefined)?.message;
      const responseText = extractFireworksMessageText(message).trim();
      if (responseText.length > 0) {
        request.onEvent?.({ type: "delta", channel: "response", text: responseText });
      }

      const usageTokens = extractFireworksUsageTokens(response.usage);
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
      if (responseToolCalls.length === 0) {
        finalText = responseText;
        finalThoughts = "";
        steps.push({
          step: steps.length + 1,
          modelVersion,
          text: responseText || undefined,
          thoughts: undefined,
          toolCalls: [],
          usage: usageTokens,
          costUsd: stepCostUsd,
        });
        return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
      }

      const stepToolCalls: LlmToolCallResult[] = [];
      const callInputs = responseToolCalls.map((call, index) => {
        const toolIndex = index + 1;
        const toolId = buildToolLogId(turn, toolIndex);
        const { value, error: parseError } = parseOpenAiToolArguments(call.arguments);
        return { call, toolName: call.name, value, parseError, toolId, turn, toolIndex };
      });

      const callResults = await Promise.all(
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
              });
              return { entry, result, outputPayload };
            },
          );
        }),
      );

      const assistantToolCalls: Array<Record<string, unknown>> = [];
      const toolMessages: Array<Record<string, unknown>> = [];
      for (const { entry, result, outputPayload } of callResults) {
        stepToolCalls.push({ ...result, callId: entry.call.id });
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

      steps.push({
        step: steps.length + 1,
        modelVersion,
        text: responseText || undefined,
        thoughts: undefined,
        toolCalls: stepToolCalls,
        usage: usageTokens,
        costUsd: stepCostUsd,
      });

      messages.push({
        role: "assistant",
        ...(responseText.length > 0 ? { content: responseText } : {}),
        tool_calls: assistantToolCalls,
      });
      messages.push(...toolMessages);
    }

    throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
  }

  // Gemini provider
  const geminiFunctionTools = buildGeminiFunctionDeclarations(request.tools);
  const geminiNativeTools = toGeminiTools(request.modelTools);
  const geminiTools = geminiNativeTools
    ? geminiNativeTools.concat(geminiFunctionTools)
    : geminiFunctionTools;
  const geminiContents = contents.map(convertLlmContentToGeminiContent);

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const config: GenerateContentConfig = {
      maxOutputTokens: 32_000,
      tools: geminiTools,
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.VALIDATED,
        },
      },
      thinkingConfig: resolveGeminiThinkingConfig(request.model),
    };

    const onEvent = request.onEvent;

    type GeminiToolLoopResponse = {
      readonly responseText: string;
      readonly thoughtsText: string;
      readonly functionCalls: Array<NonNullable<GeminiPart["functionCall"]>>;
      readonly modelParts: GeminiPart[];
      readonly usageMetadata?: unknown;
      readonly modelVersion?: string;
    };

    const response: GeminiToolLoopResponse = await runGeminiCall(async (client) => {
      const stream = await client.models.generateContentStream({
        model: request.model,
        contents: geminiContents,
        config,
      });
      let responseText = "";
      let thoughtsText = "";
      const modelParts: GeminiPart[] = [];
      const functionCalls: Array<NonNullable<GeminiPart["functionCall"]>> = [];
      const seenFunctionCallIds = new Set<string>();
      const seenFunctionCallKeys = new Set<string>();
      let latestUsageMetadata: unknown;
      let resolvedModelVersion: string | undefined;

      for await (const chunk of stream) {
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
        const parts = primary?.content?.parts;
        if (!parts || parts.length === 0) {
          continue;
        }

        for (const part of parts) {
          modelParts.push(part);
          const call = part.functionCall;
          if (call) {
            const id = typeof call.id === "string" ? call.id : "";
            const shouldAdd = (() => {
              if (id.length > 0) {
                if (seenFunctionCallIds.has(id)) {
                  return false;
                }
                seenFunctionCallIds.add(id);
                return true;
              }
              const key = JSON.stringify({ name: call.name ?? "", args: call.args ?? null });
              if (seenFunctionCallKeys.has(key)) {
                return false;
              }
              seenFunctionCallKeys.add(key);
              return true;
            })();
            if (shouldAdd) {
              functionCalls.push(call);
            }
          }
          if (typeof part.text === "string" && part.text.length > 0) {
            if (part.thought) {
              thoughtsText += part.text;
              onEvent?.({ type: "delta", channel: "thought", text: part.text });
            } else {
              responseText += part.text;
              onEvent?.({ type: "delta", channel: "response", text: part.text });
            }
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
    }, request.model);

    const usageTokens = extractGeminiUsageTokens(response.usageMetadata);
    const modelVersion = response.modelVersion ?? request.model;
    const stepCostUsd = estimateCallCostUsd({
      modelId: modelVersion,
      tokens: usageTokens,
      responseImages: 0,
    });
    totalCostUsd += stepCostUsd;

    if (response.functionCalls.length === 0) {
      finalText = response.responseText.trim();
      finalThoughts = response.thoughtsText.trim();
      steps.push({
        step: steps.length + 1,
        modelVersion,
        text: finalText || undefined,
        thoughts: finalThoughts || undefined,
        toolCalls: [],
        usage: usageTokens,
        costUsd: stepCostUsd,
      });
      return { text: finalText, thoughts: finalThoughts, steps, totalCostUsd };
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
      const turn = stepIndex + 1;
      const toolIndex = index + 1;
      const toolId = buildToolLogId(turn, toolIndex);
      const toolName = call.name ?? "unknown";
      const rawInput = call.args ?? {};
      return { call, toolName, rawInput, toolId, turn, toolIndex };
    });

    const callResults = await Promise.all(
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
            });
            return { entry, result, outputPayload };
          },
        );
      }),
    );

    for (const { entry, result, outputPayload } of callResults) {
      toolCalls.push({ ...result, callId: entry.call.id });
      const responsePayload = isPlainRecord(outputPayload)
        ? outputPayload
        : { output: outputPayload };
      responseParts.push({
        functionResponse: {
          name: entry.toolName,
          response: responsePayload,
          ...(entry.call.id ? { id: entry.call.id } : {}),
        },
      });
    }

    steps.push({
      step: steps.length + 1,
      modelVersion,
      text: response.responseText.trim() || undefined,
      thoughts: response.thoughtsText.trim() || undefined,
      toolCalls,
      usage: usageTokens,
      costUsd: stepCostUsd,
    });

    geminiContents.push({ role: "user", parts: responseParts });
  }

  throw new Error(`Tool loop exceeded max steps (${maxSteps}) without final response.`);
}

// --- Images (Gemini image-preview) ---

const IMAGE_GRADE_SCHEMA = z.enum(["pass", "fail"]);

async function gradeGeneratedImage(params: {
  gradingPrompt: string;
  imagePrompt: string;
  image: LlmImageData;
  model: LlmTextModelId;
}): Promise<z.infer<typeof IMAGE_GRADE_SCHEMA>> {
  const parts: LlmContentPart[] = [
    {
      type: "text",
      text: [
        params.gradingPrompt,
        "",
        "Image prompt to grade:",
        params.imagePrompt,
        "",
        'Respond with the JSON string "pass" or "fail".',
      ].join("\\n"),
    },
    {
      type: "inlineData",
      data: params.image.data.toString("base64"),
      mimeType: params.image.mimeType ?? "image/png",
    },
  ];
  const { value } = await generateJson({
    model: params.model,
    input: [{ role: "user", content: parts }],
    schema: IMAGE_GRADE_SCHEMA,
  });
  return value;
}

export async function generateImages(request: LlmGenerateImagesRequest): Promise<LlmImageData[]> {
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

  const gradingPrompt = request.imageGradingPrompt.trim();
  if (!gradingPrompt) {
    throw new Error("imageGradingPrompt must be a non-empty string");
  }

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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await generateText({
      model: request.model,
      input: inputMessages,
      responseModalities: ["IMAGE", "TEXT"],
      imageAspectRatio: request.imageAspectRatio,
      imageSize: request.imageSize ?? "2K",
    });
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
            model: "gpt-5.2",
          }),
        ),
      );
      const passedEntries = new Set<number>();
      for (let i = 0; i < gradeResults.length; i += 1) {
        const grade = gradeResults[i];
        const entry = pendingAssignments[i];
        const image = assignedImages[i];
        if (!grade || !entry || !image) {
          continue;
        }
        if (grade === "pass") {
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
    inputMessages.push({ role: "user", content: buildContinuationPromptParts(promptEntries) });
  }

  const orderedImages: LlmImageData[] = [];
  for (const entry of orderedEntries) {
    const image = resolvedImages.get(entry.index);
    if (image) {
      orderedImages.push(image);
    }
  }

  return orderedImages.slice(0, numImages);
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
