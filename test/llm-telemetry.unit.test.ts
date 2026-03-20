import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

let openAiRequests: any[] = [];
let openAiStreamedEvents: any[] = [];
let openAiFinalResponse: any = null;
let geminiRequests: any[] = [];
let geminiChunks: any[] = [];

vi.mock("../src/openai/calls.js", () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      for (const event of openAiStreamedEvents) {
        yield event;
      }
    },
    async finalResponse() {
      return openAiFinalResponse;
    },
  };

  const fakeClient = {
    responses: {
      stream: (request: any) => {
        openAiRequests.push(request);
        return fakeStream;
      },
    },
  };

  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

vi.mock("../src/google/calls.js", () => {
  const fakeClient = {
    models: {
      generateContentStream: async (request: any) => {
        geminiRequests.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of geminiChunks) {
              yield chunk;
            }
          },
        };
      },
    },
  };

  return {
    runGeminiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("LLM telemetry", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    openAiRequests = [];
    openAiStreamedEvents = [{ type: "response.output_text.delta", delta: "hello" }];
    openAiFinalResponse = {
      id: "resp_123",
      model: "gpt-5.4-mini",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    };
    geminiRequests = [];
    geminiChunks = [];
  });

  it("supports a global telemetry sink for generateText and lets calls opt out", async () => {
    const [{ generateText }, { configureTelemetry }] = await Promise.all([
      import("../src/llm.js"),
      import("../src/telemetry.js"),
    ]);

    const events: any[] = [];
    configureTelemetry({
      includeStreamEvents: true,
      sink: {
        emit: (event: unknown) => {
          events.push(event);
        },
      },
    });

    const result = await generateText({ model: "gpt-5.4-mini", input: "hi" });
    expect(result.text).toBe("hello");
    expect(events[0]).toMatchObject({
      type: "llm.call.started",
      operation: "generateText",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(events.some((event) => event.type === "llm.call.stream")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "llm.call.completed",
      operation: "generateText",
      success: true,
      outputTextChars: 5,
    });

    events.length = 0;
    await generateText({ model: "gpt-5.4-mini", input: "hi", telemetry: false });
    expect(events).toEqual([]);
  });

  it("applies one global telemetry config across direct calls and agent runs", async () => {
    const [llmModule, telemetryModule] = await Promise.all([
      import("../src/llm.js"),
      import("../src/telemetry.js"),
    ]);
    const { generateText } = llmModule;
    const { configureTelemetry, resetTelemetry } = telemetryModule;
    const { runAgentLoop } = await import("../src/agent.js");

    const events: any[] = [];
    configureTelemetry({
      sink: {
        emit: (event: unknown) => {
          events.push(event);
        },
      },
    });

    try {
      await generateText({ model: "gpt-5.4-mini", input: "hi" });
      await runAgentLoop({
        model: "gpt-5.4-mini",
        input: "test",
        logging: false,
        tools: {
          ping: {
            inputSchema: z.object({}),
            execute: async () => "pong",
          },
        },
      });
      expect(events.some((event) => event.type === "llm.call.completed")).toBe(true);
      expect(events.some((event) => event.type === "agent.run.completed")).toBe(true);
    } finally {
      resetTelemetry();
    }
  });

  it("emits wrapper-level telemetry for generateJson", async () => {
    const { generateJson } = await import("../src/llm.js");

    openAiStreamedEvents = [
      { type: "response.output_text.delta", delta: '{"ok":' },
      { type: "response.output_text.delta", delta: "true}" },
    ];

    const events: any[] = [];
    const { value } = await generateJson({
      model: "gpt-5.4-mini",
      input: "hi",
      schema: z.object({ ok: z.boolean() }),
      telemetry: {
        includeStreamEvents: true,
        sink: {
          emit: (event: unknown) => {
            events.push(event);
          },
        },
      },
    });

    expect(value).toEqual({ ok: true });
    expect(events[0]).toMatchObject({
      type: "llm.call.started",
      operation: "generateJson",
    });
    expect(events.some((event) => event.type === "llm.call.stream")).toBe(true);
    expect(events.every((event) => event.operation === "generateJson")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "llm.call.completed",
      operation: "generateJson",
      success: true,
      rawTextChars: 11,
      attempts: 1,
    });
  });

  it("emits aggregate wrapper telemetry for generateImages", async () => {
    const { generateImages } = await import("../src/llm.js");

    geminiChunks = [
      {
        modelVersion: "gemini-3-pro-image-preview",
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 4,
          totalTokenCount: 12,
        },
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  inlineData: {
                    data: Buffer.from("fake-image").toString("base64"),
                    mimeType: "image/png",
                  },
                },
              ],
            },
          },
        ],
      },
    ];
    openAiStreamedEvents = [
      { type: "response.output_text.delta", delta: '{"grade":"' },
      { type: "response.output_text.delta", delta: 'pass"}' },
    ];

    const events: any[] = [];
    const images = await generateImages({
      model: "gemini-3-pro-image-preview",
      stylePrompt: "Comic book panel",
      imagePrompts: ["A red fox running through snow"],
      imageGradingPrompt: "Check whether the image matches the prompt.",
      telemetry: {
        sink: {
          emit: (event: unknown) => {
            events.push(event);
          },
        },
      },
    });

    expect(images).toHaveLength(1);
    expect(geminiRequests).toHaveLength(1);
    expect(openAiRequests).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "llm.call.started",
      operation: "generateImages",
      imagePromptCount: 1,
      styleImageCount: 0,
    });
    expect(events[1]).toMatchObject({
      type: "llm.call.completed",
      operation: "generateImages",
      success: true,
      imageCount: 1,
      attempts: 1,
    });
    expect(events[1]?.costUsd).toBeGreaterThan(0);
    expect(events[1]?.usage?.totalTokens).toBeGreaterThan(0);
  });
});
