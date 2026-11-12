import { describe, expect, it } from "vitest";

import { decide, loadLocalEnv, resolveDecisionModelRef } from "../src/index.js";

loadLocalEnv();
const models = (process.env.LLM_DECISION_INTEGRATION_MODELS ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean)
  .map((model) => resolveDecisionModelRef({ model }));

describe.concurrent("integration: native decisions (opt in with LLM_DECISION_INTEGRATION_MODELS)", () => {
  it.skipIf(models.length > 0)("requires an explicit decision-model selection", () => {
    expect(models).toEqual([]);
  });
  for (const model of models) {
    it(`${model.provider}:${model.model} returns typed answers and usage`, async () => {
      const result = await decide({
        ...model,
        input: "The customer says: I was charged twice. Please refund the duplicate charge.",
        questions: {
          refund: { type: "boolean", instructions: "Does the customer request a refund?" },
          department: {
            type: "choice",
            instructions: "Which department should handle this message?",
            criteria: { billing: "Payments and refunds", shipping: "Deliveries and tracking" },
          },
          severity: {
            type: "score",
            instructions: "Rate how clearly the message requests a refund.",
            criteria: [
              "No request for a refund",
              "An ambiguous refund request",
              "An explicit refund request",
            ],
          },
        },
      });
      expect(result.provider).toBe(model.provider);
      expect(result.access).toBe("api");
      expect(result.answers.refund.type).toBe("boolean");
      if (result.answers.refund.type === "boolean")
        expect(result.answers.refund.probability).toBeGreaterThan(0.5);
      expect(result.answers.department).toMatchObject({ type: "choice", choice: "billing" });
      expect(result.answers.severity.type).toBe("score");
      expect(result.usage?.promptTokens).toBeGreaterThan(0);
      expect(result.costUsd).toBeTypeOf("number");
      expect(result.rawResponse).toBeDefined();
    });
  }
});
