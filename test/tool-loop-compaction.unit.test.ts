import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ToolLoopCheckpoint } from "../src/index.js";

const mocks = vi.hoisted(() => ({
  openAiRequests: [] as any[],
  openAiResponses: [] as any[],
  chatGptRequests: [] as any[],
  chatGptResponses: [] as any[],
  compactRequests: [] as any[],
  compactWindow: [] as any[],
  beforeCompact: undefined as (() => void) | undefined,
  fireworksRequests: [] as any[],
  fireworksTurns: 0,
  summaryText: "CHECKPOINT: verified result and pending work.",
  anthropicRequests: [] as any[],
  anthropicCompactRequests: [] as any[],
  xaiRequests: [] as any[],
  xaiResponses: [] as any[],
  xaiCompactRequests: [] as any[],
  xaiCompactWindow: [] as any[],
  xaiRoutes: [] as any[],
  geminiRequests: [] as any[],
  geminiCountRequests: [] as any[],
  contextRequests: [] as any[],
  contextMetadata: undefined as any,
}));

vi.mock("../src/model-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/model-context.js")>()),
  resolveModelContextWindow: async (request: any, options: any) => {
    mocks.contextRequests.push({
      request: {
        provider: request.provider,
        access: request.access,
        model: request.model,
        speed: request.speed,
      },
      options: structuredClone(options),
    });
    if (!mocks.contextMetadata) throw new Error("Unexpected context metadata lookup");
    return {
      provider: request.provider,
      access: request.access,
      model: request.model,
      ...mocks.contextMetadata,
    };
  },
}));

vi.mock("../src/openai/calls.js", () => ({
  DEFAULT_OPENAI_REASONING_EFFORT: "medium",
  runOpenAiCall: async (call: any) =>
    call({
      responses: {
        stream(request: any) {
          mocks.openAiRequests.push(structuredClone(request));
          const response = mocks.openAiResponses.shift();
          if (!response) throw new Error("Unexpected OpenAI generation");
          return {
            async *[Symbol.asyncIterator]() {},
            async finalResponse() {
              return response;
            },
          };
        },
      },
    }),
}));

vi.mock("../src/openai/chatgpt-codex.js", () => ({
  collectChatGptCodexResponse: async (options: any) => {
    mocks.chatGptRequests.push(structuredClone(options.request));
    const response = mocks.chatGptResponses.shift();
    if (!response) throw new Error("Unexpected ChatGPT generation");
    return response;
  },
  requestChatGptCodexCompaction: async (options: any) => {
    mocks.beforeCompact?.();
    mocks.compactRequests.push(structuredClone(options.request));
    return {
      output: structuredClone(mocks.compactWindow),
      usage: { input_tokens: 2000, output_tokens: 30, total_tokens: 2030 },
    };
  },
}));

vi.mock("../src/fireworks/calls.js", () => ({
  runFireworksCall: async (call: any) =>
    call({
      chat: {
        completions: {
          create: async (request: any) => {
            mocks.fireworksRequests.push(structuredClone(request));
            const summary = !request.tools?.length;
            const firstTurn = !summary && mocks.fireworksTurns++ === 0;
            return (async function* () {
              yield {
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: firstTurn
                      ? {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call_compute",
                              type: "function",
                              function: { name: "compute", arguments: "{}" },
                            },
                          ],
                        }
                      : {
                          content: summary ? mocks.summaryText : "done",
                        },
                    finish_reason: firstTurn ? "tool_calls" : "stop",
                  },
                ],
              };
              yield {
                choices: [],
                usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
              };
            })();
          },
        },
      },
    }),
}));

vi.mock("../src/xai/calls.js", () => ({
  runXaiCall: async (call: any, model: string, access: string) => {
    mocks.xaiRoutes.push({ model, access });
    return call({
      responses: {
        compact: async (request: any) => {
          mocks.xaiCompactRequests.push(structuredClone(request));
          return {
            output: structuredClone(mocks.xaiCompactWindow),
            usage: { input_tokens: 2000, output_tokens: 20, total_tokens: 2020 },
          };
        },
        stream(request: any) {
          mocks.xaiRequests.push(structuredClone(request));
          const response = mocks.xaiResponses.shift();
          if (!response) throw new Error("Unexpected xAI generation");
          return {
            async *[Symbol.asyncIterator]() {},
            async finalResponse() {
              return response;
            },
          };
        },
      },
    });
  },
}));

vi.mock("../src/google/calls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/google/calls.js")>()),
  runGeminiCall: async (call: any) =>
    call({
      models: {
        countTokens: async (request: any) => {
          mocks.geminiCountRequests.push(structuredClone(request));
          const compacted = JSON.stringify(request.contents).includes("CHECKPOINT:");
          return { totalTokens: compacted ? 200 : 5000 };
        },
        generateContentStream: async (request: any) => {
          mocks.geminiRequests.push(structuredClone(request));
          const summary = !request.config.tools?.length;
          return (async function* () {
            yield {
              modelVersion: request.model,
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: summary ? mocks.summaryText : "done" }],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 10,
                totalTokenCount: 30,
              },
            };
          })();
        },
      },
    }),
}));

vi.mock("../src/anthropic/calls.js", () => ({
  runAnthropicCall: async (call: any) =>
    call({
      compactMessage: async (request: any) => {
        mocks.anthropicCompactRequests.push(structuredClone(request));
        return {
          id: "msg_compact",
          model: request.model,
          role: "assistant",
          content: [
            { type: "compaction", content: "Native checkpoint", signature: "signed-state" },
          ],
          stop_reason: "compaction",
          usage: { input_tokens: 2000, output_tokens: 20 },
        };
      },
      streamMessage: async (request: any) => {
        mocks.anthropicRequests.push(structuredClone(request));
        const first = mocks.anthropicRequests.length === 1;
        return {
          id: `msg_${mocks.anthropicRequests.length}`,
          model: request.model,
          role: "assistant",
          content: first
            ? [{ type: "tool_use", id: "toolu_compute", name: "compute", input: {} }]
            : [{ type: "text", text: "done" }],
          stop_reason: first ? "tool_use" : "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    }),
}));

import { runAgentLoop, runToolLoop, tool } from "../src/index.js";

function openAiResponse(output: any[], id: string) {
  return {
    id,
    model: "gpt-6-luna",
    output,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  };
}

function functionCall() {
  return {
    type: "function_call",
    id: "fc_compute",
    call_id: "call_compute",
    name: "compute",
    arguments: "{}",
  };
}

function doneMessage() {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };
}

function chatGptResponse(first: boolean) {
  return {
    text: first ? "" : "done",
    reasoningText: "",
    reasoningSummaryText: "",
    toolCalls: first
      ? [
          {
            kind: "function",
            id: "fc_compute",
            callId: "call_compute",
            name: "compute",
            arguments: "{}",
          },
        ]
      : [],
    replayItems: first ? [] : [doneMessage()],
    webSearchCalls: [],
    imageGenerationCalls: [],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    model: "gpt-6-luna",
    status: "completed",
    blocked: false,
  };
}

function memory() {
  let checkpoint: ToolLoopCheckpoint | null = null;
  return {
    identity: "compaction-fixture-v1",
    load: async () => checkpoint,
    save: async (value: ToolLoopCheckpoint) => {
      checkpoint = structuredClone(value);
    },
  };
}

describe("tool-loop compaction", () => {
  beforeEach(() => {
    mocks.openAiRequests = [];
    mocks.openAiResponses = [];
    mocks.chatGptRequests = [];
    mocks.chatGptResponses = [];
    mocks.compactRequests = [];
    mocks.compactWindow = [];
    mocks.beforeCompact = undefined;
    mocks.fireworksRequests = [];
    mocks.fireworksTurns = 0;
    mocks.summaryText = "CHECKPOINT: verified result and pending work.";
    mocks.anthropicRequests = [];
    mocks.anthropicCompactRequests = [];
    mocks.xaiRequests = [];
    mocks.xaiResponses = [];
    mocks.xaiCompactRequests = [];
    mocks.xaiCompactWindow = [];
    mocks.xaiRoutes = [];
    mocks.geminiRequests = [];
    mocks.geminiCountRequests = [];
    mocks.contextRequests = [];
    mocks.contextMetadata = undefined;
  });

  it("enables inline OpenAI server compaction and continues statefully through the agent API", async () => {
    mocks.openAiResponses = [
      openAiResponse(
        [
          { type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" },
          functionCall(),
        ],
        "resp_1",
      ),
      openAiResponse([doneMessage()], "resp_2"),
    ];
    const events: any[] = [];
    const result = await runAgentLoop({
      provider: "openai",
      access: "api",
      model: "gpt-6-luna",
      input: "Compute then finish",
      compaction: { thresholdTokens: 1000 },
      filesystemTool: false,
      subagentTool: false,
      logging: false,
      tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toBe("done");
    expect(mocks.openAiRequests).toHaveLength(2);
    for (const request of mocks.openAiRequests) {
      expect(request.context_management).toEqual([{ type: "compaction", compact_threshold: 1000 }]);
    }
    expect(mocks.openAiRequests[1].previous_response_id).toBe("resp_1");
    expect(mocks.openAiRequests[1].input).toEqual([
      { type: "function_call_output", call_id: "call_compute", output: "42" },
    ]);
    expect(result.compactions).toEqual([expect.objectContaining({ mode: "server" })]);
    expect(events.some((event) => event.type === "compaction" && event.phase === "completed")).toBe(
      true,
    );
    expect(mocks.compactRequests).toHaveLength(0);
  });

  it("preserves encrypted OpenAI compaction items when persistence uses stateless replay", async () => {
    const opaque = {
      type: "compaction",
      id: "cmp_native",
      encrypted_content: "unchanged-native-state",
    };
    mocks.openAiResponses = [
      openAiResponse([opaque, functionCall()], "resp_1"),
      openAiResponse([doneMessage()], "resp_2"),
    ];
    await runToolLoop({
      provider: "openai",
      access: "api",
      model: "gpt-6-luna",
      input: "Compute then finish",
      compaction: { thresholdTokens: 1000 },
      persistence: memory(),
      tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
    });

    const next = mocks.openAiRequests[1];
    expect(next.previous_response_id).toBeUndefined();
    expect(next.input).toContainEqual(opaque);
    expect(next.input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_compute" }),
    );
  });

  it("calls ChatGPT native compaction after complete tool results and replays its entire canonical window", async () => {
    mocks.chatGptResponses = [chatGptResponse(true), chatGptResponse(false)];
    mocks.compactWindow = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "retained user" }] },
      {
        type: "compaction",
        id: "cmp_remote",
        encrypted_content: "canonical-opaque-state",
        extra: "retained",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "retained assistant" }],
        phase: "commentary",
      },
    ];
    let executions = 0;
    mocks.beforeCompact = () => expect(executions).toBe(1);
    const result = await runToolLoop({
      provider: "openai",
      access: "subscription",
      model: "gpt-6-luna",
      input: "Compute then finish",
      instructions: "Always preserve this constraint.",
      compaction: { thresholdTokens: 1000 },
      tools: {
        compute: tool({
          inputSchema: z.object({}),
          execute: () => {
            executions++;
            return "large-result ".repeat(700);
          },
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(mocks.compactRequests).toHaveLength(1);
    expect(mocks.compactRequests[0].input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_compute" }),
    );
    expect(mocks.chatGptRequests[1].input).toEqual(mocks.compactWindow);
    expect(mocks.chatGptRequests[1].instructions).toBe("Always preserve this constraint.");
    expect(result.compactions).toEqual([
      expect.objectContaining({ beforeStep: 2, mode: "server" }),
    ]);
    expect(mocks.fireworksRequests).toHaveLength(0);
  });

  it("reuses a durable ChatGPT compaction receipt when resuming after its completed event", async () => {
    mocks.chatGptResponses = [chatGptResponse(true), chatGptResponse(false)];
    mocks.compactWindow = [
      { type: "compaction", id: "cmp_receipt", encrypted_content: "durable-state" },
    ];
    const execute = vi.fn(() => "large-result ".repeat(700));
    const request = {
      provider: "openai" as const,
      access: "subscription" as const,
      model: "gpt-6-luna" as const,
      input: "Compute then finish",
      compaction: { thresholdTokens: 1000 },
      persistence: memory(),
      tools: { compute: tool({ inputSchema: z.object({}), execute }) },
    };
    await expect(
      runToolLoop({
        ...request,
        onEvent: (event) => {
          if (event.type === "compaction" && event.phase === "completed")
            throw new Error("worker interrupted");
        },
      }),
    ).rejects.toThrow("worker interrupted");
    expect(mocks.compactRequests).toHaveLength(1);

    const result = await runToolLoop(request);
    expect(result.text).toBe("done");
    expect(mocks.compactRequests).toHaveLength(1);
    expect(mocks.chatGptRequests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.chatGptRequests[1].input).toEqual(mocks.compactWindow);
  });

  it("uses native signed Anthropic compaction and preserves its response block unchanged", async () => {
    const result = await runToolLoop({
      provider: "anthropic",
      access: "api",
      model: "claude-haiku-5-5",
      input: "Compute then finish",
      instructions: "Keep the user's constraint.",
      compaction: { thresholdTokens: 1000 },
      tools: {
        compute: tool({ inputSchema: z.object({}), execute: () => "large-result ".repeat(700) }),
      },
    });

    expect(result.text).toBe("done");
    expect(mocks.anthropicCompactRequests).toHaveLength(1);
    expect(mocks.anthropicRequests[1].messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "compaction", content: "Native checkpoint", signature: "signed-state" }],
      },
    ]);
    expect(mocks.anthropicRequests[1].system).toBe("Keep the user's constraint.");
    expect(result.compactions).toEqual([
      expect.objectContaining({ beforeStep: 2, mode: "server" }),
    ]);
  });

  it("uses a custom summary prompt on the same Fireworks model and pins instructions and a safe recent turn", async () => {
    const customPrompt =
      "Preserve exact experimental decisions and pending checks. Return a checkpoint.";
    const result = await runToolLoop({
      provider: "fireworks",
      access: "api",
      model: "kimi-k3",
      speed: "standard",
      instructions: "Pinned original system instruction.",
      input: [
        { role: "user", content: "Old evidence ".repeat(900) },
        { role: "assistant", content: "Verified old conclusion." },
        { role: "user", content: "Compute the next value and finish." },
      ],
      compaction: {
        thresholdTokens: 1000,
        prompt: customPrompt,
        preserveRecentMessages: 1,
        maxSummaryTokens: 123,
      },
      tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
    });

    expect(result.text).toBe("done");
    const summaries = mocks.fireworksRequests.filter((request) => !request.tools?.length);
    const generations = mocks.fireworksRequests.filter((request) => request.tools?.length);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].max_tokens).toBe(123);
    expect(summaries[0].model).toBe(generations[0].model);
    expect(JSON.stringify(summaries[0].messages)).toContain(customPrompt);
    expect(JSON.stringify(summaries[0].messages)).toContain("Verified old conclusion.");
    expect(generations[0].messages[0]).toEqual({
      role: "system",
      content: "Pinned original system instruction.",
    });
    expect(JSON.stringify(generations[0].messages)).toContain(
      "CHECKPOINT: verified result and pending work.",
    );
    expect(generations[0].messages.at(-1)).toEqual({
      role: "user",
      content: "Compute the next value and finish.",
    });
    expect(JSON.stringify(generations[0].messages)).not.toContain("Old evidence Old evidence");
    const lastMessages = generations[1].messages;
    const call = lastMessages.find((message: any) => message.tool_calls?.length);
    const output = lastMessages.find((message: any) => message.role === "tool");
    expect(output.tool_call_id).toBe(call.tool_calls[0].id);
    expect(result.compactions).toEqual([
      expect.objectContaining({ beforeStep: 1, mode: "summary" }),
    ]);
  });

  it("uses xAI native Responses compaction and passes its canonical opaque window without stateful chaining", async () => {
    mocks.xaiResponses = [
      { ...openAiResponse([functionCall()], "xai_1"), model: "grok-4.7" },
      { ...openAiResponse([doneMessage()], "xai_2"), model: "grok-4.7" },
    ];
    mocks.xaiCompactWindow = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "retained xAI user" }],
      },
      {
        type: "compaction",
        id: "xai_cmp",
        encrypted_content: "xai-opaque-state",
        retained_field: "unchanged",
      },
    ];
    const result = await runToolLoop({
      provider: "xai",
      access: "api",
      model: "grok-4.7",
      input: "Compute then finish",
      compaction: { thresholdTokens: 1000 },
      tools: {
        compute: tool({ inputSchema: z.object({}), execute: () => "large-result ".repeat(700) }),
      },
    });

    expect(result.text).toBe("done");
    expect(mocks.xaiCompactRequests).toHaveLength(1);
    expect(mocks.xaiCompactRequests[0].model).toBe("grok-4.7");
    expect(mocks.xaiCompactRequests[0].input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_compute" }),
    );
    expect(mocks.xaiRequests[1].input).toEqual(mocks.xaiCompactWindow);
    expect(mocks.xaiRequests.every((request) => request.previous_response_id === undefined)).toBe(
      true,
    );
    expect(mocks.xaiRequests.every((request) => request.context_management === undefined)).toBe(
      true,
    );
    expect(mocks.xaiRoutes).toEqual(
      Array.from({ length: 3 }, () => ({ model: "grok-4.7", access: "api" })),
    );
    expect(mocks.openAiRequests).toHaveLength(0);
    expect(result.compactions).toEqual([
      expect.objectContaining({ beforeStep: 2, mode: "server" }),
    ]);
  });

  it("validates Gemini summary size with exact token counts that include pinned instructions and tools", async () => {
    const result = await runToolLoop({
      provider: "google",
      access: "api",
      model: "gemini-4-argon",
      instructions: "PINNED SYSTEM: preserve the user's exact constraints.",
      input: [
        { role: "developer", content: "PINNED DEVELOPER: only verified claims." },
        { role: "user", content: "Old evidence ".repeat(900) },
        { role: "assistant", content: "A verified conclusion." },
        { role: "user", content: "Continue the latest task." },
      ],
      compaction: { thresholdTokens: 1000, preserveRecentMessages: 1, maxSummaryTokens: 321 },
      tools: {
        compute: tool({
          description: "Compute a verified result",
          inputSchema: z.object({}),
          execute: () => "42",
        }),
      },
    });

    expect(result.text).toBe("done");
    expect(mocks.geminiCountRequests).toHaveLength(2);
    const generation = mocks.geminiRequests.find((request) => request.config.tools?.length);
    const summary = mocks.geminiRequests.find((request) => !request.config.tools?.length);
    expect(summary.config.maxOutputTokens).toBe(321);
    for (const counted of mocks.geminiCountRequests) {
      expect(counted.model).toBe("gemini-4-argon");
      expect(counted.config.tools).toEqual(generation.config.tools);
      expect(counted.config.systemInstruction).toEqual(generation.config.systemInstruction);
      expect(JSON.stringify(counted.config.systemInstruction)).toContain("PINNED SYSTEM");
      expect(JSON.stringify(counted.config.systemInstruction)).toContain("PINNED DEVELOPER");
    }
    expect(mocks.geminiCountRequests[0].contents).not.toEqual(
      mocks.geminiCountRequests[1].contents,
    );
    const compactedCount = mocks.geminiCountRequests.find((request) =>
      JSON.stringify(request.contents).includes("CHECKPOINT:"),
    );
    expect(generation.contents).toEqual(compactedCount.contents);
    expect(JSON.stringify(generation.contents)).not.toContain("Old evidence Old evidence");
    expect(JSON.stringify(generation.contents)).toContain("Continue the latest task.");
    expect(result.compactions).toEqual([
      expect.objectContaining({ beforeStep: 1, mode: "summary" }),
    ]);
  });

  it.each([
    { label: "empty", summary: "", error: /empty or blocked summary/ },
    {
      label: "inflated",
      summary: "Inflated summary ".repeat(5000),
      error: /did not reduce context size/,
    },
  ])("does not rebill a rejected $label summary when a persistent run resumes", async ({
    summary,
    error,
  }) => {
    mocks.summaryText = summary;
    const request = {
      provider: "fireworks" as const,
      access: "api" as const,
      model: "kimi-k3" as const,
      instructions: "Keep this constraint.",
      input: "Old evidence ".repeat(900),
      compaction: { thresholdTokens: 1000, preserveRecentMessages: 0 },
      persistence: memory(),
      tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
    };

    await expect(runToolLoop(request)).rejects.toThrow(error);
    expect(mocks.fireworksRequests).toHaveLength(1);
    await expect(runToolLoop(request)).rejects.toThrow(error);
    expect(mocks.fireworksRequests).toHaveLength(1);
    expect(mocks.fireworksTurns).toBe(0);
  });

  it.each([
    { maxOutputTokens: 1000, expectedThreshold: 8000 },
    { maxOutputTokens: 4000, expectedThreshold: 6000 },
  ])("derives the default threshold from model context and reserves $maxOutputTokens output tokens", async ({
    maxOutputTokens,
    expectedThreshold,
  }) => {
    mocks.contextMetadata = {
      contextWindowTokens: 10_000,
      maxOutputTokens,
      limitType: "context",
      source: "provider",
    };
    mocks.openAiResponses = [openAiResponse([doneMessage()], "resp_done")];
    await runToolLoop({
      provider: "openai",
      access: "api",
      model: "gpt-6-luna",
      input: "Finish",
      compaction: {},
      tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
    });

    expect(mocks.contextRequests).toHaveLength(1);
    expect(mocks.contextRequests[0].request).toMatchObject({
      provider: "openai",
      access: "api",
      model: "gpt-6-luna",
    });
    expect(mocks.openAiRequests[0].context_management).toEqual([
      { type: "compaction", compact_threshold: expectedThreshold },
    ]);
  });

  it("rejects invalid thresholds before contacting a provider", async () => {
    await expect(
      runToolLoop({
        provider: "openai",
        access: "api",
        model: "gpt-6-luna",
        input: "Compute",
        compaction: { thresholdTokens: 0 },
        tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
      }),
    ).rejects.toThrow("thresholdTokens");
    expect(mocks.openAiRequests).toHaveLength(0);
  });

  it("rejects explicit server mode on a route without native compaction", async () => {
    await expect(
      runToolLoop({
        provider: "fireworks",
        model: "kimi-k3",
        input: "Compute",
        compaction: { mode: "server", thresholdTokens: 1000 },
        tools: { compute: tool({ inputSchema: z.object({}), execute: () => "42" }) },
      }),
    ).rejects.toThrow(/compaction|server/i);
    expect(mocks.fireworksRequests).toHaveLength(0);
  });
});
