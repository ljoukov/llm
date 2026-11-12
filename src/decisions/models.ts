/** Native decision endpoints have their own allowlists, separate from text generation. */
export const OPENAI_DECISION_MODEL_IDS = ["gpt-6-luna"] as const;
export const GOOGLE_DECISION_MODEL_IDS = ["gemini-decision-1"] as const;
export const FIREWORKS_DECISION_MODEL_IDS = ["accounts/fireworks/models/rune"] as const;
export const TYPESAFE_DECISION_MODEL_IDS = [
  "jev-1.14.0",
  "jev-1.13.0",
  "jev-latest",
  "jev-preview",
] as const;

export const LLM_DECISION_MODEL_IDS = [
  ...OPENAI_DECISION_MODEL_IDS,
  ...GOOGLE_DECISION_MODEL_IDS,
  ...FIREWORKS_DECISION_MODEL_IDS,
  ...TYPESAFE_DECISION_MODEL_IDS,
] as const;

export type DecisionModelId = (typeof LLM_DECISION_MODEL_IDS)[number];
export type DecisionProvider = "openai" | "google" | "fireworks" | "typesafe";

export const DECISION_MODEL_IDS_BY_PROVIDER = {
  openai: OPENAI_DECISION_MODEL_IDS,
  google: GOOGLE_DECISION_MODEL_IDS,
  fireworks: FIREWORKS_DECISION_MODEL_IDS,
  typesafe: TYPESAFE_DECISION_MODEL_IDS,
} as const;

export type DecisionModelRef = {
  [P in DecisionProvider]: {
    readonly provider: P;
    readonly access?: "api";
    readonly model: (typeof DECISION_MODEL_IDS_BY_PROVIDER)[P][number];
    readonly speed?: never;
  };
}[DecisionProvider];

type QualifiedDecisionModelSelection = {
  [P in DecisionProvider]: {
    readonly provider?: P;
    readonly access?: "api";
    readonly model: `${P}:api:${(typeof DECISION_MODEL_IDS_BY_PROVIDER)[P][number]}`;
    readonly speed?: never;
  };
}[DecisionProvider];

export type DecisionModelSelection =
  | DecisionModelRef
  | QualifiedDecisionModelSelection
  | {
      readonly provider?: undefined;
      readonly access?: "api";
      readonly model: DecisionModelId;
      readonly speed?: never;
    };

export function isDecisionModelId(model: string): model is DecisionModelId {
  return (LLM_DECISION_MODEL_IDS as readonly string[]).includes(model);
}
