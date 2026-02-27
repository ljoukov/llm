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

suite(`integration: runAgentLoop subagent tools (${runtime})`, () => {
  for (const model of requestedModels) {
    const modelIt = hasIntegrationCredentialsForModel(model) ? it : it.skip;
    modelIt(
      `runs with subagent tools enabled for ${model}`,
      async () => {
        const result = await runAgentLoop({
          model,
          input: [
            {
              role: "system",
              content:
                "You are a strict test assistant. Always call hello_world exactly once before replying.",
            },
            {
              role: "user",
              content: [
                'Call hello_world exactly once, then reply with exactly "hello world".',
                "Subagent tools are enabled; you may use them, but keep the flow short and finish immediately after producing the final answer.",
              ].join("\n"),
            },
          ],
          tools: {
            hello_world: {
              description: "Returns hello world.",
              inputSchema: z.object({}).strict(),
              execute: async () => ({ text: "hello world" }),
            },
          },
          subagentTool: {
            enabled: true,
            maxDepth: 1,
            maxAgents: 2,
            minWaitTimeoutMs: 2_000,
            defaultWaitTimeoutMs: 2_000,
            maxWaitTimeoutMs: 20_000,
          },
          maxSteps: 16,
          openAiReasoningEffort: "low",
        });

        const allToolCalls = result.steps.flatMap((step) => step.toolCalls);
        const sawHello = allToolCalls.some(
          (call) => call.toolName === "hello_world" && !call.error,
        );
        const sawSpawn = allToolCalls.some(
          (call) => call.toolName === "spawn_agent" && !call.error,
        );
        const sawClose = allToolCalls.some(
          (call) => call.toolName === "close_agent" && !call.error,
        );

        expect(sawHello).toBe(true);
        if (sawSpawn) {
          expect(
            sawClose || allToolCalls.some((call) => call.toolName === "wait" && !call.error),
          ).toBe(true);
        }
        expect(result.text.toLowerCase()).toContain("hello world");
      },
      240_000,
    );
  }
});
