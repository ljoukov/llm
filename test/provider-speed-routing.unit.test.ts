import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({
  requests: [] as Array<{ provider: string; request: Record<string, any> }>,
  gatewayTier: "priority" as string | undefined,
}));

function anthropicMessage(model: string) {
  return {
    id: "speed_message",
    type: "message" as const,
    role: "assistant" as const,
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text" as const, text: "OK" }],
    usage: { input_tokens: 10, output_tokens: 2, speed: "standard", service_tier: "priority" },
  };
}

vi.mock("../src/anthropic/calls.js", () => ({
  runAnthropicCall: async (fn: (client: any) => unknown) =>
    fn({
      streamMessage: async (request: Record<string, any>, options: Record<string, any>) => {
        state.requests.push({ provider: "anthropic", request });
        options.onDelta?.("response", "OK");
        return anthropicMessage(request.model);
      },
    }),
}));

vi.mock("../src/claude/calls.js", () => ({
  runClaudeQuery: async (request: Record<string, any>) => {
    state.requests.push({ provider: "claude", request });
    const message = anthropicMessage(request.model);
    request.onAssistantMessage?.(message, { turn: 1 });
    request.onDelta?.("response", "OK");
    return {
      model: request.model,
      text: "OK",
      thoughts: "",
      finishReason: "end_turn",
      usage: message.usage,
      effectiveSpeed: "standard",
      serviceTier: "priority",
    };
  },
}));

vi.mock("../src/vercel/calls.js", () => ({
  runVercelCall: async (fn: (client: any) => unknown) =>
    fn({
      chat: {
        completions: {
          create: async (request: Record<string, any>) => {
            state.requests.push({ provider: "vercel", request });
            return (async function* () {
              yield {
                model: request.model,
                service_tier: state.gatewayTier,
                choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 },
              };
            })();
          },
        },
      },
    }),
}));

describe("provider serving speed through the public generation API", () => {
  beforeEach(() => {
    state.requests = [];
    state.gatewayTier = "priority";
  });

  it.each([
    ["anthropic:api:claude-opus-5-5", "anthropic", "api"],
    ["anthropic:subscription:claude-opus-5-5", "claude", "subscription"],
  ] as const)("forwards fast mode and keeps capacity priority separate for %s", async (model, transport, access) => {
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({ model, speed: "fast", input: "Hello" });
    expect(state.requests[0]).toMatchObject({
      provider: transport,
      request: { model: "claude-opus-5-5", speed: "fast" },
    });
    expect(result).toMatchObject({
      model: "claude-opus-5-5",
      modelVersion: "claude-opus-5-5",
      access,
      requestedSpeed: "fast",
      effectiveSpeed: "standard",
      serviceTier: "priority",
    });
    expect(access === "api" ? result.costUsd : result.apiEquivalentCostUsd).toBeCloseTo(0.00008);
  });

  it("passes Gateway priority as a modifier and reports its actual tier", async () => {
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({
      model: "vercel:api:openai/gpt-6.1-sol",
      speed: "fast",
      input: "Hello",
    });
    expect(state.requests[0]?.request).toMatchObject({
      model: "openai/gpt-6.1-sol",
      providerOptions: { gateway: { sort: "cost", serviceTier: "priority" } },
    });
    expect(result).toMatchObject({
      requestedSpeed: "fast",
      effectiveSpeed: "fast",
      serviceTier: "priority",
      costUsd: 0.01,
    });
  });

  it.each([
    undefined,
    "flex",
  ])("does not invent Gateway effective speed from absent or unrelated tier %s", async (tier) => {
    state.gatewayTier = tier;
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({
      model: "vercel:api:openai/gpt-6.1-sol",
      speed: "fast",
      input: "Hello",
    });
    expect(result.requestedSpeed).toBe("fast");
    expect(result.effectiveSpeed).toBeUndefined();
    expect(result.serviceTier).toBe(tier);
    expect(result.costUsd).toBe(0.01);
    expect(result.costSource).toBe("reported");
  });

  it.each([
    ["anthropic:api:claude-opus-5-5", "anthropic"],
    ["anthropic:subscription:claude-opus-5-5", "claude"],
    ["vercel:api:openai/gpt-6.1-sol", "vercel"],
  ] as const)("preserves requested and effective speed through %s tool-loop steps", async (model, transport) => {
    state.gatewayTier = "default";
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model,
      speed: "fast",
      input: "Hello",
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(state.requests[0]?.provider).toBe(transport);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ requestedSpeed: "fast", effectiveSpeed: "standard" });
    expect(
      transport === "vercel"
        ? state.requests[0]?.request.providerOptions
        : state.requests[0]?.request,
    ).toMatchObject(
      transport === "vercel" ? { gateway: { serviceTier: "priority" } } : { speed: "fast" },
    );
  });
});
