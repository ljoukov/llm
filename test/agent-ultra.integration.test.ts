import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgentLoop } from "../src/index.js";
import { assertIntegrationCredentialsForModels } from "./integration-env.js";

const model = "chatgpt-gpt-5.6-sol" as const;
const readFactInputSchema = z.object({ key: z.enum(["alpha", "beta"]) }).strict();

assertIntegrationCredentialsForModels([model]);

describe("integration: runAgentLoop ultra mode", () => {
  it("automatically enables subagents and completes delegated work", async () => {
    const result = await runAgentLoop({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a strict agent integration test. Follow the requested delegation structure exactly and keep the run short.",
        },
        {
          role: "user",
          content: [
            "Spawn exactly two subagents in parallel.",
            'Assign one to call read_fact with key "alpha" and the other with key "beta".',
            "Wait for both results, then reply with both returned values.",
            "Do not call read_fact from the root agent.",
          ].join("\n"),
        },
      ],
      tools: {
        read_fact: {
          description: "Return a deterministic fact for the requested key.",
          inputSchema: readFactInputSchema,
          execute: async (input: unknown) => {
            const { key } = readFactInputSchema.parse(input);
            return { value: key === "alpha" ? "A" : "B" };
          },
        },
      },
      thinkingLevel: "ultra",
      maxSteps: 20,
    });

    const rootToolCalls = result.steps.flatMap((step) => step.toolCalls);
    expect(
      rootToolCalls.filter((call) => call.toolName === "spawn_agent" && !call.error),
    ).toHaveLength(2);
    expect(rootToolCalls.some((call) => call.toolName === "wait" && !call.error)).toBe(true);
    expect(rootToolCalls.some((call) => call.toolName === "read_fact")).toBe(false);
    expect(result.text).toContain("A");
    expect(result.text).toContain("B");
  }, 240_000);
});
