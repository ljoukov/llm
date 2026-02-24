import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgentLoop } from "../src/index.js";
import {
  hasIntegrationCredentialsForModel,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const runtime = "bun" in process.versions ? "bun" : "node";
const requestedModels = resolveIntegrationRequestedModels();

const activeModels = requestedModels.filter((model) => hasIntegrationCredentialsForModel(model));

const suite = activeModels.length > 0 ? describe : describe.skip;

suite(`integration: runAgentLoop hello-world (${runtime})`, () => {
  for (const model of requestedModels) {
    const modelIt = hasIntegrationCredentialsForModel(model) ? it : it.skip;
    modelIt(
      `runs hello-world tool flow for ${model}`,
      async () => {
        let toolCalls = 0;

        const result = await runAgentLoop({
          model,
          input: [
            {
              role: "system",
              content:
                'You are a strict test assistant. Always call the "hello_world" tool before responding.',
            },
            {
              role: "user",
              content:
                'Call the "hello_world" tool exactly once, then reply with exactly "hello world" and nothing else.',
            },
          ],
          tools: {
            hello_world: {
              description: "Returns hello world.",
              inputSchema: z.object({}).strict(),
              execute: async () => {
                toolCalls += 1;
                return { text: "hello world" };
              },
            },
          },
          maxSteps: 6,
          openAiReasoningEffort: "low",
        });

        const sawSuccessfulHelloCall = result.steps.some((step) =>
          step.toolCalls.some((call) => call.toolName === "hello_world" && !call.error),
        );

        expect(toolCalls).toBeGreaterThanOrEqual(1);
        expect(sawSuccessfulHelloCall).toBe(true);
        expect(result.text.toLowerCase()).toContain("hello world");
      },
      180_000,
    );
  }
});
