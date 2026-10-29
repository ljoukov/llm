import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { integrationModelLabel, openAiIntegrationSpeedVariants } from "./integration-env.js";

let capturedRequest: any;

function nativeResponse(request: any) {
  const text = request.text?.format?.type === "json_schema" ? '{"ok":true}' : "Hello";
  return {
    id: "resp_qualified",
    model: request.model,
    status: "completed",
    service_tier: request.service_tier,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    text,
  };
}

vi.mock("../src/openai/calls.js", () => ({
  DEFAULT_OPENAI_REASONING_EFFORT: "medium",
  runOpenAiCall: async (run: (client: any) => Promise<any>) =>
    run({
      responses: {
        stream(request: any) {
          capturedRequest = request;
          const response = nativeResponse(request);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "response.output_text.delta", delta: response.text };
            },
            finalResponse: async () => response,
          };
        },
      },
    }),
}));

vi.mock("../src/openai/chatgpt-codex.js", () => ({
  collectChatGptCodexResponse: async (options: any) => {
    capturedRequest = options.request;
    const response = nativeResponse(options.request);
    options.onDelta?.({ textDelta: response.text });
    return {
      text: response.text,
      reasoningText: "",
      reasoningSummaryText: "",
      toolCalls: [],
      webSearchCalls: [],
      usage: response.usage,
      model: response.model,
      serviceTier: response.service_tier,
      status: "completed",
      blocked: false,
    };
  },
}));

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain the shared streaming entrypoint.
  }
}

beforeEach(() => {
  capturedRequest = undefined;
  vi.unstubAllEnvs();
});

describe.each([
  "openai:api:gpt-6.1-sol",
  "openai:subscription:gpt-6.1-sol",
] as const)("qualified model selection: %s", (model) => {
  const request = { model, speed: "fast", input: "Hello" } as const;

  function expectNormalizedRequest() {
    expect(capturedRequest.model).toBe("gpt-6.1-sol");
    expect(capturedRequest.service_tier).toBe(
      model.startsWith("openai:subscription:") ? "priority" : "fast",
    );
  }

  it("normalizes generateText", async () => {
    const { generateText } = await import("../src/llm.js");
    const result = await generateText(request);
    expect(result.text).toBe("Hello");
    expect(result.model).toBe("gpt-6.1-sol");
    expectNormalizedRequest();
  });

  it("normalizes streamText", async () => {
    const { streamText } = await import("../src/llm.js");
    const call = streamText(request);
    const [, result] = await Promise.all([drain(call.events), call.result]);
    expect(result.model).toBe("gpt-6.1-sol");
    expectNormalizedRequest();
  });

  it("normalizes generateJson", async () => {
    const { generateJson } = await import("../src/llm.js");
    const { value } = await generateJson({ ...request, schema: z.object({ ok: z.boolean() }) });
    expect(value).toEqual({ ok: true });
    expectNormalizedRequest();
  });

  it("normalizes streamJson", async () => {
    const { streamJson } = await import("../src/llm.js");
    const call = streamJson({ ...request, schema: z.object({ ok: z.boolean() }) });
    const [, result] = await Promise.all([drain(call.events), call.result]);
    expect(result.value).toEqual({ ok: true });
    expectNormalizedRequest();
  });

  it("normalizes runToolLoop", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      ...request,
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      maxSteps: 1,
    });
    expect(result.steps[0]?.modelVersion).toBe("gpt-6.1-sol");
    expectNormalizedRequest();
  });

  it("normalizes streamToolLoop", async () => {
    const { streamToolLoop, tool } = await import("../src/llm.js");
    const call = streamToolLoop({
      ...request,
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      maxSteps: 1,
    });
    const [, result] = await Promise.all([drain(call.events), call.result]);
    expect(result.steps[0]?.modelVersion).toBe("gpt-6.1-sol");
    expectNormalizedRequest();
  });
});

describe("OpenAI integration speed variants", () => {
  const routes = [
    { provider: "openai", access: "api", model: "gpt-6.1-sol" },
    { provider: "openai", access: "subscription", model: "gpt-6.1-terra" },
  ] as const;

  it("covers each supported speed without duplicating model identities", () => {
    vi.stubEnv("LLM_INTEGRATION_SPEEDS", "");
    const variants = openAiIntegrationSpeedVariants(routes);
    expect(variants.map(integrationModelLabel)).toEqual([
      "openai:api:gpt-6.1-sol speed=standard",
      "openai:api:gpt-6.1-sol speed=fast",
      "openai:api:gpt-6.1-sol speed=ultrafast",
      "openai:subscription:gpt-6.1-terra speed=standard",
      "openai:subscription:gpt-6.1-terra speed=fast",
    ]);
  });

  it("narrows requested speeds and filters unsupported combinations", () => {
    vi.stubEnv("LLM_INTEGRATION_SPEEDS", "ultrafast,fast,fast");
    expect(openAiIntegrationSpeedVariants(routes).map(integrationModelLabel)).toEqual([
      "openai:api:gpt-6.1-sol speed=fast",
      "openai:api:gpt-6.1-sol speed=ultrafast",
      "openai:subscription:gpt-6.1-terra speed=fast",
    ]);
  });

  it.each(["turbo", "fast,typo", ",,"])("rejects invalid speed selection %s", (speeds) => {
    vi.stubEnv("LLM_INTEGRATION_SPEEDS", speeds);
    expect(() => openAiIntegrationSpeedVariants(routes)).toThrow("LLM_INTEGRATION_SPEEDS");
  });

  it("rejects a speed filter with no supported route", () => {
    vi.stubEnv("LLM_INTEGRATION_SPEEDS", "ultrafast");
    expect(() => openAiIntegrationSpeedVariants([routes[1]])).toThrow("no supported speeds");
  });
});
