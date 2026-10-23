import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ANTHROPIC_MODEL_IDS,
  generateJson,
  runToolLoop,
  streamText,
  tool,
  type AnthropicModelId,
  type LlmTextResult,
  type LlmUsageTokens,
} from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

// Subscription calls require an explicit opt-in and an existing Claude Code login.
const enabled = process.env.LLM_INTEGRATION_CLAUDE_SUBSCRIPTION?.trim() === "1";
const requestedModels =
  enabled && process.env.LLM_INTEGRATION_MODELS?.trim()
    ? resolveIntegrationRequestedModels()
    : ANTHROPIC_MODEL_IDS.map((model) => ({
        provider: "anthropic" as const,
        access: "subscription" as const,
        model,
      }));
if (
  enabled &&
  (requestedModels.length === 0 ||
    requestedModels.some((ref) => ref.provider !== "anthropic" || ref.access !== "subscription"))
) {
  throw new Error(
    `LLM_INTEGRATION_MODELS must select Claude subscription models: ${ANTHROPIC_MODEL_IDS.map((model) => `anthropic:subscription:${model}`).join(", ")}`,
  );
}
const models = requestedModels as readonly {
  provider: "anthropic";
  access: "subscription";
  model: AnthropicModelId;
}[];
if (enabled) assertIntegrationCredentialsForModels(models);

// Independent API-equivalent price fixtures, USD per million tokens, October 22, 2026.
// These are estimates for comparison, not an additional charge for subscription calls.
function expectedCostUsd(model: AnthropicModelId, usage: LlmUsageTokens): number {
  const prompt = usage.promptTokens ?? 0;
  const cached = usage.cachedTokens ?? 0;
  const writes = usage.cacheWriteTokens ?? 0;
  const writes1h = usage.anthropicCacheCreation1hInputTokens ?? 0;
  const rates =
    model === "claude-haiku-5-5"
      ? prompt <= 100_000
        ? { input: 0.1, output: 0.5, cached: 0.01, write5m: 0.125, write1h: 0.2 }
        : { input: 0.5, output: 2.5, cached: 0.05, write5m: 0.625, write1h: 1 }
      : model === "claude-sonnet-5-5"
        ? { input: 2, output: 10, cached: 0.1, write5m: 2.5, write1h: 4 }
        : model === "claude-opus-5-5"
          ? { input: 4, output: 20, cached: 0.2, write5m: 5, write1h: 8 }
          : { input: 10, output: 50, cached: 0.25, write5m: 12.5, write1h: 20 };
  return (
    ((prompt - cached - writes) * rates.input +
      cached * rates.cached +
      (writes - writes1h) * rates.write5m +
      writes1h * rates.write1h +
      (usage.responseTokens ?? 0) * rates.output) /
    1_000_000
  );
}

function expectUsageAndCost(
  model: AnthropicModelId,
  usage: LlmUsageTokens | undefined,
  costUsd: number | null | undefined,
) {
  expect(usage?.promptTokens).toBeGreaterThan(0);
  expect(usage?.responseTokens).toBeGreaterThan(0);
  expect(usage?.totalTokens).toBeGreaterThan(0);
  expect(costUsd).toBeTypeOf("number");
  expect(costUsd).toBeGreaterThan(0);
  expect(costUsd).toBeCloseTo(expectedCostUsd(model, usage ?? {}), 12);
}

function expectSubscriptionResult(model: AnthropicModelId, result: LlmTextResult) {
  expect(result.provider).toBe("anthropic");
  expect(result.access).toBe("subscription");
  expect(result.model).toBe(model);
  expect(result.modelVersion).toBe(model);
  expect(result.blocked).toBe(false);
  expect(result.costUsd).toBeNull();
  expect(result.costSource).toBe("subscription");
  expectUsageAndCost(model, result.usage, result.apiEquivalentCostUsd);
}

describe.skipIf(!enabled).concurrent("integration: Claude Code subscription models", () => {
  for (const ref of models) {
    const { model } = ref;
    it(`${model}: streams text with usage and API-equivalent cost`, async () => {
      const call = streamText({ ...ref, input: "Return exactly: OK", thinkingLevel: "low" });
      const streamed = (async () => {
        let text = "";
        let deltaCount = 0;
        let usage: LlmUsageTokens | undefined;
        let costUsd: number | null | undefined;
        for await (const event of call.events) {
          if (event.type === "delta" && event.channel === "response") {
            text += event.text;
            if (event.text) deltaCount += 1;
          } else if (event.type === "usage") {
            usage = event.usage;
            costUsd = event.costUsd;
          }
        }
        return { text, deltaCount, usage, costUsd };
      })();
      const [events, result] = await Promise.all([streamed, call.result]);
      expect(result.text.trim()).toBe("OK");
      expect(events.text).toBe(result.text);
      expect(events.deltaCount).toBeGreaterThan(0);
      expect(events.usage).toEqual(result.usage);
      expect(events.costUsd).toBe(result.costUsd);
      expectSubscriptionResult(model, result);
    }, 180_000);

    it(`${model}: returns native schema-validated JSON`, async () => {
      const schema = z
        .object({ ok: z.boolean(), count: z.number().int(), message: z.string() })
        .strict();
      const { value, result } = await generateJson({
        ...ref,
        input: 'Return exactly this JSON object: {"ok":true,"count":3,"message":"hello"}.',
        schema,
        thinkingLevel: "low",
        maxAttempts: 1,
      });
      expect(schema.parse(value)).toEqual({ ok: true, count: 3, message: "hello" });
      expect(JSON.parse(result.text)).toEqual(value);
      expectSubscriptionResult(model, result);
    }, 180_000);

    it(`${model}: invokes an application function and uses its result`, async () => {
      const invocations: { index: number }[] = [];
      const code = "TOOL_RESULT_87319";
      const events: string[] = [];
      const result = await runToolLoop({
        ...ref,
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
        maxSteps: 4,
        onEvent: (event) => {
          if (event.type === "tool_call") events.push(event.phase);
        },
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
      expect(events).toEqual(["started", "completed"]);
      expect(result.text.trim()).toBe(code);
      for (const step of result.steps) {
        expect(step.costUsd).toBeNull();
        expect(step.costSource).toBe("subscription");
        expectUsageAndCost(model, step.usage, step.apiEquivalentCostUsd);
      }
      expect(result.totalCostUsd).toBeNull();
    }, 180_000);
  }
});
