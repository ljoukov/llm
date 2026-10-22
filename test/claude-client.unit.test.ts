import type { AccountInfo, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runClaudeQuery } from "../src/claude/calls.js";
import {
  ClaudeSubscriptionError,
  runClaudeQueryImpl,
  type ClaudeQueryRequest,
} from "../src/claude/client.js";
import {
  configureModelConcurrency,
  resetModelConcurrencyConfig,
} from "../src/utils/modelConcurrency.js";

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  tool: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
  createSdkMcpServer: vi.fn((config) => config),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);

type QueryInput = { prompt: AsyncGenerator<SDKUserMessage>; options: Options };
const account: AccountInfo = {
  apiProvider: "firstParty",
  apiKeySource: "none",
  subscriptionType: "max",
};
const request: ClaudeQueryRequest = {
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: "Hello" }],
};

function result(fields: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Hello!",
    usage: { input_tokens: 10, output_tokens: 2 },
    modelUsage: {},
    stop_reason: "end_turn",
    ...fields,
  };
}

function message(id = "msg_1", fields: Record<string, unknown> = {}) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
    ...fields,
  };
}

function event(type: string, fields: Record<string, unknown> = {}) {
  return { type: "stream_event", parent_tool_use_id: null, event: { type, ...fields } };
}

function stubQuery(
  messages: unknown[] = [result()],
  config: {
    accountInfo?: () => Promise<AccountInfo>;
    iterate?: (input: QueryInput) => AsyncGenerator<unknown>;
  } = {},
) {
  const close = vi.fn();
  const accountInfo = vi.fn(config.accountInfo ?? (async () => account));
  let input: QueryInput | undefined;
  const prompts: SDKUserMessage[] = [];
  sdk.query.mockImplementation((value: QueryInput) => {
    input = value;
    const iterator = (async function* () {
      for await (const prompt of value.prompt) prompts.push(prompt);
      if (config.iterate) yield* config.iterate(value);
      else yield* messages;
    })();
    return Object.assign(iterator, { accountInfo, close });
  });
  return {
    close,
    accountInfo,
    prompts,
    input: () => {
      if (!input) throw new Error("SDK query has not started");
      return input;
    },
  };
}

function hook(input: QueryInput, name: "PreToolUse" | "PostToolUse" | "PostToolBatch" | "Stop") {
  const fn = input.options.hooks?.[name]?.[0]?.hooks[0];
  const controller = input.options.abortController;
  if (!fn || !controller) throw new Error(`Missing ${name} hook or abort controller`);
  return (value: Record<string, unknown>) =>
    fn(value as never, undefined, { signal: controller.signal });
}

function toolHandler(input: QueryInput, index = 0) {
  const server = input.options.mcpServers?.llm as unknown as {
    tools: { handler: (args: unknown) => Promise<unknown> }[];
  };
  const tool = server.tools[index];
  if (!tool) throw new Error("Missing SDK tool");
  return tool.handler;
}

describe("Claude subscription Agent SDK transport", () => {
  beforeEach(() => {
    sdk.query.mockReset();
    sdk.tool.mockClear();
    sdk.createSdkMcpServer.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelConcurrencyConfig();
  });

  it("keeps the prompt gated until the account confirms subscription authentication", async () => {
    let allow: ((value: AccountInfo) => void) | undefined;
    let promptRead: Promise<IteratorResult<SDKUserMessage>> | undefined;
    let input: QueryInput | undefined;
    const close = vi.fn();
    sdk.query.mockImplementation((value: QueryInput) => {
      input = value;
      promptRead = value.prompt.next();
      return Object.assign(
        (async function* () {
          yield result();
        })(),
        {
          accountInfo: () =>
            new Promise<AccountInfo>((resolve) => {
              allow = resolve;
            }),
          close,
        },
      );
    });
    const running = runClaudeQueryImpl(request);
    await vi.waitFor(() => expect(allow).toBeTypeOf("function"));
    if (!allow || !promptRead || !input) throw new Error("Query did not start");
    let released = false;
    void promptRead.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    allow(account);
    await expect(running).resolves.toMatchObject({ text: "Hello!" });
    expect((await promptRead).value?.message.content).toBe("Hello");
    expect(close).toHaveBeenCalledOnce();
    expect(input.options.abortController?.signal.aborted).toBe(true);
  });

  it.each([
    { apiProvider: "bedrock", apiKeySource: "none", subscriptionType: "max" },
    { apiProvider: "vertex", apiKeySource: "none", subscriptionType: "enterprise" },
    { apiProvider: "firstParty", apiKeySource: "user", subscriptionType: "max" },
    { apiProvider: "firstParty", apiKeySource: "project", subscriptionType: "pro" },
    { apiProvider: "firstParty", apiKeySource: "none", subscriptionType: "free" },
    { apiProvider: "firstParty", apiKeySource: "none" },
  ])("rejects a non-subscription account without releasing the prompt: %j", async (info) => {
    let promptRead: Promise<IteratorResult<SDKUserMessage>> | undefined;
    const close = vi.fn();
    sdk.query.mockImplementation((input: QueryInput) => {
      promptRead = input.prompt.next();
      return Object.assign((async function* () {})(), { accountInfo: async () => info, close });
    });
    await expect(runClaudeQueryImpl(request)).rejects.toThrow(ClaudeSubscriptionError);
    await expect(promptRead).resolves.toMatchObject({ done: true, value: undefined });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    "pro",
    "max",
    "team",
    "enterprise",
    " MAX ",
  ])("accepts the %s subscription plan", async (subscriptionType) => {
    stubQuery([result()], {
      accountInfo: async () => ({ ...account, subscriptionType }),
    });
    await expect(runClaudeQueryImpl(request)).resolves.toMatchObject({ text: "Hello!" });
  });

  it("isolates credentials and disables ambient tools, project configuration, and persistence", async () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDECODE",
      "AWS_ACCESS_KEY_ID",
      "AMAZON_BEDROCK_BASE_URL",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GCLOUD_PROJECT",
      "VERTEX_PROJECT",
      "AZURE_API_KEY",
      "FOUNDRY_API_KEY",
    ])
      vi.stubEnv(name, "should-not-reach-cli");
    vi.stubEnv("LLM_CLAUDE_EXECUTABLE", "/opt/test/claude");
    vi.stubEnv("LLM_SUBSCRIPTION_TEST_SETTING", "preserved");
    const mocked = stubQuery();
    await runClaudeQueryImpl({
      ...request,
      system: "Use the provided context.",
      maxSteps: 4,
      maxOutputTokens: 123,
      effort: "ultra",
    });
    const { options } = mocked.input();
    expect(options).toMatchObject({
      model: request.model,
      systemPrompt: "Use the provided context.",
      pathToClaudeCodeExecutable: "/opt/test/claude",
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      extraArgs: { "safe-mode": null },
      plugins: [],
      skills: [],
      agents: {},
      persistSession: false,
      enableFileCheckpointing: false,
      includePartialMessages: true,
      permissionMode: "dontAsk",
      maxTurns: 4,
      effort: "max",
    });
    expect(options.env).toMatchObject({
      LLM_SUBSCRIPTION_TEST_SETTING: "preserved",
      CLAUDE_AGENT_SDK_CLIENT_APP: "@ljoukov/llm",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "123",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(Object.values(options.env ?? {})).not.toContain("should-not-reach-cli");
    expect(process.env.ANTHROPIC_API_KEY).toBe("should-not-reach-cli");
  });

  it("assembles streamed thoughts, signatures, text, usage, and one callback per assistant turn", async () => {
    const onDelta = vi.fn();
    const onAssistantMessage = vi.fn();
    const first = message();
    stubQuery([
      event("message_start", { message: first }),
      event("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "Consider ", signature: "" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "it." },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      }),
      event("content_block_start", {
        index: 1,
        content_block: { type: "text", text: "Hello " },
      }),
      event("content_block_delta", {
        index: 1,
        delta: { type: "text_delta", text: "🌍" },
      }),
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      event("message_stop"),
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { ...first, content: [{ type: "text", text: "Hello 🌍" }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: "nested-tool",
        message: message("nested", { content: [{ type: "text", text: "Hidden subagent" }] }),
      },
      event("message_start", { message: message("msg_2") }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "!" } }),
      event("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }),
      event("message_stop"),
      result(),
    ]);
    const response = await runClaudeQueryImpl({ ...request, onDelta, onAssistantMessage });
    expect(response).toMatchObject({
      text: "!",
      thoughts: "",
      usage: { input_tokens: 10, output_tokens: 2 },
      finishReason: "end_turn",
    });
    expect(onAssistantMessage).toHaveBeenCalledTimes(2);
    expect(onAssistantMessage.mock.calls[0]).toEqual([
      expect.objectContaining({
        id: "msg_1",
        content: [
          { type: "thinking", thinking: "Consider it.", signature: "sig" },
          { type: "text", text: "Hello 🌍" },
        ],
      }),
      { turn: 1 },
    ]);
    expect(onAssistantMessage.mock.calls[1]?.[1]).toEqual({ turn: 2 });
    expect(onDelta.mock.calls).toEqual([
      ["thought", "Consider "],
      ["thought", "it."],
      ["response", "Hello "],
      ["response", "🌍"],
      ["response", "!"],
    ]);
  });

  it("suppresses prose in structured output and emits the verified structured result once", async () => {
    const onDelta = vi.fn();
    const mocked = stubQuery([
      event("message_start", { message: message() }),
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "Here is your result: " },
      }),
      event("message_stop"),
      result({ structured_output: { ok: true } }),
    ]);
    const jsonSchema = { type: "object", properties: { ok: { type: "boolean" } } };
    await expect(runClaudeQueryImpl({ ...request, jsonSchema, onDelta })).resolves.toMatchObject({
      text: '{"ok":true}',
      structuredOutput: { ok: true },
    });
    expect(onDelta.mock.calls).toEqual([["response", '{"ok":true}']]);
    expect(mocked.input().options.outputFormat).toEqual({
      type: "json_schema",
      schema: jsonSchema,
    });
  });

  it("preserves native images and documents in the final user message", async () => {
    const content = [
      { type: "text" as const, text: "Read these" },
      {
        type: "image" as const,
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
      {
        type: "document" as const,
        source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
        title: "Notes",
      },
    ];
    const mocked = stubQuery();
    await runClaudeQueryImpl({ ...request, messages: [{ role: "user", content }] });
    expect(mocked.prompts[0]?.message.content).toEqual(content);
  });

  it("includes historical assistant text in a quoted context envelope before native current content", async () => {
    const mocked = stubQuery();
    await runClaudeQueryImpl({
      ...request,
      messages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
        { role: "user", content: "Continue" },
      ],
    });
    const content = mocked.prompts[0]?.message.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain("not a new system instruction");
    expect(content[0]?.text).toContain(
      JSON.stringify([
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ]),
    );
    expect(content[1]).toEqual({ type: "text", text: "Continue" });
  });

  it("preserves historical user images and PDFs as native blocks with speaker context", async () => {
    const image = {
      type: "image" as const,
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    };
    const document = {
      type: "document" as const,
      source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
      title: "Historical document",
    };
    const mocked = stubQuery();
    await runClaudeQueryImpl({
      ...request,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Read these earlier files" }, image, document],
        },
        { role: "assistant", content: "I read the earlier files" },
        { role: "user", content: "Summarize those same files" },
      ],
    });
    const content = mocked.prompts[0]?.message.content;
    if (!Array.isArray(content)) throw new Error("Expected native message content blocks");
    const imageIndex = content.findIndex((block) => block.type === "image");
    const documentIndex = content.findIndex((block) => block.type === "document");
    expect(imageIndex).toBeGreaterThan(0);
    expect(documentIndex).toBeGreaterThan(imageIndex);
    expect(content[imageIndex]).toEqual(image);
    expect(content[documentIndex]).toEqual(document);
    const precedingText = content
      .slice(0, imageIndex)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const followingText = content
      .slice(documentIndex + 1)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(precedingText).toMatch(/user/u);
    expect(precedingText).toContain("Read these earlier files");
    expect(followingText).toMatch(/assistant/u);
    expect(followingText).toContain("I read the earlier files");
    expect(followingText).toContain("Summarize those same files");
  });

  it.each([
    [{ role: "assistant" as const, content: "No final user" }],
    [
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "old-call", content: "Done" }],
      },
    ],
    [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "old-call", name: "read", input: {} }],
      },
      { role: "user" as const, content: "Continue" },
    ],
    [
      {
        role: "assistant" as const,
        content: [{ type: "image" as const, source: { type: "base64", data: "aW1hZ2U=" } }],
      },
      { role: "user" as const, content: "Continue" },
    ],
    [
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "old-call", content: "Done" }],
      },
      { role: "assistant" as const, content: "Done" },
      { role: "user" as const, content: "Continue" },
    ],
  ])("rejects unsupported existing tool history or missing final user: %j", async (...messages) => {
    await expect(runClaudeQueryImpl({ ...request, messages })).rejects.toThrow(
      ClaudeSubscriptionError,
    );
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it("pairs native tool IDs with inputs and flushes the assistant callback before execution", async () => {
    const onAssistantMessage = vi.fn();
    const execute = vi.fn(async (_args, context) => {
      expect(onAssistantMessage).toHaveBeenCalledOnce();
      return { content: `Completed ${context.callId}` };
    });
    const mocked = stubQuery([], {
      iterate: async function* (input) {
        yield event("message_start", { message: message() });
        yield event("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: "native-a", name: "mcp__llm__tool_0", input: {} },
        });
        yield event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"a":1,' },
        });
        yield event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"b":2}' },
        });
        const pre = hook(input, "PreToolUse");
        for (const id of ["native-a", "native-b"])
          await expect(
            pre({
              hook_event_name: "PreToolUse",
              tool_name: "mcp__llm__tool_0",
              tool_input: { a: 1, b: 2 },
              tool_use_id: id,
            }),
          ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
        const call = toolHandler(input);
        await expect(call({ b: 2, a: 1 })).resolves.toEqual({
          content: [{ type: "text", text: "Completed native-a" }],
        });
        await call({ a: 1, b: 2 });
        yield event("message_stop");
        yield result();
      },
    });
    await runClaudeQueryImpl({
      ...request,
      onAssistantMessage,
      tools: [
        {
          name: "read",
          description: "Read a record",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute,
        },
      ],
    });
    expect(execute.mock.calls).toEqual([
      [
        { a: 1, b: 2 },
        { callId: "native-a", turn: 1, toolIndex: 1 },
      ],
      [
        { a: 1, b: 2 },
        { callId: "native-b", turn: 1, toolIndex: 2 },
      ],
    ]);
    expect(onAssistantMessage.mock.calls[0]?.[0].content).toEqual([
      { type: "tool_use", id: "native-a", name: "read", input: { a: 1, b: 2 } },
    ]);
    expect(mocked.input().options.allowedTools).toEqual(["mcp__llm__tool_0"]);
    expect(sdk.tool).toHaveBeenCalledWith(
      "tool_0",
      "read: Read a record",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("stops after a terminal tool using PostToolUse without requiring another model turn", async () => {
    const execute = vi.fn(async () => ({ content: "Finished", terminal: true }));
    const onAssistantMessage = vi.fn();
    const drainSteering = vi.fn(() => "Should remain queued");
    const mocked = stubQuery([], {
      iterate: async function* (input) {
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: message("terminal", {
            content: [{ type: "tool_use", id: "final-id", name: "mcp__llm__tool_0", input: {} }],
          }),
        };
        await hook(
          input,
          "PreToolUse",
        )({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__llm__tool_0",
          tool_input: {},
          tool_use_id: "final-id",
        });
        await toolHandler(input)({});
        expect(
          await hook(
            input,
            "PostToolUse",
          )({
            hook_event_name: "PostToolUse",
            tool_name: "mcp__llm__tool_0",
            tool_use_id: "final-id",
          }),
        ).toMatchObject({ continue: false });
        await hook(input, "PostToolBatch")({ hook_event_name: "PostToolBatch" });
        await hook(input, "Stop")({ hook_event_name: "Stop", stop_hook_active: false });
        expect(drainSteering).not.toHaveBeenCalled();
      },
    });
    await expect(
      runClaudeQueryImpl({
        ...request,
        onAssistantMessage,
        drainSteering,
        tools: [{ name: "finish", inputSchema: z.object({}), execute }],
      }),
    ).resolves.toMatchObject({ finishReason: "terminal_tool" });
    expect(execute).toHaveBeenCalledOnce();
    expect(onAssistantMessage).toHaveBeenCalledOnce();
    expect(mocked.close).toHaveBeenCalledOnce();
  });

  it("drains a follow-up after a tool batch before the next assistant turn", async () => {
    const drainSteering = vi.fn(() => "Use the newer filename");
    const onAssistantMessage = vi.fn();
    const execute = vi.fn(async () => ({ content: "Read the first filename" }));
    stubQuery([], {
      iterate: async function* (input) {
        yield event("message_start", { message: message("before-steering") });
        yield event("message_stop");
        await hook(
          input,
          "PreToolUse",
        )({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__llm__tool_0",
          tool_input: {},
          tool_use_id: "steering-tool",
        });
        await toolHandler(input)({});
        expect(drainSteering).not.toHaveBeenCalled();
        await expect(
          hook(input, "PostToolBatch")({ hook_event_name: "PostToolBatch" }),
        ).resolves.toMatchObject({
          hookSpecificOutput: {
            additionalContext: "New user follow-up instructions:\nUse the newer filename",
          },
        });
        expect(drainSteering).toHaveBeenCalledOnce();
        expect(onAssistantMessage).toHaveBeenCalledOnce();
        yield event("message_start", { message: message("after-steering") });
        yield event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "Used the newer filename" },
        });
        yield event("message_stop");
        yield result();
      },
    });
    await expect(
      runClaudeQueryImpl({
        ...request,
        drainSteering,
        onAssistantMessage,
        tools: [{ name: "read", inputSchema: z.object({}), execute }],
      }),
    ).resolves.toMatchObject({ text: "Used the newer filename" });
    expect(onAssistantMessage.mock.calls.map((call) => call[1])).toEqual([
      { turn: 1 },
      { turn: 2 },
    ]);
  });

  it("drains queued steering from Stop for continuation and returns no override when empty", async () => {
    const drainSteering = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce("Please add a short example")
      .mockReturnValueOnce(undefined);
    stubQuery([], {
      iterate: async function* (input) {
        await expect(
          hook(input, "Stop")({ hook_event_name: "Stop", stop_hook_active: false }),
        ).resolves.toMatchObject({
          hookSpecificOutput: {
            additionalContext: "New user follow-up instructions:\nPlease add a short example",
          },
        });
        await expect(
          hook(input, "Stop")({ hook_event_name: "Stop", stop_hook_active: true }),
        ).resolves.toEqual({});
        yield result();
      },
    });
    await runClaudeQueryImpl({ ...request, drainSteering });
    expect(drainSteering).toHaveBeenCalledTimes(2);
  });

  it("leaves transformed inputs raw until the caller performs its single validation", async () => {
    const transform = vi.fn((value: string) => Number(value));
    const schema = z.object({ amount: z.string().transform(transform) });
    const execute = vi.fn(async (args: unknown) => {
      expect(args).toEqual({ amount: "7" });
      expect(transform).not.toHaveBeenCalled();
      const parsed = schema.parse(args);
      return { content: String(parsed.amount) };
    });
    stubQuery([], {
      iterate: async function* (input) {
        const raw = { amount: "7" };
        await hook(
          input,
          "PreToolUse",
        )({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__llm__tool_0",
          tool_input: raw,
          tool_use_id: "transform-id",
        });
        expect(transform).not.toHaveBeenCalled();
        const server = input.options.mcpServers?.llm as unknown as {
          tools: { inputSchema: z.ZodRawShape }[];
        };
        const transportSchema = server.tools[0]?.inputSchema;
        if (!transportSchema) throw new Error("Missing transport input schema");
        const validated = z.object(transportSchema).parse(raw);
        expect(validated).toEqual(raw);
        expect(transform).not.toHaveBeenCalled();
        await expect(toolHandler(input)(validated)).resolves.toEqual({
          content: [{ type: "text", text: "7" }],
        });
        yield result();
      },
    });
    await runClaudeQueryImpl({
      ...request,
      tools: [{ name: "transform", inputSchema: schema, execute }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledOnce();
  });

  it("allows a same-model query from a tool when subscription concurrency is one", async () => {
    configureModelConcurrency({ providerCaps: { claude: 1 } });
    const execute = vi.fn(async () => {
      const nested = await runClaudeQuery({
        ...request,
        messages: [{ role: "user", content: "Child" }],
      });
      return { content: nested.text };
    });
    const mocked = stubQuery([], {
      iterate: async function* (input) {
        if (input.options.allowedTools?.length) {
          await hook(
            input,
            "PreToolUse",
          )({
            hook_event_name: "PreToolUse",
            tool_name: "mcp__llm__tool_0",
            tool_input: {},
            tool_use_id: "nested-call",
          });
          await expect(toolHandler(input)({})).resolves.toEqual({
            content: [{ type: "text", text: "Child response" }],
          });
          yield result({ result: "Parent response" });
        } else yield result({ result: "Child response" });
      },
    });
    await expect(
      runClaudeQuery({
        ...request,
        tools: [{ name: "ask_child", inputSchema: z.object({}), execute }],
      }),
    ).resolves.toMatchObject({ text: "Parent response" });
    expect(execute).toHaveBeenCalledOnce();
    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(mocked.close).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued subscription query without launching a second CLI process", async () => {
    configureModelConcurrency({ providerCaps: { claude: 1 } });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubQuery([], {
      iterate: async function* () {
        await gate;
        yield result();
      },
    });
    const first = runClaudeQuery({ ...request, model: "claude-haiku-5-5" });
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const onSettled = vi.fn();
    const second = runClaudeQuery(
      { ...request, model: "claude-haiku-5-5", signal: controller.signal },
      { onSettled },
    );
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(sdk.query).toHaveBeenCalledOnce();
    if (!release) throw new Error("Missing test gate release");
    release();
    await first;
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(sdk.query).toHaveBeenCalledOnce();
  });

  it("surfaces tool execution failures and closes the SDK query", async () => {
    const failure = new Error("Internal tool failed");
    const mocked = stubQuery([], {
      iterate: async function* (input) {
        await hook(
          input,
          "PreToolUse",
        )({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__llm__tool_0",
          tool_input: {},
          tool_use_id: "failure-id",
        });
        await toolHandler(input)({});
        yield result();
      },
    });
    await expect(
      runClaudeQueryImpl({
        ...request,
        tools: [
          {
            name: "fail",
            inputSchema: z.object({}),
            execute: async () => {
              throw failure;
            },
          },
        ],
      }),
    ).rejects.toBe(failure);
    expect(mocked.close).toHaveBeenCalledOnce();
    expect(mocked.input().options.abortController?.signal.aborted).toBe(true);
  });

  it("rejects a tool invocation that lacks an authenticated matching native tool-use context", async () => {
    const execute = vi.fn();
    stubQuery([], {
      iterate: async function* (input) {
        await toolHandler(input)({});
        yield result();
      },
    });
    await expect(
      runClaudeQueryImpl({
        ...request,
        tools: [{ name: "read", inputSchema: z.object({}), execute }],
      }),
    ).rejects.toThrow("without a matching tool-use context");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { maxSteps: 0 },
    { maxSteps: 1.5 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: Number.NaN },
  ])("validates bounded query options before launching Claude: %j", async (options) => {
    await expect(runClaudeQueryImpl({ ...request, ...options })).rejects.toThrow(
      ClaudeSubscriptionError,
    );
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted signal before launching Claude", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runClaudeQueryImpl({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it("forwards in-flight cancellation and removes the listener during cleanup", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const mocked = stubQuery([], {
      iterate: async function* (input) {
        controller.abort();
        expect(input.options.abortController?.signal.aborted).toBe(true);
        yield result();
      },
    });
    await expect(
      runClaudeQueryImpl({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(mocked.close).toHaveBeenCalledOnce();
  });

  it("closes the query when account verification fails", async () => {
    const failure = new Error("Account lookup failed");
    const mocked = stubQuery([], {
      accountInfo: async () => {
        throw failure;
      },
    });
    await expect(runClaudeQueryImpl(request)).rejects.toBe(failure);
    expect(mocked.prompts).toEqual([]);
    expect(mocked.close).toHaveBeenCalledOnce();
  });

  it.each([
    [[], "ended without a result"],
    [[{ type: "assistant", error: "rate_limit", parent_tool_use_id: null }], "rate_limit"],
    [
      [result({ subtype: "error_during_execution", is_error: true, errors: ["Request failed"] })],
      "Request failed",
    ],
    [
      [{ type: "system", subtype: "init", model: request.model, apiKeySource: "user" }],
      "refuse this fallback",
    ],
  ])("surfaces SDK errors and unexpected termination", async (messages, expected) => {
    const mocked = stubQuery(messages);
    await expect(runClaudeQueryImpl(request)).rejects.toThrow(expected);
    expect(mocked.close).toHaveBeenCalledOnce();
  });

  it("returns max_steps as a bounded completion and preserves native cumulative cache usage", async () => {
    stubQuery([
      result({
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Maximum turns reached"],
        stop_reason: null,
        usage: {
          input_tokens: 21,
          output_tokens: 7,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 5 },
        },
        modelUsage: {
          first: {
            inputTokens: 12,
            outputTokens: 3,
            cacheReadInputTokens: 7,
            cacheCreationInputTokens: 2,
          },
          second: {
            inputTokens: 9,
            outputTokens: 4,
            cacheReadInputTokens: 1,
            cacheCreationInputTokens: 5,
          },
        },
      }),
    ]);
    await expect(runClaudeQueryImpl(request)).resolves.toMatchObject({
      finishReason: "max_steps",
      usage: {
        input_tokens: 21,
        output_tokens: 7,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 5 },
      },
    });
  });
});
