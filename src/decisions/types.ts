import type { TelemetrySelection } from "../telemetry.js";
import type { LlmCostSource, LlmUsageTokens } from "../utils/cost.js";
import type { DecisionModelId, DecisionModelSelection, DecisionProvider } from "./models.js";

export type DecisionContent =
  | { readonly type: "text"; readonly text: string }
  | ({
      readonly type: "image" | "audio" | "video" | "document";
      readonly mimeType: string;
      readonly resolution?: "low" | "medium" | "high" | "ultra_high";
    } & (
      | { readonly uri: string; readonly data?: never }
      | { readonly data: string; readonly uri?: never }
    ));

/** Google accepts all media types; OpenAI accepts images; Rune and Jev accept text here. */
export type DecisionInput = string | readonly DecisionContent[];

export type DecisionBooleanQuestion = {
  readonly type: "boolean";
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
};
export type DecisionChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: string;
  /** Option IDs mapped to descriptions. Empty descriptions are allowed. */
  readonly criteria: Readonly<Record<string, string>>;
};
export type DecisionScoreQuestion = {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered rubric descriptions, indexed from zero. */
  readonly criteria: readonly string[];
};
export type DecisionQuestion =
  | DecisionBooleanQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export type DecisionRefusal = { readonly type: "refusal" };
export type DecisionBooleanAnswer = {
  readonly type: "boolean";
  readonly probability: number;
  /** Provider-reported confidence, when available; not inferred from probability. */
  readonly confidence?: number;
};
export type DecisionChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence?: number;
};
export type DecisionScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly legend?: Readonly<Record<string, string>>;
  readonly confidence?: number;
};
export type DecisionAnswer =
  | DecisionBooleanAnswer
  | DecisionChoiceAnswer
  | DecisionScoreAnswer
  | DecisionRefusal;

type AnswerFor<Q extends DecisionQuestion> =
  | DecisionRefusal
  | (Q extends DecisionBooleanQuestion
      ? DecisionBooleanAnswer
      : Q extends DecisionChoiceQuestion
        ? DecisionChoiceAnswer
        : DecisionScoreAnswer);
export type DecisionAnswers<Q extends DecisionQuestions = DecisionQuestions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]>;
};

export type DecideRequest<Q extends DecisionQuestions = DecisionQuestions> =
  DecisionModelSelection & {
    readonly input: DecisionInput;
    readonly questions: Q;
    readonly signal?: AbortSignal;
    readonly telemetry?: TelemetrySelection;
  };

export type DecisionResult<Q extends DecisionQuestions = DecisionQuestions> = {
  readonly provider: DecisionProvider;
  readonly access: "api";
  readonly model: DecisionModelId;
  readonly modelVersion?: string;
  readonly answers: DecisionAnswers<Q>;
  readonly usage?: LlmUsageTokens;
  readonly costUsd: number | null;
  readonly costSource: LlmCostSource;
  readonly durationMs: number;
  /** Unmodified native response for provider-specific fields. */
  readonly rawResponse: unknown;
};
