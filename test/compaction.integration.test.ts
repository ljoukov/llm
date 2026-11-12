import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  isLlmTextModelId,
  parseModelRef,
  runToolLoop,
  tool,
  type LlmCompactionEvent,
  type LlmTextModelRef,
} from "../src/index.js";
import { assertIntegrationCredentialsForModels, integrationModelLabel } from "./integration-env.js";

// Deliberately separate from the ordinary integration matrix: this exercises a
// real compaction pass and should run only when its routes are explicitly chosen.
const selected = process.env.LLM_COMPACTION_MODELS?.trim();
const models = selected
  ? selected.split(",").map((value) => {
      const route = parseModelRef(value.trim());
      if (
        !isLlmTextModelId(route.model) ||
        (route.provider === "anthropic" && route.access === "subscription")
      ) {
        throw new Error(`Unsupported compaction integration route: ${value.trim()}`);
      }
      return route as LlmTextModelRef;
    })
  : [];
if (models.length) assertIntegrationCredentialsForModels(models);

describe.skipIf(!selected).concurrent("integration: context compaction", () => {
  for (const model of models) {
    it(`${integrationModelLabel(model)}: retains task state through a real compaction`, async () => {
      const verificationCode = "saffron-orbit-783";
      let executions = 0;
      const events: LlmCompactionEvent[] = [];
      const result = await runToolLoop({
        ...model,
        instructions:
          "Call read_context exactly once before answering. After its result, return only the " +
          "verification code from the user's request. Do not call it again. The background rows " +
          "are irrelevant to the code, but keep the original request through any context checkpoint.",
        input: `The verification code is ${verificationCode}. Read the context and then return the code.`,
        thinkingLevel: "low",
        maxSteps: 3,
        compaction: {
          thresholdTokens: 3_000,
          preserveRecentMessages: 0,
          maxSummaryTokens: 1_024,
        },
        tools: {
          read_context: tool({
            description: "Read the background context once, then answer the original user request.",
            inputSchema: z.object({}),
            execute: () => {
              executions++;
              return (
                Array.from(
                  { length: 1_200 },
                  (_, index) =>
                    `Background row ${index}: the neutral archive contains routine inventory notes.`,
                ).join("\n") +
                "\nThe context has been read. Return the original verification code now."
              );
            },
          }),
        },
        onEvent: (event) => {
          if (event.type === "compaction") events.push(event);
        },
      });

      expect(executions).toBe(1);
      expect(result.text.trim()).toBe(verificationCode);
      expect(result.compactions?.length).toBeGreaterThan(0);
      const expectedMode =
        model.provider === "google" ||
        model.provider === "fireworks" ||
        model.provider === "vercel" ||
        (model.provider === "xai" && model.access === "subscription")
          ? "summary"
          : "server";
      expect(result.compactions?.every((record) => record.mode === expectedMode)).toBe(true);
      expect(events.some((event) => event.phase === "completed")).toBe(true);
      if (model.access !== "subscription") {
        expect(Number.isFinite(result.totalCostUsd)).toBe(true);
      }
    }, 240_000);
  }
});
