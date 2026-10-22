import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  generateJson,
  isAnthropicModelId,
  runToolLoop,
  streamText,
  tool,
  type LlmTextModelId,
  type LlmTextResult,
  type LlmUsageTokens,
} from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const newModels = [
  "gemini-4-argon",
  "gemini-3.8-flash",
  "haiku-5-5",
  "sonnet-5-5",
  "opus-5-5",
  "fable-5-1",
] as const satisfies readonly LlmTextModelId[];
type NewModel = (typeof newModels)[number];

const requestedModels = process.env.LLM_INTEGRATION_MODELS?.trim()
  ? resolveIntegrationRequestedModels()
  : newModels;
if (
  requestedModels.length === 0 ||
  requestedModels.some((model) => !(newModels as readonly string[]).includes(model))
) {
  throw new Error(
    `LLM_INTEGRATION_MODELS must select models in the new Gemini/Claude matrix: ${newModels.join(", ")}`,
  );
}
const models = requestedModels as readonly NewModel[];
assertIntegrationCredentialsForModels(models);

// Independent Standard API price fixtures, USD per million tokens, verified October 22, 2026:
// https://ai.google.dev/gemini-api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
// Keep these separate from the production pricing resolver to verify costs from live usage.
function ratesFor(model: NewModel, promptTokens: number) {
  switch (model) {
    case "gemini-4-argon":
      return Date.now() < Date.parse("2026-12-01T00:00:00Z")
        ? { input: 2, output: 10, cached: 0.1, write5m: 0, write1h: 0 }
        : { input: 4, output: 20, cached: 0.2, write5m: 0, write1h: 0 };
    case "gemini-3.8-flash":
      return Date.now() < Date.parse("2027-01-01T00:00:00Z")
        ? { input: 0.75, output: 3.75, cached: 0.075, write5m: 0, write1h: 0 }
        : { input: 1.5, output: 7.5, cached: 0.15, write5m: 0, write1h: 0 };
    case "haiku-5-5":
      return promptTokens <= 100_000
        ? { input: 0.1, output: 0.5, cached: 0.01, write5m: 0.125, write1h: 0.2 }
        : { input: 0.5, output: 2.5, cached: 0.05, write5m: 0.625, write1h: 1 };
    case "sonnet-5-5":
      return { input: 2, output: 10, cached: 0.1, write5m: 2.5, write1h: 4 };
    case "opus-5-5":
      return { input: 4, output: 20, cached: 0.2, write5m: 5, write1h: 8 };
    case "fable-5-1":
      return { input: 10, output: 50, cached: 0.25, write5m: 12.5, write1h: 20 };
  }
}

function expectedCostUsd(model: NewModel, usage: LlmUsageTokens): number {
  const prompt = (usage.promptTokens ?? 0) + (usage.toolUsePromptTokens ?? 0);
  const cached = usage.cachedTokens ?? 0;
  const writes = usage.cacheWriteTokens ?? 0;
  const writes1h = usage.anthropicCacheCreation1hInputTokens ?? 0;
  const output =
    (usage.responseTokens ?? 0) + (isAnthropicModelId(model) ? 0 : (usage.thinkingTokens ?? 0));
  const rates = ratesFor(model, prompt);
  return (
    ((prompt - cached - writes) * rates.input +
      cached * rates.cached +
      (writes - writes1h) * rates.write5m +
      writes1h * rates.write1h +
      output * rates.output) /
    1_000_000
  );
}

function expectUsageAndCost(model: NewModel, usage: LlmUsageTokens | undefined, costUsd: number) {
  expect(usage?.promptTokens).toBeGreaterThan(0);
  expect(usage?.responseTokens).toBeGreaterThan(0);
  expect(usage?.totalTokens).toBeGreaterThan(0);
  expect(Number.isFinite(costUsd)).toBe(true);
  expect(costUsd).toBeGreaterThan(0);
  expect(costUsd).toBeCloseTo(expectedCostUsd(model, usage ?? {}), 12);
}

function expectProvider(model: NewModel, result: LlmTextResult) {
  expect(result.provider).toBe(isAnthropicModelId(model) ? "anthropic" : "gemini");
  expect(result.model).toBe(model);
  expect(result.modelVersion.length).toBeGreaterThan(0);
  expect(result.blocked).toBe(false);
  expectUsageAndCost(model, result.usage, result.costUsd);
}

describe.concurrent("integration: new Gemini and Claude models", () => {
  for (const model of models) {
    it(`${model}: streams response deltas with usage and verified cost`, async () => {
      const call = streamText({ model, input: "Return exactly: OK", thinkingLevel: "low" });
      const streamed = (async () => {
        let response = "";
        let deltas = 0;
        let usage: LlmUsageTokens | undefined;
        let costUsd: number | undefined;
        for await (const event of call.events) {
          if (event.type === "delta" && event.channel === "response") {
            response += event.text;
            if (event.text.length > 0) {
              deltas += 1;
            }
          } else if (event.type === "usage") {
            usage = event.usage;
            costUsd = event.costUsd;
          }
        }
        return { response, deltas, usage, costUsd };
      })();
      const [events, result] = await Promise.all([streamed, call.result]);

      expect(result.text.trim()).toBe("OK");
      expect(events.response).toBe(result.text);
      expect(events.deltas).toBeGreaterThan(0);
      expect(events.usage).toEqual(result.usage);
      expect(events.costUsd).toBe(result.costUsd);
      expectProvider(model, result);
    }, 180_000);

    it(`${model}: returns schema-validated JSON`, async () => {
      const schema = z
        .object({ ok: z.boolean(), count: z.number().int(), message: z.string() })
        .strict();
      const { value, result } = await generateJson({
        model,
        input: 'Return exactly this JSON object: {"ok":true,"count":3,"message":"hello"}.',
        schema,
        thinkingLevel: "low",
        maxAttempts: 1,
      });

      expect(schema.parse(value)).toEqual({ ok: true, count: 3, message: "hello" });
      expectProvider(model, result);
    }, 180_000);

    it(`${model}: invokes a function tool and uses its result`, async () => {
      const invocations: { index: number }[] = [];
      const code = "TOOL_RESULT_87319";
      const result = await runToolLoop({
        model,
        input: [
          {
            role: "system",
            content:
              "Follow the user's tool instructions exactly. The requested code is only available from the lookup_code tool.",
          },
          {
            role: "user",
            content:
              'Call lookup_code exactly once with {"index":17}. Then return only the code from its output, with no formatting or punctuation.',
          },
        ],
        tools: {
          lookup_code: tool({
            description: "Look up the secret code at the given integer index.",
            inputSchema: z.object({ index: z.number().int() }).strict(),
            execute: (input) => {
              invocations.push(input);
              return { code };
            },
          }),
        },
        thinkingLevel: "low",
        maxSteps: 3,
      });

      expect(invocations).toEqual([{ index: 17 }]);
      const calls = result.steps.flatMap((step) => step.toolCalls);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        toolName: "lookup_code",
        input: { index: 17 },
        output: { code },
      });
      expect(calls[0]?.error).toBeUndefined();
      expect(result.text.trim()).toBe(code);
      for (const step of result.steps) {
        expectUsageAndCost(model, step.usage, step.costUsd);
      }
      expect(result.totalCostUsd).toBeGreaterThan(0);
      expect(result.totalCostUsd).toBeCloseTo(
        result.steps.reduce((sum, step) => sum + step.costUsd, 0),
        12,
      );
    }, 180_000);
  }
});
