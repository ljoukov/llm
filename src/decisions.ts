import { randomUUID } from "node:crypto";

import { createGoogleDecision } from "./google/decisions.js";
import { hasControlCharacter, splitQualifiedModel, type ModelRefInput } from "./model-selection.js";
import { createTelemetrySession } from "./telemetry.js";
import { createTypesafeDecision } from "./typesafe/decisions.js";
import {
  DECISION_MODEL_IDS_BY_PROVIDER,
  type DecisionModelRef,
  type DecisionProvider,
} from "./decisions/models.js";
import { createOpenAiCompatibleDecision } from "./decisions/openai-compatible.js";
import { estimateDecisionCostUsd } from "./decisions/pricing.js";
import { normalizeDecisionResponse } from "./decisions/results.js";
import type {
  DecideRequest,
  DecisionInput,
  DecisionQuestions,
  DecisionResult,
} from "./decisions/types.js";

/** Resolve native and provider:api:model decision selections using the central reference parser. */
export function resolveDecisionModelRef(
  selection: ModelRefInput,
): DecisionModelRef & { readonly access: "api" } {
  if (
    typeof selection.model !== "string" ||
    !selection.model ||
    /\s/u.test(selection.model) ||
    hasControlCharacter(selection.model)
  ) {
    throw new Error("model must be a non-empty model ID without whitespace.");
  }
  const qualified = splitQualifiedModel(selection.model);
  if (qualified && selection.provider !== undefined && qualified.provider !== selection.provider) {
    throw new Error(`Conflicting provider: ${selection.provider} and ${qualified.provider}.`);
  }
  if (qualified && selection.access !== undefined && qualified.access !== selection.access) {
    throw new Error(`Conflicting access: ${selection.access} and ${qualified.access}.`);
  }
  const model = qualified?.model ?? selection.model;
  const access = qualified?.access ?? selection.access ?? "api";
  if (access !== "api") throw new Error("Decisions support API access only.");
  if (selection.speed !== undefined) throw new Error("Decisions do not support speed modifiers.");
  const provider =
    qualified?.provider ??
    selection.provider ??
    (Object.keys(DECISION_MODEL_IDS_BY_PROVIDER) as DecisionProvider[]).find((candidate) =>
      (DECISION_MODEL_IDS_BY_PROVIDER[candidate] as readonly string[]).includes(model),
    );
  if (
    !provider ||
    !Object.hasOwn(DECISION_MODEL_IDS_BY_PROVIDER, provider) ||
    !(DECISION_MODEL_IDS_BY_PROVIDER[provider as DecisionProvider] as readonly string[]).includes(
      model,
    )
  ) {
    throw new Error(
      `Unsupported decision model route: ${provider ?? "unknown"}:${access}:${model}.`,
    );
  }
  return { provider, access, model } as DecisionModelRef & { readonly access: "api" };
}

function validateInput(input: DecisionInput, provider: DecisionProvider): void {
  if (typeof input === "string") {
    if (!input.trim()) throw new Error("Decision input must not be empty.");
    return;
  }
  if (!Array.isArray(input) || input.length === 0)
    throw new Error("Decision input must not be empty.");
  for (const part of input) {
    if (!part || typeof part !== "object") throw new Error("Invalid decision input content.");
    if (part.type === "text") {
      if (typeof part.text !== "string" || !part.text.length)
        throw new Error("Decision text content must not be empty.");
      continue;
    }
    if (!["image", "audio", "video", "document"].includes(part.type))
      throw new Error("Unsupported decision content type.");
    if (provider === "fireworks" || provider === "typesafe")
      throw new Error(`${provider} Decisions supports text input only.`);
    if (provider === "openai" && part.type !== "image")
      throw new Error("OpenAI Decisions supports text and images only.");
    if (typeof part.mimeType !== "string" || !part.mimeType.trim())
      throw new Error("Decision media requires mimeType.");
    const hasUri = typeof part.uri === "string" && part.uri.length > 0;
    const hasData = typeof part.data === "string" && part.data.length > 0;
    if (hasUri === hasData)
      throw new Error("Decision media requires exactly one of uri or base64 data.");
    if (hasUri && !/^https?:\/\//u.test(part.uri ?? "")) {
      throw new Error("Decision media URI must be an HTTP(S) URL.");
    }
    if (part.resolution !== undefined) {
      if (!["low", "medium", "high", "ultra_high"].includes(part.resolution))
        throw new Error("Unsupported decision media resolution.");
      if (part.type !== "image" && part.type !== "video")
        throw new Error("Decision media resolution is supported for images and video only.");
      if (part.resolution === "ultra_high" && part.type !== "image")
        throw new Error("Ultra-high decision resolution is supported for images only.");
      if (provider === "openai" && part.resolution !== "low" && part.resolution !== "high")
        throw new Error("OpenAI Decisions image resolution must be low or high.");
    }
  }
}

function validateQuestions(questions: DecisionQuestions, provider: DecisionProvider): void {
  if (!questions || typeof questions !== "object" || Array.isArray(questions))
    throw new Error("Decision questions must be a map.");
  const entries = Object.entries(questions);
  const maxQuestions =
    provider === "google"
      ? 1_000
      : provider === "openai"
        ? 400
        : provider === "fireworks"
          ? 256
          : Infinity;
  if (entries.length < 1 || entries.length > maxQuestions)
    throw new Error(`Decisions require between 1 and ${maxQuestions} questions on this route.`);
  for (const [name, question] of entries) {
    if (!name || (provider === "google" && !/^[A-Za-z0-9_-]{1,64}$/u.test(name)))
      throw new Error(
        "Decision question names must contain 1–64 letters, digits, underscores or hyphens.",
      );
    if (!question || typeof question.instructions !== "string" || !question.instructions.trim())
      throw new Error("Every decision question requires instructions.");
    if (question.type === "boolean") {
      if (
        question.criteria !== undefined &&
        (!question.criteria ||
          typeof question.criteria !== "object" ||
          Array.isArray(question.criteria) ||
          Object.entries(question.criteria).some(
            ([key, value]) => !["true", "false"].includes(key) || typeof value !== "string",
          ))
      ) {
        throw new Error("Boolean decision criteria must contain true/false descriptions.");
      }
    } else if (question.type === "choice") {
      if (
        !question.criteria ||
        typeof question.criteria !== "object" ||
        Array.isArray(question.criteria)
      )
        throw new Error("Choice decision criteria must be a map of option descriptions.");
      const options = Object.entries(question.criteria);
      const maxChoices = provider === "fireworks" ? 208 : 255;
      if (options.length < 2 || options.length > maxChoices)
        throw new Error(`Choice decisions require 2–${maxChoices} options on this route.`);
      if (
        options.some(
          ([key, value]) =>
            !key || key.trim() !== key || hasControlCharacter(key) || typeof value !== "string",
        )
      )
        throw new Error("Choice options require non-empty IDs and string descriptions.");
    } else if (question.type === "score") {
      const maxLevels = provider === "google" ? 255 : 10;
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > maxLevels ||
        question.criteria.some((level) => typeof level !== "string" || !level.trim())
      )
        throw new Error(
          `Score decisions require 2–${maxLevels} non-empty ordered levels on this route.`,
        );
    } else throw new Error("Unsupported decision question type.");
  }
}

/** Evaluate bounded Boolean, choice, and rubric questions through native System 1 endpoints. */
export async function decide<const Q extends DecisionQuestions>(
  request: DecideRequest<Q>,
): Promise<DecisionResult<Q>> {
  const route = resolveDecisionModelRef(request);
  validateInput(request.input, route.provider);
  validateQuestions(request.questions, route.provider);
  request.signal?.throwIfAborted();
  const started = Date.now();
  const session = createTelemetrySession(request.telemetry);
  const base = { callId: randomUUID(), operation: "decide" as const, ...route };
  session?.emit({
    ...base,
    type: "llm.call.started",
    timestamp: new Date().toISOString(),
    inputMode: typeof request.input === "string" ? "string" : "messages",
  });
  try {
    const options = {
      model: route.model,
      input: request.input,
      questions: request.questions,
      signal: request.signal,
    };
    const rawResponse =
      route.provider === "google"
        ? await createGoogleDecision(options)
        : route.provider === "typesafe"
          ? await createTypesafeDecision(options)
          : await createOpenAiCompatibleDecision({ ...options, provider: route.provider });
    const normalized = normalizeDecisionResponse(rawResponse, request.questions);
    const costUsd = estimateDecisionCostUsd(route.provider, normalized.usage);
    const result: DecisionResult<Q> = {
      ...route,
      ...normalized,
      answers: normalized.answers as DecisionResult<Q>["answers"],
      costUsd,
      costSource: costUsd === null ? "unknown" : "estimate",
      durationMs: Date.now() - started,
      rawResponse,
    };
    session?.emit({
      ...base,
      type: "llm.call.completed",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: result.durationMs,
      usage: result.usage,
      modelVersion: result.modelVersion,
      costUsd,
      costSource: result.costSource,
    });
    return result;
  } catch (error) {
    session?.emit({
      ...base,
      type: "llm.call.completed",
      timestamp: new Date().toISOString(),
      success: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Decision request failed.",
    });
    throw error;
  } finally {
    await session?.flush();
  }
}
