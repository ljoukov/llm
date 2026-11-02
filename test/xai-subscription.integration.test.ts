import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateJson, runToolLoop, tool } from "../src/index.js";

const enabled = process.env.LLM_INTEGRATION_GROK_SUBSCRIPTION === "1";

describe.skipIf(!enabled).concurrent("integration: Grok subscription gateway", () => {
  it("returns validated JSON with subscription accounting", async () => {
    const result = await generateJson({
      model: "xai:subscription:grok-4.7",
      input: 'Return exactly {"value":6}.',
      schema: z.object({ value: z.literal(6) }),
      thinkingLevel: "low",
    });
    expect(result.value).toEqual({ value: 6 });
    expect(result.result).toMatchObject({
      provider: "xai",
      access: "subscription",
      costUsd: null,
      costSource: "subscription",
    });
  });
  it("runs a function-tool round trip through the same subscription route", async () => {
    let calls = 0;
    const result = await runToolLoop({
      model: "xai:subscription:grok-4.7",
      input: "Call multiply with a=2 and b=3, then return its result. You must use the tool.",
      thinkingLevel: "low",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => {
            calls++;
            return a * b;
          },
        }),
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(result.text).toContain("6");
    expect(result.totalCostUsd).toBeNull();
    expect(
      result.steps.every(
        (step) => step.modelVersion.startsWith("grok-") && step.costSource === "subscription",
      ),
    ).toBe(true);
  });
});
