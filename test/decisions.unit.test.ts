import { beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({ google: vi.fn(), compatible: vi.fn(), typesafe: vi.fn() }));
vi.mock("../src/google/decisions.js", () => ({ createGoogleDecision: adapters.google }));
vi.mock("../src/decisions/openai-compatible.js", () => ({
  createOpenAiCompatibleDecision: adapters.compatible,
}));
vi.mock("../src/typesafe/decisions.js", () => ({ createTypesafeDecision: adapters.typesafe }));

import { decide, resolveDecisionModelRef } from "../src/decisions.js";
import { LLM_DECISION_MODEL_IDS } from "../src/decisions/models.js";
import { estimateDecisionCostUsd } from "../src/decisions/pricing.js";
import type { DecideRequest } from "../src/decisions/types.js";
import { getSupportedModelSpeeds } from "../src/model-selection.js";
import type { TelemetryEvent } from "../src/telemetry.js";

const questions = {
  refund: { type: "boolean", instructions: "Does the customer request a refund?" },
} as const;
const mapResponse = {
  answers: { refund: { type: "noul", noul: 0.9, confidence: 0.8 } },
  usage: { input_tokens: 100, output_tokens: 0 },
};

// Keep decision model IDs closed and route-specific at compile time.
const _valid = {
  model: "google:api:gemini-decision-1",
  input: "hello",
  questions,
} satisfies DecideRequest;
const _unknown = {
  provider: "openai",
  // @ts-expect-error Arbitrary OpenAI model IDs are not accepted.
  model: "gpt-arbitrary",
  input: "hello",
  questions,
} satisfies DecideRequest;
// @ts-expect-error Decision-only Gemini models cannot use the OpenAI route.
const _wrongProvider: DecideRequest = {
  provider: "openai",
  model: "gemini-decision-1",
  input: "hello",
  questions,
};
const _subscription = {
  // @ts-expect-error Decisions have no subscription route.
  model: "openai:subscription:gpt-6-luna",
  input: "hello",
  questions,
} satisfies DecideRequest;
const _speed = {
  model: "gpt-6-luna",
  // @ts-expect-error Decisions do not have serving speed modifiers.
  speed: "fast",
  input: "hello",
  questions,
} satisfies DecideRequest;

beforeEach(() => {
  vi.clearAllMocks();
  adapters.google.mockResolvedValue(mapResponse);
  adapters.typesafe.mockResolvedValue(mapResponse);
  adapters.compatible.mockResolvedValue({
    ...mapResponse,
    answers: [{ name: "refund", type: "predicate", probability: 0.9 }],
  });
});

describe("unified decisions", () => {
  it.each([
    ["google:api:gemini-decision-1", "google"],
    ["openai:api:gpt-6-luna", "openai"],
    ["fireworks:api:accounts/fireworks/models/rune", "fireworks"],
    ["typesafe:api:jev-1.14.0", "typesafe"],
  ] as const)("resolves and normalizes %s", async (model, provider) => {
    const route = resolveDecisionModelRef({ model });
    const result = await decide({
      ...route,
      input: "Please refund the duplicate charge.",
      questions,
    });
    expect(result).toMatchObject({
      provider,
      access: "api",
      answers: { refund: { type: "boolean", probability: 0.9 } },
      usage: { promptTokens: 100, responseTokens: 0, totalTokens: 100 },
      costSource: "estimate",
    });
    expect(result.costUsd).toBeCloseTo(
      100 * ((provider === "openai" || provider === "google" ? 0.1 : 0.042) / 1_000_000),
    );
    expect(result.rawResponse).toBeDefined();
  });

  it("infers the native provider and preserves typed answers", async () => {
    const result = await decide({ model: "gemini-decision-1", input: "Refund me", questions });
    if (result.answers.refund.type !== "refusal")
      expect(result.answers.refund.probability).toBe(0.9);
    expect(adapters.google).toHaveBeenCalledOnce();
    expect(adapters.compatible).not.toHaveBeenCalled();
  });

  it.each([
    { model: "openai:api:gpt-6-luna", provider: "google" },
    { model: "openai:api:gpt-6-luna", access: "subscription" },
    { model: "openai:subscription:gpt-6-luna" },
    { model: "gpt-6-luna", speed: "standard" },
    { model: "openai:api:gpt-6-luna:fast" },
    { model: "gpt-6.2-sol" },
    { model: "gemini-decision-1", provider: "fireworks" },
    { model: " gemini-decision-1" },
  ])("rejects unsupported or conflicting routes before adapters: %j", async (selection) => {
    await expect(decide({ ...selection, input: "hello", questions } as never)).rejects.toThrow();
    expect(adapters.google).not.toHaveBeenCalled();
    expect(adapters.compatible).not.toHaveBeenCalled();
    expect(adapters.typesafe).not.toHaveBeenCalled();
  });

  it.each([
    { input: "" },
    { input: [] },
    { questions: {} },
    { questions: { bad: { type: "other", instructions: "What?" } } },
    { questions: { bad: { type: "boolean", instructions: " " } } },
    {
      questions: {
        bad: { type: "boolean", instructions: "What?", criteria: { invalid: "value" } },
      },
    },
    { questions: { bad: { type: "choice", instructions: "What?", criteria: { only: "One" } } } },
    { questions: { bad: { type: "score", instructions: "What?", criteria: ["One"] } } },
    {
      input: [
        { type: "image", mimeType: "image/png", uri: "https://example.com/a.png", data: "abc" },
      ],
    },
    { input: [{ type: "audio", mimeType: "audio/mp3", data: "abc", resolution: "high" }] },
  ])("validates questions and input before adapters: %j", async (patch) => {
    await expect(
      decide({ model: "gemini-decision-1", input: "hello", questions, ...patch } as never),
    ).rejects.toThrow();
    expect(adapters.google).not.toHaveBeenCalled();
  });

  it.each([
    ["gpt-6-luna", 401],
    ["gemini-decision-1", 1001],
    ["accounts/fireworks/models/rune", 257],
  ] as const)("enforces native question limit for %s", async (model, count) => {
    const many = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`q${index}`, questions.refund]),
    );
    await expect(decide({ model, input: "hello", questions: many })).rejects.toThrow("questions");
  });

  it("enforces Rune choice limits without limiting Google's larger rubrics", async () => {
    const criteria = Object.fromEntries(
      Array.from({ length: 209 }, (_, index) => [`option${index}`, ""]),
    );
    await expect(
      decide({
        model: "accounts/fireworks/models/rune",
        input: "hello",
        questions: { q: { type: "choice", instructions: "Choose", criteria } },
      }),
    ).rejects.toThrow("208");
    const criteriaLevels = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
    adapters.google.mockResolvedValue({
      answers: {
        q: {
          type: "score",
          score: 1,
          probabilities: Object.fromEntries(
            criteriaLevels.map((_, index) => [index, index === 1 ? 1 : 0]),
          ),
        },
      },
    });
    const result = await decide({
      model: "gemini-decision-1",
      input: "hello",
      questions: { q: { type: "score", instructions: "Rate", criteria: criteriaLevels } },
    });
    expect(result.answers.q.type).toBe("score");
  });

  it("rejects unsupported media and pre-aborted calls without adapters", async () => {
    await expect(
      decide({
        model: "accounts/fireworks/models/rune",
        input: [{ type: "image", mimeType: "image/png", data: "abc" }],
        questions,
      }),
    ).rejects.toThrow("text input only");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      decide({ model: "gpt-6-luna", input: "hello", questions, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(adapters.compatible).not.toHaveBeenCalled();
  });

  it("emits completion telemetry for success and provider failure", async () => {
    const events: TelemetryEvent[] = [];
    const flush = vi.fn();
    const telemetry = {
      sink: {
        emit: (event: TelemetryEvent) => {
          events.push(event);
        },
        flush,
      },
    };
    await decide({ model: "jev-latest", input: "Refund me", questions, telemetry });
    expect(events.map((event) => event.type)).toEqual(["llm.call.started", "llm.call.completed"]);
    expect(events[1]).toMatchObject({ operation: "decide", provider: "typesafe", success: true });
    adapters.typesafe.mockRejectedValue(new Error("upstream failed"));
    await expect(
      decide({ model: "jev-latest", input: "Refund me", questions, telemetry }),
    ).rejects.toThrow("upstream failed");
    expect(events[3]).toMatchObject({ success: false, error: "upstream failed" });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("keeps decision-only IDs out of text speed metadata", () => {
    for (const model of LLM_DECISION_MODEL_IDS) {
      const route = resolveDecisionModelRef({ model });
      const speeds = getSupportedModelSpeeds(route);
      expect(speeds).toEqual(model === "gpt-6-luna" ? ["standard", "fast"] : []);
    }
  });
});

describe("decision pricing", () => {
  it("uses native decision caching rates and never bills output", () => {
    expect(
      estimateDecisionCostUsd("openai", {
        promptTokens: 1000,
        cachedTokens: 100,
        cacheWriteTokens: 200,
        responseTokens: 900,
      }),
    ).toBeCloseTo((700 * 0.1 + 100 * 0.01 + 200 * 0.125) / 1_000_000);
    expect(
      estimateDecisionCostUsd("fireworks", {
        promptTokens: 1000,
        cachedTokens: 100,
        responseTokens: 900,
      }),
    ).toBeCloseTo((900 * 0.042 + 100 * 0.0084) / 1_000_000);
    expect(
      estimateDecisionCostUsd("typesafe", { promptTokens: 1000, responseTokens: 900 }),
    ).toBeCloseTo(0.042 / 1000);
  });
  it("preserves unknown usage or tariffs instead of reporting free", () => {
    expect(estimateDecisionCostUsd("openai")).toBeNull();
    expect(estimateDecisionCostUsd("google", { promptTokens: 1000, cachedTokens: 1 })).toBeNull();
    expect(
      estimateDecisionCostUsd("typesafe", { promptTokens: 1000, cacheWriteTokens: 1 }),
    ).toBeNull();
    expect(
      estimateDecisionCostUsd("fireworks", { promptTokens: 1000, cachedTokens: 1001 }),
    ).toBeNull();
    expect(estimateDecisionCostUsd("google", { promptTokens: 0 })).toBe(0);
  });
});
