import type { GoogleGenAI } from "@google/genai";

import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { createCallScheduler, type CallScheduler } from "../utils/scheduler.js";

import { getGeminiClient } from "./client.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
const RATE_LIMIT_REASONS = new Set(["RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"]);

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
  const retryDelay = (details as { retryDelay?: unknown }).retryDelay as
    | { seconds?: unknown; nanos?: unknown }
    | undefined;
  if (retryDelay) {
    const secondsRaw = retryDelay.seconds;
    const nanosRaw = retryDelay.nanos;
    const seconds =
      typeof secondsRaw === "number"
        ? secondsRaw
        : typeof secondsRaw === "string"
          ? Number.parseFloat(secondsRaw)
          : 0;
    const nanos =
      typeof nanosRaw === "number"
        ? nanosRaw
        : typeof nanosRaw === "string"
          ? Number.parseInt(nanosRaw, 10)
          : 0;
    if (Number.isFinite(seconds) || Number.isFinite(nanos)) {
      const totalMs = seconds * 1000 + nanos / 1_000_000;
      if (totalMs > 0) {
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
  const regex = /retry in\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(s|sec|secs|seconds?)/iu;
  const match = regex.exec(trimmed);
  if (match?.[1]) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) {
      return value * 1000;
    }
  }
  return undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
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
const schedulerByModel = new Map<string, CallScheduler>();

function getSchedulerForModel(modelId?: string): CallScheduler {
  const normalizedModelId = modelId?.trim();
  const schedulerKey =
    normalizedModelId && normalizedModelId.length > 0 ? normalizedModelId : DEFAULT_SCHEDULER_KEY;
  const existing = schedulerByModel.get(schedulerKey);
  if (existing) {
    return existing;
  }
  const created = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({
      providerEnvPrefix: "GOOGLE",
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
  schedulerByModel.set(schedulerKey, created);
  return created;
}

export async function runGeminiCall<T>(
  fn: (client: GoogleGenAI) => Promise<T>,
  modelId?: string,
): Promise<T> {
  return getSchedulerForModel(modelId).run(async () => fn(await getGeminiClient()));
}
