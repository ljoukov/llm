import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({
  requests: [] as Array<{ provider: string; request: Record<string, any> }>,
  toolLoop: false,
  usage: {
    prompt_tokens: 1_000,
    completion_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 5 },
    cost: 0.0123,
  } as Record<string, unknown>,
  metadata: undefined as Record<string, unknown> | undefined,
}));

function clientFor(provider: string) {
  return {
    chat: {
      completions: {
        create: async (request: Record<string, any>) => {
          const calls = state.requests.filter((entry) => entry.provider === provider).length;
          state.requests.push({ provider, request: structuredClone(request) });
          return (async function* () {
            yield {
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    reasoning: "Let me think.",
                    reasoning_details: [
                      { type: "reasoning.text", text: "Let me think.", index: 0 },
                    ],
                  },
                },
              ],
            };
            if (state.toolLoop && calls === 0) {
              yield {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "multiply_1",
                          function: { name: "multiply", arguments: '{"a":2,"b":3}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              };
            } else {
              yield {
                choices: [
                  {
                    index: 0,
                    delta: { content: state.toolLoop ? "6" : '{"value":6}' },
                    finish_reason: "stop",
                  },
                ],
              };
            }
            yield {
              choices: [],
              usage: state.usage,
              ...(state.metadata ? { provider_metadata: state.metadata } : {}),
            };
          })();
        },
      },
    },
  };
}

vi.mock("../src/vercel/calls.js", () => ({
  runVercelCall: async (fn: (client: any) => unknown) => fn(clientFor("vercel")),
}));
vi.mock("../src/fireworks/calls.js", () => ({
  runFireworksCall: async (fn: (client: any) => unknown) => fn(clientFor("fireworks")),
}));

describe("Vercel shared-model routing", () => {
  beforeEach(() => {
    state.requests = [];
    state.toolLoop = false;
    state.usage = {
      prompt_tokens: 1_000,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
      cost: 0.0123,
    };
    state.metadata = undefined;
    vi.stubEnv("AI_GATEWAY_API_KEY", "unit-gateway-key");
    vi.stubEnv("LLM_PROVIDER", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash-1017"],
    ["glm-5.3", "zai/glm-5.3"],
    ["kimi-k3", "moonshotai/kimi-k3"],
  ] as const)("prefers Vercel and cost-sorted routing for %s", async (model, nativeModel) => {
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({ model, input: "hello", thinkingLevel: "high" });
    expect(result.provider).toBe("vercel");
    expect(result.modelVersion).toBe(nativeModel);
    expect(result.thoughts).toBe("Let me think.");
    expect(result.costUsd).toBe(0.0123);
    expect(result.usage).toMatchObject({
      promptTokens: 1_000,
      responseTokens: 15,
      thinkingTokens: 5,
    });
    expect(state.requests[0]).toMatchObject({
      provider: "vercel",
      request: {
        model: nativeModel,
        providerOptions: { gateway: { sort: "cost" } },
        reasoning_effort: "high",
        stream: true,
        stream_options: { include_usage: true },
      },
    });
  });

  it("allows an explicit Fireworks request to override key preference and environment", async () => {
    vi.stubEnv("LLM_PROVIDER", "vercel");
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({ model: "kimi-k3", provider: "fireworks", input: "hello" });
    expect(result.provider).toBe("fireworks");
    expect(state.requests[0]).toMatchObject({
      provider: "fireworks",
      request: { model: "accounts/fireworks/models/kimi-k3" },
    });
    expect(state.requests[0]?.request).not.toHaveProperty("providerOptions");
    expect(result.costUsd).not.toBe(0.0123);
  });

  it("allows LLM_PROVIDER to retain Fireworks without changing callers", async () => {
    vi.stubEnv("LLM_PROVIDER", "fireworks");
    const { generateText } = await import("../src/llm.js");
    expect((await generateText({ model: "glm-5.3", input: "hello" })).provider).toBe("fireworks");
  });

  it("falls back to Fireworks when the Gateway key is absent", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { generateText } = await import("../src/llm.js");
    expect((await generateText({ model: "glm-5.3", input: "hello" })).provider).toBe("fireworks");
  });

  it("does not allow provider overrides to reroute direct models", async () => {
    const { generateText } = await import("../src/llm.js");
    await expect(
      generateText({ model: "gpt-6.1-sol", provider: "vercel", input: "hello" }),
    ).rejects.toThrow("provider is only configurable");
    expect(state.requests).toHaveLength(0);
  });

  it("routes structured calls through the requested provider", async () => {
    vi.stubEnv("LLM_PROVIDER", "fireworks");
    const { generateJson } = await import("../src/llm.js");
    const result = await generateJson({
      model: "glm-5.3",
      provider: "vercel",
      input: "return six",
      schema: z.object({ value: z.number() }),
    });
    expect(result.value).toEqual({ value: 6 });
    expect(result.result.provider).toBe("vercel");
    expect(state.requests[0]?.request.response_format.type).toBe("json_schema");
  });

  it("preserves reasoning and details across streamed function-tool turns", async () => {
    state.toolLoop = true;
    const { runToolLoop, tool } = await import("../src/llm.js");
    const events: any[] = [];
    const result = await runToolLoop({
      model: "glm-5.3",
      provider: "vercel",
      input: "multiply 2 and 3",
      maxOutputTokens: 2_000,
      onEvent: (event) => events.push(event),
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => a * b,
        }),
      },
    });
    expect(result.text).toBe("6");
    expect(result.steps).toHaveLength(2);
    expect(result.totalCostUsd).toBe(0.0246);
    expect(
      state.requests.every(
        (entry) => entry.provider === "vercel" && entry.request.max_tokens === 2_000,
      ),
    ).toBe(true);
    const assistant = state.requests[1]?.request.messages.find(
      (message: any) => message.tool_calls,
    );
    expect(assistant).toMatchObject({
      reasoning: "Let me think.",
      reasoning_details: [{ type: "reasoning.text", text: "Let me think.", index: 0 }],
    });
    expect(assistant).not.toHaveProperty("reasoning_content");
    expect(
      events.filter((event) => event.type === "delta" && event.channel === "thought"),
    ).toHaveLength(2);
  });

  it("uses gateway metadata cost when usage omits cost", async () => {
    delete state.usage.cost;
    state.metadata = { gateway: { cost: "0.0042" } };
    const { generateText } = await import("../src/llm.js");
    expect((await generateText({ model: "kimi-k3", input: "hello" })).costUsd).toBe(0.0042);
  });

  it("handles upstream completion counts that exclude reasoning", async () => {
    state.usage = {
      prompt_tokens: 93,
      completion_tokens: 14,
      completion_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 113,
      cost: 0.01,
    };
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({ model: "kimi-k3", input: "hello" });
    expect(result.usage).toMatchObject({
      promptTokens: 93,
      responseTokens: 14,
      thinkingTokens: 6,
      totalTokens: 113,
    });
  });

  it("includes separately billed BYOK inference in the estimated total", async () => {
    state.usage = {
      prompt_tokens: 100,
      completion_tokens: 5,
      cost: 0.00001,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.0000396 },
    };
    const { generateText } = await import("../src/llm.js");
    expect((await generateText({ model: "glm-5.3", input: "hello" })).costUsd).toBeCloseTo(
      0.0000496,
      12,
    );
  });

  it("retains a real zero charge for system credentials", async () => {
    state.usage.cost = 0;
    state.usage.is_byok = false;
    const { generateText } = await import("../src/llm.js");
    expect((await generateText({ model: "glm-5.3", input: "hello" })).costUsd).toBe(0);
  });

  it("uses Vercel catalog estimates when no charge is reported", async () => {
    delete state.usage.cost;
    const { generateText } = await import("../src/llm.js");
    const result = await generateText({ model: "glm-5.3", input: "hello" });
    expect(result.costUsd).toBeCloseTo((1_000 * 1.2 + 20 * 4) / 1_000_000, 12);
  });

  it("rejects unknown provider overrides before inference", async () => {
    vi.stubEnv("LLM_PROVIDER", "unknown");
    const { generateText } = await import("../src/llm.js");
    await expect(generateText({ model: "kimi-k3", input: "hello" })).rejects.toThrow(
      "Unsupported LLM_PROVIDER",
    );
    expect(state.requests).toHaveLength(0);
  });
});
