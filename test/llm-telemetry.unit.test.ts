import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

let openAiRequests: any[] = [];
let openAiImageRequests: any[] = [];
let openAiStreamedEvents: any[] = [];
let openAiFinalResponse: any = null;
let openAiImageResponse: any = null;
let openAiContainerRequests: any[] = [];
let openAiContainerFiles: any[] = [];
let chatGptCodexRequests: any[] = [];
let chatGptCodexResponse: any = null;
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
    images: {
      generate: async (request: any) => {
        openAiImageRequests.push({ endpoint: "generate", request });
        return openAiImageResponse;
      },
      edit: async (request: any) => {
        openAiImageRequests.push({ endpoint: "edit", request });
        return openAiImageResponse;
      },
    },
    containers: {
      create: async (request: any) => {
        openAiContainerRequests.push({ endpoint: "containers.create", request });
        return {
          id: "cntr_created",
          name: request.name,
          status: "active",
          created_at: 1,
          memory_limit: request.memory_limit,
        };
      },
      delete: async (containerId: string) => {
        openAiContainerRequests.push({ endpoint: "containers.delete", containerId });
      },
      files: {
        create: async (containerId: string, request: any) => {
          openAiContainerRequests.push({
            endpoint: "containers.files.create",
            containerId,
            filename: request.file?.name,
          });
          return {
            id: "cfile_uploaded",
            container_id: containerId,
            path: `/mnt/data/${request.file?.name ?? "uploaded.bin"}`,
            bytes: request.file?.size ?? 0,
            source: "user",
          };
        },
        list: (_containerId: string) => ({
          async *[Symbol.asyncIterator]() {
            for (const file of openAiContainerFiles) {
              yield file;
            }
          },
        }),
        content: {
          retrieve: async (fileId: string, request: any) => {
            openAiContainerRequests.push({
              endpoint: "containers.files.content.retrieve",
              fileId,
              request,
            });
            return new Response("downloaded");
          },
        },
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

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async ({ request }: any) => {
      chatGptCodexRequests.push(request);
      return chatGptCodexResponse;
    },
  };
});

describe("LLM telemetry", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    openAiRequests = [];
    openAiImageRequests = [];
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
    openAiContainerRequests = [];
    openAiContainerFiles = [
      {
        id: "cfile_123",
        container_id: "cntr_123",
        path: "/mnt/data/article.pdf",
        bytes: null,
        created_at: 1,
        source: "assistant",
      },
    ];
    openAiImageResponse = {
      created: 1,
      data: [{ b64_json: Buffer.from("fake-openai-image").toString("base64") }],
      output_format: "png",
      usage: {
        input_tokens: 10,
        input_tokens_details: {
          text_tokens: 8,
          image_tokens: 2,
        },
        output_tokens: 20,
        output_tokens_details: {
          image_tokens: 20,
          text_tokens: 0,
        },
        total_tokens: 30,
      },
    };
    chatGptCodexRequests = [];
    chatGptCodexResponse = {
      model: "gpt-5.4",
      status: "completed",
      text: "",
      reasoningText: "",
      reasoningSummaryText: "",
      toolCalls: [],
      webSearchCalls: [],
      imageGenerationCalls: [
        {
          id: "ig_123",
          status: "completed",
          result: Buffer.from("fake-chatgpt-image").toString("base64"),
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
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

  it("returns OpenAI hosted shell container metadata", async () => {
    const { generateText } = await import("../src/llm.js");
    openAiStreamedEvents = [{ type: "response.output_text.delta", delta: "done" }];
    openAiFinalResponse = {
      id: "resp_shell",
      model: "gpt-5.5",
      status: "completed",
      output: [
        {
          type: "shell_call",
          id: "sh_123",
          call_id: "call_123",
          environment: {
            type: "container_reference",
            container_id: "cntr_123",
          },
          status: "completed",
        },
        {
          type: "message",
          id: "msg_123",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    };

    const result = await generateText({
      model: "gpt-5.5",
      input: "Use shell.",
      tools: [{ type: "shell" }],
    });

    expect(result.openAi).toEqual({
      responseId: "resp_shell",
      containers: [
        {
          containerId: "cntr_123",
          toolType: "shell",
          itemId: "sh_123",
          callId: "call_123",
        },
      ],
    });
  });

  it("creates, lists, uploads, and downloads OpenAI container files", async () => {
    const {
      createOpenAiContainer,
      downloadOpenAiContainerFileText,
      listOpenAiContainerFiles,
      uploadOpenAiContainerFile,
    } = await import("../src/index.js");

    const container = await createOpenAiContainer({
      name: "article-build",
      memoryLimit: "1g",
      networkPolicy: { type: "disabled" },
      expiresAfterMinutes: 20,
    });
    expect(container).toMatchObject({
      id: "cntr_created",
      name: "article-build",
      status: "active",
      memoryLimit: "1g",
    });
    expect(openAiContainerRequests[0]).toMatchObject({
      endpoint: "containers.create",
      request: {
        name: "article-build",
        memory_limit: "1g",
        network_policy: { type: "disabled" },
        expires_after: { anchor: "last_active_at", minutes: 20 },
      },
    });

    const uploaded = await uploadOpenAiContainerFile({
      containerId: "cntr_created",
      filename: "cover.png",
      data: new TextEncoder().encode("cover"),
      mimeType: "image/png",
    });
    expect(uploaded).toMatchObject({
      id: "cfile_uploaded",
      containerId: "cntr_created",
      path: "/mnt/data/cover.png",
      source: "user",
    });

    const files = await listOpenAiContainerFiles("cntr_123");
    expect(files).toEqual([
      {
        id: "cfile_123",
        containerId: "cntr_123",
        path: "/mnt/data/article.pdf",
        bytes: null,
        createdAt: 1,
        source: "assistant",
      },
    ]);

    await expect(
      downloadOpenAiContainerFileText({ containerId: "cntr_123", fileId: "cfile_123" }),
    ).resolves.toBe("downloaded");
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

  it("calls the OpenAI Image API for gpt-image-2 generateImages", async () => {
    const { generateImages } = await import("../src/llm.js");

    const images = await generateImages({
      model: "gpt-image-2",
      stylePrompt: "Warm amber light, dark blue night, cinematic laboratory mood.",
      imagePrompts: ["A compact laboratory bench still life with glassware"],
      imageResolution: "2048x1152",
      imageQuality: "low",
      outputFormat: "png",
      numImages: 1,
    });

    expect(images).toHaveLength(1);
    expect(images[0]?.data.toString()).toBe("fake-openai-image");
    expect(images[0]?.mimeType).toBe("image/png");
    expect(openAiImageRequests).toHaveLength(1);
    expect(openAiImageRequests[0]).toMatchObject({
      endpoint: "generate",
      request: {
        model: "gpt-image-2",
        n: 1,
        size: "2048x1152",
        quality: "low",
        output_format: "png",
      },
    });
    expect(openAiImageRequests[0]?.request?.prompt).toContain("Warm amber light");
  });

  it("uses the OpenAI image edit endpoint when styleImages are provided", async () => {
    const { generateImages } = await import("../src/llm.js");

    const images = await generateImages({
      model: "gpt-image-2",
      stylePrompt: "Match the reference palette.",
      styleImages: [{ mimeType: "image/png", data: Buffer.from("reference-image") }],
      imagePrompts: ["A small test image"],
      imageResolution: "1024x1024",
      imageQuality: "low",
    });

    expect(images).toHaveLength(1);
    expect(openAiImageRequests).toHaveLength(1);
    expect(openAiImageRequests[0]?.endpoint).toBe("edit");
    expect(openAiImageRequests[0]?.request?.image).toHaveLength(1);
    expect(openAiImageRequests[0]?.request?.prompt).toContain("attached reference image");
  });

  it("calls the ChatGPT image_generation tool for chatgpt-gpt-image-2 generateImages", async () => {
    const { generateImages } = await import("../src/llm.js");

    const images = await generateImages({
      model: "chatgpt-gpt-image-2",
      stylePrompt: "Clean icon style.",
      imagePrompts: ["A blue square"],
      numImages: 1,
    });

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data.toString()).toBe("fake-chatgpt-image");
    expect(chatGptCodexRequests).toHaveLength(1);
    expect(chatGptCodexRequests[0]).toMatchObject({
      model: "gpt-5.4",
      store: false,
      stream: true,
      tool_choice: "required",
      parallel_tool_calls: false,
      tools: [{ type: "image_generation", output_format: "png" }],
    });
  });
});
