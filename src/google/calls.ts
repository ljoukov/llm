import type { GoogleGenAI } from "@google/genai";

import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

import { getGeminiClient } from "./client.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
const RATE_LIMIT_REASONS = new Set(["RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"]);
const STREAM_INTERRUPTED = Symbol.for("@ljoukov/llm.googleStreamInterrupted");

class GeminiStreamInterruptedError extends Error {
  readonly [STREAM_INTERRUPTED] = true;
  readonly status: number | undefined;

  constructor(cause: unknown) {
    super(getErrorMessage(cause) || "Google response stream interrupted", { cause });
    this.name = "GeminiStreamInterruptedError";
    this.status = getStatus(cause);
  }
}

/** An interrupted response must not replay chunks that a caller has already observed. */
export async function* guardGeminiStreamRetries<T>(stream: AsyncIterable<T>): AsyncGenerator<T> {
  let receivedChunk = false;
  try {
    for await (const chunk of stream) {
      receivedChunk = true;
      yield chunk;
    }
  } catch (error) {
    if (receivedChunk) {
      throw new GeminiStreamInterruptedError(error);
    }
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybe = error as { name?: unknown; code?: unknown; cause?: unknown };
  return (
    maybe.name === "AbortError" ||
    maybe.code === "ABORT_ERR" ||
    (!!maybe.cause && maybe.cause !== error && isAbortError(maybe.cause))
  );
}

function getStatus(error: unknown): number | undefined {
  const maybe = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const candidates = [maybe?.status, maybe?.statusCode, maybe?.response?.status];
  for (const value of candidates) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  if (typeof maybe?.code === "number") {
    return maybe.code;
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const maybe = error as { code?: unknown; cause?: unknown };
  if (typeof maybe.code === "string") {
    return maybe.code;
  }
  if (maybe.cause && typeof maybe.cause === "object") {
    const causeCode = (maybe.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") {
      return causeCode;
    }
  }
  return undefined;
}

function getErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const details = (error as { errorDetails?: unknown }).errorDetails;
  if (Array.isArray(details) && details.length > 0) {
    const reason = (details[0] as { reason?: unknown }).reason;
    if (typeof reason === "string") {
      return reason;
    }
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nestedDetails = (cause as { errorDetails?: unknown }).errorDetails;
    if (Array.isArray(nestedDetails) && nestedDetails.length > 0) {
      const reason = (nestedDetails[0] as { reason?: unknown }).reason;
      if (typeof reason === "string") {
        return reason;
      }
    }
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function parseDurationPart(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  return typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
}

function parseRetryInfo(details: unknown): number | undefined {
  if (Array.isArray(details)) {
    for (const entry of details) {
      const ms = parseRetryInfo(entry);
      if (ms !== undefined) {
        return ms;
      }
    }
    return undefined;
  }
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const retryDelay = (details as { retryDelay?: unknown }).retryDelay;
  if (typeof retryDelay === "string" && /^\d+(?:\.\d{1,9})?s$/u.test(retryDelay)) {
    const totalMs = Number(retryDelay.slice(0, -1)) * 1000;
    if (Number.isFinite(totalMs)) {
      return totalMs;
    }
  }
  if (retryDelay && typeof retryDelay === "object") {
    const delay = retryDelay as { seconds?: unknown; nanos?: unknown };
    const seconds = parseDurationPart(delay.seconds);
    const nanos = parseDurationPart(delay.nanos);
    if (
      Number.isFinite(seconds) &&
      Number.isFinite(nanos) &&
      seconds >= 0 &&
      nanos >= 0 &&
      nanos < 1_000_000_000
    ) {
      const totalMs = seconds * 1000 + nanos / 1_000_000;
      if (Number.isFinite(totalMs)) {
        return totalMs;
      }
    }
  }
  const nestedDetails = (details as { details?: unknown }).details;
  if (nestedDetails) {
    const nested = parseRetryInfo(nestedDetails);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function parseRetryAfterFromMessage(message: string): number | undefined {
  const trimmed = message.trim();
  if (!trimmed) {
    return undefined;
  }
  const regex = /retry in\s+([0-9]+(?:\.[0-9]+)?)\s*(s|sec|secs|seconds?)/iu;
  const match = regex.exec(trimmed);
  if (match?.[1]) {
    const value = Number.parseFloat(match[1]);
    const delayMs = value * 1000;
    if (Number.isFinite(delayMs) && value >= 0) {
      return delayMs;
    }
  }
  return undefined;
}

function retryAfterHeader(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const headerRecord = headers as Record<string, unknown>;
  const getter = headerRecord.get;
  const value =
    typeof getter === "function"
      ? getter.call(headers, "retry-after")
      : Object.entries(headerRecord).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  const firstValue = Array.isArray(value) ? value[0] : value;
  if (typeof firstValue !== "string" && typeof firstValue !== "number") {
    return undefined;
  }
  const trimmed = String(firstValue).trim();
  if (!trimmed) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds)) {
    const delayMs = seconds * 1000;
    return seconds >= 0 && Number.isFinite(delayMs) ? delayMs : undefined;
  }
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybe = error as { headers?: unknown; response?: { headers?: unknown } };
  const headerDelay = retryAfterHeader(maybe.headers) ?? retryAfterHeader(maybe.response?.headers);
  if (headerDelay !== undefined) {
    return headerDelay;
  }

  const infoFromDetails = parseRetryInfo((error as { errorDetails?: unknown }).errorDetails);
  if (infoFromDetails !== undefined) {
    return infoFromDetails;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nested = getRetryAfterMs(cause);
    if (nested !== undefined) {
      return nested;
    }
  }

  const message = getErrorMessage(error);
  if (message) {
    const fromMessage = parseRetryAfterFromMessage(message.toLowerCase());
    if (fromMessage !== undefined) {
      return fromMessage;
    }
  }

  return undefined;
}

function shouldRetry(error: unknown): boolean {
  if (isAbortError(error) || (error && typeof error === "object" && STREAM_INTERRUPTED in error)) {
    return false;
  }
  const status = getStatus(error);
  if (status && RETRYABLE_STATUSES.has(status)) {
    return true;
  }

  const reason = getErrorReason(error);
  if (reason && RATE_LIMIT_REASONS.has(reason)) {
    return true;
  }

  const code = getErrorCode(error);
  if (code && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("rate limit") || message.includes("temporarily unavailable")) {
    return true;
  }
  if (message.includes("fetch failed") || message.includes("socket hang up")) {
    return true;
  }
  if (message.includes("quota") || message.includes("insufficient")) {
    return false;
  }
  if (message.includes("timeout") || message.includes("network")) {
    return true;
  }
  return false;
}

function isOverloadError(error: unknown): boolean {
  const status = getStatus(error);
  if (status === 429 || status === 503 || status === 529) {
    return true;
  }

  const reason = getErrorReason(error);
  if (reason && RATE_LIMIT_REASONS.has(reason)) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("resource exhausted") ||
    message.includes("resource_exhausted")
  );
}

function retryDelayMs(attempt: number): number {
  const baseRetryDelayMs = 500;
  const maxRetryDelayMs = 4000;
  const base = Math.min(maxRetryDelayMs, baseRetryDelayMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
}

const DEFAULT_SCHEDULER_KEY = "__default__";
const googleCallState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.googleCallState"), () => ({
  schedulerByModel: new Map<string, CallScheduler>(),
}));

function getSchedulerForModel(modelId?: string): CallScheduler {
  const normalizedModelId = modelId?.trim();
  const schedulerKey =
    normalizedModelId && normalizedModelId.length > 0 ? normalizedModelId : DEFAULT_SCHEDULER_KEY;
  const existing = googleCallState.schedulerByModel.get(schedulerKey);
  if (existing) {
    return existing;
  }
  const created = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({
      provider: "google",
      modelId: normalizedModelId,
    }),
    minIntervalBetweenStartMs: 200,
    startJitterMs: 200,
    isOverloadError,
    retry: {
      maxAttempts: 3,
      getDelayMs: (attempt, error) => {
        if (!shouldRetry(error)) {
          return null;
        }
        const hintedDelay = getRetryAfterMs(error);
        return hintedDelay ?? retryDelayMs(attempt);
      },
    },
  });
  googleCallState.schedulerByModel.set(schedulerKey, created);
  return created;
}

export async function runGeminiCall<T>(
  fn: (client: GoogleGenAI) => Promise<T>,
  modelId?: string,
  runOptions?: CallSchedulerRunOptions,
): Promise<T> {
  return getSchedulerForModel(modelId).run(async () => fn(await getGeminiClient()), runOptions);
}
