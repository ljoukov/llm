import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CLAUDE_MODEL_IDS,
  configureModelConcurrency,
  generateText,
  isClaudeModelId,
  resetModelConcurrencyConfig,
  runToolLoop,
  streamText,
  streamToolLoop,
  tool,
  type ClaudeModelId,
} from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const enabled = process.env.LLM_INTEGRATION_CLAUDE_SUBSCRIPTION?.trim() === "1";
const requestedModels =
  enabled && process.env.LLM_INTEGRATION_MODELS?.trim()
    ? resolveIntegrationRequestedModels()
    : CLAUDE_MODEL_IDS;
if (
  enabled &&
  (requestedModels.length === 0 || requestedModels.some((model) => !isClaudeModelId(model)))
) {
  throw new Error(
    `LLM_INTEGRATION_MODELS must select Claude subscription models: ${CLAUDE_MODEL_IDS.join(", ")}`,
  );
}
const model = requestedModels[0] as ClaudeModelId;
if (enabled) assertIntegrationCredentialsForModels([model]);

// Run this file separately from the parallel model matrix: the nested-call case
// deliberately changes the process-wide Claude concurrency cap.
describe.skipIf(!enabled)("integration: Claude subscription edge cases", () => {
  it(`${model}: terminal tools stop after the initial model/tool turn`, async () => {
    const invocations: number[] = [];
    const result = await runToolLoop({
      model,
      input: "Call finish exactly once with index 7. Its terminal result completes the request.",
      tools: {
        finish: tool({
          description: "Finish the request immediately with the terminal result.",
          terminal: true,
          inputSchema: z.object({ index: z.number().int() }).strict(),
          execute: ({ index }) => {
            invocations.push(index);
            return "TERMINAL_RESULT_29731";
          },
        }),
      },
      thinkingLevel: "low",
      maxSteps: 3,
    });
    expect(invocations).toEqual([7]);
    expect(result.text).toBe("TERMINAL_RESULT_29731");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.finishReason).toBe("tool_use");
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
    expect(result.steps[0]?.toolCalls[0]?.error).toBeUndefined();
  }, 180_000);

  it(`${model}: aborts an active model call after its first stream delta`, async () => {
    const controller = new AbortController();
    let observedDelta = false;
    const timer = setTimeout(() => controller.abort(), 90_000);
    const call = streamText({
      model,
      input:
        "Write 5000 numbered lines. Each line must contain its number and a distinct twelve-word sentence about a garden. Start immediately at line 1 and continue without summaries or omissions.",
      thinkingLevel: "low",
      signal: controller.signal,
    });
    const settledResult = call.result.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const settledEvents = (async () => {
      try {
        for await (const event of call.events) {
          if (event.type === "delta" && event.text) {
            observedDelta = true;
            controller.abort();
          }
        }
        return { error: undefined };
      } catch (error) {
        return { error };
      }
    })();
    try {
      const [result, events] = await Promise.all([settledResult, settledEvents]);
      expect(observedDelta).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
      expect(events.error).toBeInstanceOf(Error);
      expect(String(result.error)).toMatch(/abort|cancel/iu);
      expect(String(events.error)).toMatch(/abort|cancel/iu);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }, 120_000);

  it(`${model}: runs a nested same-model call at cap one and transforms tool input once`, async () => {
    configureModelConcurrency({ providerCaps: { claude: 1 } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let transformations = 0;
    const invocations: number[] = [];
    try {
      const result = await runToolLoop({
        model,
        input:
          'Call nested_lookup exactly once with {"count":"7"}. Then return only the code from its output, without formatting or punctuation.',
        tools: {
          nested_lookup: tool({
            description: "Resolve the result through a nested model call. Count must be a string.",
            inputSchema: z
              .object({
                count: z.string().transform((value) => {
                  transformations += 1;
                  return Number(value);
                }),
              })
              .strict(),
            execute: async ({ count }) => {
              invocations.push(count);
              const child = await generateText({
                model,
                input: "Return exactly: NESTED_OK",
                thinkingLevel: "low",
                signal: controller.signal,
              });
              expect(child.provider).toBe("claude");
              expect(child.model).toBe(model);
              expect(child.text.trim()).toBe("NESTED_OK");
              return { code: `${child.text.trim()}_${count}` };
            },
          }),
        },
        thinkingLevel: "low",
        maxSteps: 4,
        signal: controller.signal,
      });
      expect(transformations).toBe(1);
      expect(invocations).toEqual([7]);
      expect(result.text.trim()).toBe("NESTED_OK_7");
      const calls = result.steps.flatMap((step) => step.toolCalls);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.error).toBeUndefined();
      expect(calls[0]?.output).toEqual({ code: "NESTED_OK_7" });
    } finally {
      clearTimeout(timer);
      controller.abort();
      resetModelConcurrencyConfig();
    }
  }, 180_000);

  it(`${model}: applies steering after a tool and before its planned next tool`, async () => {
    const invocations: string[] = [];
    let call: ReturnType<typeof streamToolLoop>;
    call = streamToolLoop({
      model,
      input:
        "First call gate alone and wait for its result. After gate returns, call second_step exactly once. Then reply exactly ORIGINAL.",
      tools: {
        gate: tool({
          description: "Complete the first step before proceeding to second_step.",
          inputSchema: z.object({}).strict(),
          execute: () => {
            invocations.push("gate");
            const appended = call.append(
              "Change of plan: do not call second_step; reply exactly STEERED.",
            );
            expect(appended.accepted).toBe(true);
            expect(appended.queuedCount).toBe(1);
            expect(call.pendingSteeringCount()).toBe(1);
            return "Gate completed.";
          },
        }),
        second_step: tool({
          description: "Complete the second step after gate.",
          inputSchema: z.object({}).strict(),
          execute: () => {
            invocations.push("second_step");
            return "Second step completed.";
          },
        }),
      },
      thinkingLevel: "low",
      maxSteps: 4,
    });
    const streamed = (async () => {
      for await (const _event of call.events) {
        // Drain events to observe any matching stream failure.
      }
    })();
    const [result] = await Promise.all([call.result, streamed]);
    expect(invocations).toEqual(["gate"]);
    expect(result.text.trim()).toBe("STEERED");
    expect(call.pendingSteeringCount()).toBe(0);
    const calls = result.steps.flatMap((step) => step.toolCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("gate");
    expect(calls[0]?.error).toBeUndefined();
  }, 180_000);
});
