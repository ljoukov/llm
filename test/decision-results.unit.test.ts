import { describe, expect, it } from "vitest";

import { normalizeDecisionResponse } from "../src/decisions/results.js";
import type { DecisionQuestions } from "../src/decisions/types.js";

const questions = {
  damaged: { type: "boolean", instructions: "Is the product damaged?" },
  team: {
    type: "choice",
    instructions: "Which team should respond?",
    criteria: { billing: "Payment issues", support: "Product issues" },
  },
  severity: {
    type: "score",
    instructions: "How severe is this?",
    criteria: ["Minor", "Moderate", "Critical"],
  },
} as const satisfies DecisionQuestions;

function nativeAnswers() {
  return {
    damaged: { type: "noul", noul: 0.98, confidence: 0.92 },
    team: {
      type: "choice",
      choice: "support",
      probabilities: { billing: 0.1, support: 0.9 },
      confidence: 0.8,
    },
    severity: {
      type: "score",
      score: 1.4,
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
      legend: { "0": "Minor", "1": "Moderate", "2": "Critical" },
      confidence: 0.7,
    },
  };
}

describe("normalizeDecisionResponse", () => {
  it("normalizes Google and TypeSafe answer maps and preserves native confidence", () => {
    const result = normalizeDecisionResponse(
      {
        model: "gemini-decision-1",
        answers: nativeAnswers(),
        usage: { total_input_tokens: 123, total_output_tokens: 0, total_tokens: 123 },
      },
      questions,
    );
    expect(result).toEqual({
      modelVersion: "gemini-decision-1",
      answers: {
        ...nativeAnswers(),
        damaged: { type: "boolean", probability: 0.98, confidence: 0.92 },
      },
      usage: { promptTokens: 123, responseTokens: 0, totalTokens: 123 },
    });
  });

  it("matches OpenAI and Fireworks answer arrays by name, including reordered answers", () => {
    const result = normalizeDecisionResponse(
      {
        model: "gpt-6-luna",
        answers: [
          {
            type: "score",
            name: "severity",
            score: 1.4,
            confidence: 0.7,
            probabilities: [
              { value: 0, label: "Minor", probability: 0.1 },
              { value: 1, label: "Moderate", probability: 0.4 },
              { value: 2, label: "Critical", probability: 0.5 },
            ],
          },
          { type: "predicate", name: "damaged", probability: 0.98 },
          {
            type: "choice",
            name: "team",
            choice: "support",
            confidence: 0.8,
            probabilities: [
              { value: "support", probability: 0.9 },
              { value: "billing", probability: 0.1 },
            ],
          },
        ],
        usage: {
          input_tokens: 250,
          input_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 },
          output_tokens: 0,
          total_tokens: 250,
        },
      },
      questions,
    );
    expect(result.answers).toEqual({
      ...nativeAnswers(),
      damaged: { type: "boolean", probability: 0.98 },
    });
    expect(result.usage).toEqual({
      promptTokens: 250,
      responseTokens: 0,
      cachedTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 250,
    });
  });

  it("accepts a refusal for any question without synthesizing values", () => {
    const result = normalizeDecisionResponse(
      {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [name, { type: "refusal" }]),
        ),
      },
      questions,
    );
    expect(Object.values(result.answers)).toEqual([
      { type: "refusal" },
      { type: "refusal" },
      { type: "refusal" },
    ]);
  });

  it("does not invent missing usage or confidence", () => {
    const result = normalizeDecisionResponse(
      { answers: { damaged: { type: "noul", noul: 0 } } },
      { damaged: questions.damaged },
    );
    expect(result).toEqual({ answers: { damaged: { type: "boolean", probability: 0 } } });
    expect(normalizeDecisionResponse({ answers: {}, usage: {} }, {}).usage).toBeUndefined();
  });

  it("preserves zero usage and computes totals only when both components exist", () => {
    expect(
      normalizeDecisionResponse(
        { answers: {}, usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } },
        {},
      ).usage,
    ).toEqual({ promptTokens: 0, responseTokens: 0, totalTokens: 0, cachedTokens: 0 });
    expect(
      normalizeDecisionResponse({ answers: {}, usage: { input_tokens: 12 } }, {}).usage,
    ).toEqual({ promptTokens: 12 });
    expect(
      normalizeDecisionResponse({ answers: {}, usage: { output_tokens: 3 } }, {}).usage,
    ).toEqual({ responseTokens: 3 });
  });

  it("uses own properties safely for special question names and option IDs", () => {
    const specialQuestions = Object.fromEntries([
      [
        "__proto__",
        {
          type: "choice",
          instructions: "Pick one",
          criteria: Object.fromEntries([
            ["__proto__", "A"],
            ["constructor", "B"],
          ]),
        },
      ],
    ]) as DecisionQuestions;
    const answers = Object.fromEntries([
      [
        "__proto__",
        {
          type: "choice",
          choice: "__proto__",
          probabilities: Object.fromEntries([
            ["__proto__", 0.7],
            ["constructor", 0.3],
          ]),
        },
      ],
    ]);
    const result = normalizeDecisionResponse({ answers }, specialQuestions);
    expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
    expect(Object.keys(result.answers.__proto__ ?? {})).toEqual([
      "type",
      "choice",
      "probabilities",
    ]);
    expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype);
  });

  it.each([
    null,
    [],
    5,
    { answers: null },
    { answers: [] },
  ])("rejects malformed response or missing requested answer: %j", (raw) => {
    expect(() => normalizeDecisionResponse(raw, questions)).toThrow("Invalid decision response");
  });

  it("rejects duplicate answer names rather than overwriting an answer", () => {
    expect(() =>
      normalizeDecisionResponse(
        {
          answers: [
            { name: "damaged", type: "predicate", probability: 0.1 },
            { name: "damaged", type: "predicate", probability: 0.9 },
          ],
        },
        { damaged: questions.damaged },
      ),
    ).toThrow("unique question names");
  });

  it("rejects inherited answer names", () => {
    expect(() =>
      normalizeDecisionResponse(
        { answers: Object.create({ damaged: { type: "noul", noul: 0.7 } }) },
        { damaged: questions.damaged },
      ),
    ).toThrow("missing");
  });

  it.each([
    NaN,
    Infinity,
    -0.1,
    1.1,
    "0.5",
    null,
    undefined,
  ])("rejects an invalid boolean probability: %j", (amount) => {
    expect(() =>
      normalizeDecisionResponse(
        { answers: { damaged: { type: "noul", noul: amount } } },
        { damaged: questions.damaged },
      ),
    ).toThrow("probabilities");
  });

  it("rejects answer type mismatches", () => {
    const answers = { ...nativeAnswers(), damaged: { type: "score", score: 0 } };
    expect(() => normalizeDecisionResponse({ answers }, questions)).toThrow("answer type");
  });

  it.each([
    { billing: 1 },
    { billing: 0.1, support: 0.8, unknown: 0.1 },
    { billing: -0.1, support: 1.1 },
    [
      { value: "support", probability: 0.5 },
      { value: "support", probability: 0.5 },
    ],
    [
      { value: false, probability: 0.5 },
      { value: true, probability: 0.5 },
    ],
  ])("rejects invalid choice distributions: %j", (distribution) => {
    const answers = nativeAnswers();
    const team = { ...answers.team, probabilities: distribution };
    expect(() => normalizeDecisionResponse({ answers: { ...answers, team } }, questions)).toThrow(
      "Invalid decision response",
    );
  });

  it("rejects a choice outside the supplied options", () => {
    const answers = nativeAnswers();
    expect(() =>
      normalizeDecisionResponse(
        { answers: { ...answers, team: { ...answers.team, choice: "unknown" } } },
        questions,
      ),
    ).toThrow("selected choice");
  });

  it.each([-1, 2.1, NaN, Infinity, "1.5"])("rejects invalid scores: %j", (score) => {
    const answers = nativeAnswers();
    expect(() =>
      normalizeDecisionResponse(
        { answers: { ...answers, severity: { ...answers.severity, score } } },
        questions,
      ),
    ).toThrow("outside");
  });

  it("rejects missing rubric probabilities and malformed legends", () => {
    const answers = nativeAnswers();
    expect(() =>
      normalizeDecisionResponse(
        {
          answers: {
            ...answers,
            severity: { ...answers.severity, probabilities: { "0": 0.5, "1": 0.5 } },
          },
        },
        questions,
      ),
    ).toThrow("match the question");
    expect(() =>
      normalizeDecisionResponse(
        { answers: { ...answers, severity: { ...answers.severity, legend: { "0": "Minor" } } } },
        questions,
      ),
    ).toThrow("legend");
  });

  it("allows provider-rounded distributions without renormalizing them", () => {
    const answers = nativeAnswers();
    const probabilities = { "0": 0.03, "1": 0.83, "2": 0.15 };
    expect(
      normalizeDecisionResponse(
        { answers: { ...answers, severity: { ...answers.severity, probabilities } } },
        questions,
      ).answers.severity,
    ).toMatchObject({ probabilities });
  });

  it.each([
    { input_tokens: -1 },
    { total_input_tokens: Infinity },
    { input_tokens: 5, total_input_tokens: "5" },
    { output_tokens: NaN },
    { output_tokens: 0.5 },
    { input_tokens_details: { cached_tokens: -5 } },
    { input_tokens_details: { cache_write_tokens: null } },
    { cached_input_tokens: "12" },
    { total_tokens: -1 },
    null,
  ])("rejects invalid reported usage fields: %j", (usage) => {
    expect(() => normalizeDecisionResponse({ answers: {}, usage }, {})).toThrow(
      "Invalid decision response",
    );
  });
});
