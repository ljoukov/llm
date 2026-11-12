import type { LlmUsageTokens } from "../utils/cost.js";
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionQuestion,
  DecisionQuestions,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid decision response: ${context} must be an object.`);
  }
  return value as JsonObject;
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid decision response: probabilities must be finite numbers from 0 to 1.");
  }
  return value;
}

function confidence(answer: JsonObject): { confidence?: number } {
  return answer.confidence === undefined ? {} : { confidence: probability(answer.confidence) };
}

function probabilities(
  value: unknown,
  expectedKeys: readonly string[],
  score: boolean,
): { probabilities: Record<string, number>; legend?: Record<string, string> } {
  const entries: [string, number][] = [];
  const legend: [string, string][] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = object(item, "probability entry");
      if (
        score
          ? typeof entry.value !== "number" || !Number.isInteger(entry.value)
          : typeof entry.value !== "string"
      ) {
        throw new Error("Invalid decision response: probability option has an invalid value.");
      }
      const key = String(entry.value);
      entries.push([key, probability(entry.probability)]);
      if (score) {
        if (typeof entry.label !== "string") {
          throw new Error("Invalid decision response: score probability labels must be strings.");
        }
        legend.push([key, entry.label]);
      }
    }
  } else {
    for (const [key, amount] of Object.entries(object(value, "probabilities"))) {
      entries.push([key, probability(amount)]);
    }
  }
  const keys = entries.map(([key]) => key);
  if (
    keys.length !== expectedKeys.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new Error(
      "Invalid decision response: probability options must match the question exactly.",
    );
  }
  return {
    probabilities: Object.fromEntries(entries),
    ...(legend.length > 0 ? { legend: Object.fromEntries(legend) } : {}),
  };
}

function normalizeAnswer(value: unknown, question: DecisionQuestion): DecisionAnswer {
  const answer = object(value, "answer");
  if (answer.type === "refusal") return { type: "refusal" };
  if (question.type === "boolean") {
    if (answer.type !== "predicate" && answer.type !== "noul") {
      throw new Error(
        "Invalid decision response: answer type does not match the boolean question.",
      );
    }
    return {
      type: "boolean",
      probability: probability(answer.type === "noul" ? answer.noul : answer.probability),
      ...confidence(answer),
    };
  }
  if (answer.type !== question.type) {
    throw new Error("Invalid decision response: answer type does not match the question.");
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
      throw new Error(
        "Invalid decision response: selected choice is not one of the question options.",
      );
    }
    return {
      type: "choice",
      choice: answer.choice,
      ...probabilities(answer.probabilities, options, false),
      ...confidence(answer),
    };
  }
  const options = question.criteria.map((_, index) => String(index));
  if (
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > question.criteria.length - 1
  ) {
    throw new Error("Invalid decision response: score is outside the question's rubric.");
  }
  const distribution = probabilities(answer.probabilities, options, true);
  if (answer.legend !== undefined) {
    const entries = Object.entries(object(answer.legend, "score legend"));
    if (
      entries.length !== options.length ||
      entries.some(([key, label]) => !options.includes(key) || typeof label !== "string")
    ) {
      throw new Error("Invalid decision response: score legend must match the question's rubric.");
    }
    distribution.legend = Object.fromEntries(entries) as Record<string, string>;
  }
  return {
    type: "score",
    score: answer.score,
    ...distribution,
    ...confidence(answer),
  };
}

function tokenCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid decision response: token counts must be non-negative safe integers.");
  }
  return value;
}

function normalizeUsage(value: unknown): LlmUsageTokens | undefined {
  if (value === undefined) return undefined;
  const usage = object(value, "usage");
  const details =
    usage.input_tokens_details === undefined
      ? undefined
      : object(usage.input_tokens_details, "input token details");
  // Validate every recognized reported count, including provider aliases.
  const input = tokenCount(usage.input_tokens);
  const totalInput = tokenCount(usage.total_input_tokens);
  const output = tokenCount(usage.output_tokens);
  const totalOutput = tokenCount(usage.total_output_tokens);
  const cached = tokenCount(usage.cached_input_tokens);
  const cachedDetails = tokenCount(details?.cached_tokens);
  const cacheWrite = tokenCount(details?.cache_write_tokens);
  const reportedTotal = tokenCount(usage.total_tokens);
  const promptTokens = input ?? totalInput;
  const responseTokens = output ?? totalOutput;
  const totalTokens =
    reportedTotal ??
    (promptTokens !== undefined && responseTokens !== undefined
      ? tokenCount(promptTokens + responseTokens)
      : undefined);
  const fields: [keyof LlmUsageTokens, number | undefined][] = [
    ["promptTokens", promptTokens],
    ["responseTokens", responseTokens],
    ["cachedTokens", cachedDetails ?? cached],
    ["cacheWriteTokens", cacheWrite],
    ["totalTokens", totalTokens],
  ];
  const entries = fields.filter((entry): entry is [keyof LlmUsageTokens, number] => {
    return entry[1] !== undefined;
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Normalize native answer shapes without inventing answers, confidence, or usage. */
export function normalizeDecisionResponse(
  raw: unknown,
  questions: DecisionQuestions,
): { answers: DecisionAnswers; usage?: LlmUsageTokens; modelVersion?: string } {
  const response = object(raw, "response");
  let answerMap: JsonObject;
  if (Array.isArray(response.answers)) {
    const entries: [string, unknown][] = [];
    const names = new Set<string>();
    for (const item of response.answers) {
      const answer = object(item, "answer");
      if (typeof answer.name !== "string" || names.has(answer.name)) {
        throw new Error("Invalid decision response: answers require unique question names.");
      }
      names.add(answer.name);
      entries.push([answer.name, answer]);
    }
    answerMap = Object.fromEntries(entries);
  } else {
    answerMap = object(response.answers, "answers");
  }
  const answers = Object.fromEntries(
    Object.entries(questions).map(([name, question]) => {
      if (!Object.hasOwn(answerMap, name)) {
        throw new Error(
          "Invalid decision response: an answer is missing for a requested question.",
        );
      }
      return [name, normalizeAnswer(answerMap[name], question)];
    }),
  );
  const usage = normalizeUsage(response.usage);
  return {
    answers,
    ...(usage === undefined ? {} : { usage }),
    ...(typeof response.model === "string" ? { modelVersion: response.model } : {}),
  };
}
