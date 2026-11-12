import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatGptAuthMock = vi.hoisted(() => ({
  getChatGptAuthProfile: vi.fn(async () => ({
    access: "test-access",
    refresh: "test-refresh",
    expires: Date.now() + 60_000,
    accountId: "test-account",
  })),
}));

vi.mock("../src/openai/chatgpt-auth.js", () => {
  return chatGptAuthMock;
});

import {
  collectChatGptCodexResponse,
  configureChatGptCodexProxy,
  fetchChatGptCodexModels,
  requestChatGptCodexCompaction,
} from "../src/openai/chatgpt-codex.js";

function buildSseResponse(events: readonly unknown[]): Response {
  const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("collectChatGptCodexResponse", () => {
  const originalChatGptWebSocketMode = process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE;
  const originalChatGptCodexEndpoint = process.env.CHATGPT_CODEX_ENDPOINT;
  const originalChatGptCodexProxyUrl = process.env.LLM_PROXY_URL;
  const originalChatGptCodexProxyApiKey = process.env.LLM_PROXY_API_KEY;

  beforeEach(() => {
    process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE = "off";
    delete process.env.CHATGPT_CODEX_ENDPOINT;
    delete process.env.LLM_PROXY_URL;
    delete process.env.LLM_PROXY_API_KEY;
    configureChatGptCodexProxy(null);
    chatGptAuthMock.getChatGptAuthProfile.mockClear();
  });

  afterEach(() => {
    if (originalChatGptWebSocketMode === undefined) {
      delete process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE;
    } else {
      process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE = originalChatGptWebSocketMode;
    }
    if (originalChatGptCodexEndpoint === undefined) {
      delete process.env.CHATGPT_CODEX_ENDPOINT;
    } else {
      process.env.CHATGPT_CODEX_ENDPOINT = originalChatGptCodexEndpoint;
    }
    if (originalChatGptCodexProxyUrl === undefined) {
      delete process.env.LLM_PROXY_URL;
    } else {
      process.env.LLM_PROXY_URL = originalChatGptCodexProxyUrl;
    }
    if (originalChatGptCodexProxyApiKey === undefined) {
      delete process.env.LLM_PROXY_API_KEY;
    } else {
      process.env.LLM_PROXY_API_KEY = originalChatGptCodexProxyApiKey;
    }
    vi.unstubAllGlobals();
    configureChatGptCodexProxy(null);
  });

  it("preserves opaque continuation and exposed summaries without raw reasoning content", async () => {
    configureChatGptCodexProxy({
      url: "https://runtime-proxy.example/",
      apiKey: "runtime-proxy-key",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        buildSseResponse([
          { type: "response.reasoning_text.delta", delta: "not collected" },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "reasoning",
                  id: "r1",
                  encrypted_content: "opaque",
                  summary: [{ type: "summary_text", text: "Exposed summary" }],
                  content: [{ type: "reasoning_text", text: "not collected" }],
                },
                {
                  type: "message",
                  role: "assistant",
                  phase: "commentary",
                  content: [{ type: "output_text", text: "Visible message" }],
                },
              ],
            },
          },
        ]),
      ),
    );
    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });
    expect(result.reasoningSummaryText).toBe("Exposed summary");
    expect(result.text).toBe("Visible message");
    expect(JSON.stringify(result.replayItems)).toContain("opaque");
    expect(JSON.stringify(result.replayItems)).toContain("commentary");
    expect(JSON.stringify(result)).not.toContain("not collected");
  });

  it("preserves complete opaque compaction items received in output events", async () => {
    const compaction = {
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "opaque-compaction-state",
      internal_chat_message_metadata_passthrough: { retained: true },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        buildSseResponse([
          { type: "response.output_item.done", output_index: 0, item: compaction },
        ]),
      ),
    );
    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });
    expect(result.replayItems).toEqual([compaction]);
    expect(result.text).toBe("");
    expect(result.reasoningSummaryText).toBe("");
  });

  it.each([
    "compaction",
    "compaction_summary",
    "context_compaction",
  ])("preserves %s opaque items from the canonical completed response", async (type) => {
    const compaction = { type, encrypted_content: "opaque-state", extra: { value: 1 } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        buildSseResponse([{ type: "response.completed", response: { output: [compaction] } }]),
      ),
    );
    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });
    expect(result.replayItems).toEqual([compaction]);
  });

  it("uses current server compaction V2 on the normal Responses route by default", async () => {
    configureChatGptCodexProxy({
      url: "https://proxy.example/api/app/responses",
      apiKey: "llmc_app",
    });
    const compaction = {
      type: "compaction",
      id: "cmp_v2",
      encrypted_content: "opaque-v2",
      extra: { keep: true },
    };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://proxy.example/api/app/responses");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
      expect(headers.get("authorization")).toBe("Bearer llmc_app");
      expect(headers.get("session_id")).toBe("session-v2");
      expect(JSON.parse(init?.body as string)).toMatchObject({
        model: "gpt-6.1-sol",
        input: [{ role: "user", content: "history" }, { type: "compaction_trigger" }],
        instructions: "Keep working",
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      });
      return buildSseResponse([
        { type: "response.output_item.done", output_index: 0, item: compaction },
        {
          type: "response.completed",
          response: {
            id: "resp_v2",
            status: "completed",
            output: [compaction],
            usage: { input_tokens: 200, output_tokens: 20 },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestChatGptCodexCompaction({
      sessionId: "session-v2",
      request: {
        model: "gpt-6.1-sol",
        input: [{ role: "user", content: "history" }],
        instructions: "Keep working",
      },
    });
    expect(result).toEqual({
      output: [compaction],
      usage: { input_tokens: 200, output_tokens: 20 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing completion",
      events: [
        {
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque" },
        },
      ],
      expected: "closed before response.completed",
    },
    {
      name: "missing compaction",
      events: [{ type: "response.completed", response: { status: "completed", output: [] } }],
      expected: "exactly one opaque compaction",
    },
    {
      name: "multiple compactions",
      events: [
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              { type: "compaction", encrypted_content: "one" },
              { type: "compaction", encrypted_content: "two" },
            ],
          },
        },
      ],
      expected: "exactly one opaque compaction",
    },
    {
      name: "invalid opaque state",
      events: [
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "compaction", encrypted_content: "" }],
          },
        },
      ],
      expected: "exactly one opaque compaction",
    },
  ])("rejects server V2 $name before replacing conversation history", async ({
    events,
    expected,
  }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildSseResponse(events)),
    );
    await expect(
      requestChatGptCodexCompaction({
        request: { model: "gpt-6.1-sol", input: [{ role: "user", content: "history" }] },
      }),
    ).rejects.toThrow(expected);
  });

  it("retries a transient V2 HTTP failure before consuming the response stream", async () => {
    const controller = new AbortController();
    const compaction = { type: "compaction", encrypted_content: "retried-v2-opaque" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 502 }))
      .mockResolvedValueOnce(
        buildSseResponse([
          { type: "response.output_item.done", item: compaction },
          { type: "response.completed", response: { status: "completed", output: [compaction] } },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestChatGptCodexCompaction({
        request: { model: "gpt-6.1-sol", input: [{ role: "user", content: "history" }] },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ output: [compaction] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("propagates V2 authorization failures without retrying or switching transports", async () => {
    const fetchMock = vi.fn(async () => new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestChatGptCodexCompaction({
        request: { model: "gpt-6.1-sol", input: [{ role: "user", content: "history" }] },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls native unary compaction with subscription auth and retains the entire canonical window", async () => {
    process.env.CHATGPT_CODEX_ENDPOINT = "https://codex.example/backend/responses?test=1";
    const output = [
      { role: "user", content: "retained user message", custom: "keep" },
      { type: "compaction", id: "cmp_2", encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "tail" }] },
      { type: "future_native_item", future: true },
    ];
    const payload = { output, usage: { input_tokens: 100, output_tokens: 10 }, id: "compact_1" };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://codex.example/backend/responses/compact?test=1");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-access");
      expect(headers["chatgpt-account-id"]).toBe("test-account");
      expect(headers.session_id).toBe("session-1");
      expect(headers["session-id"]).toBe("session-1");
      expect(headers["thread-id"]).toBe("session-1");
      expect(headers.Accept).toBe("application/json");
      expect(JSON.parse(init?.body as string)).toEqual({
        model: "gpt-6-luna",
        input: [{ role: "user", content: "hi" }],
        instructions: "Preserve state",
        tools: [],
        parallel_tool_calls: false,
        reasoning: { effort: "medium", summary: "detailed" },
        service_tier: "priority",
        prompt_cache_key: "cache-1",
        text: { verbosity: "medium" },
      });
      return Response.json(payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestChatGptCodexCompaction({
      transport: "unary",
      sessionId: "session-1",
      request: {
        model: "gpt-6-luna",
        input: [{ role: "user", content: "hi" }],
        instructions: "Preserve state",
        tools: [],
        parallel_tool_calls: false,
        reasoning: { effort: "medium", summary: "detailed" },
        service_tier: "priority",
        prompt_cache_key: "cache-1",
        text: { verbosity: "medium" },
        // Ordinary response fields must be omitted from the compact request.
        ...{
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          tool_choice: "auto",
        },
      },
    });
    expect(result).toEqual(payload);
    expect(chatGptAuthMock.getChatGptAuthProfile).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the configured proxy's compaction endpoint without reading subscription auth", async () => {
    configureChatGptCodexProxy({ url: "https://proxy.example/", apiKey: "proxy-key" });
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://proxy.example/api/codex/responses/compact");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer proxy-key");
      expect(headers["x-llm-proxy-auth"]).toBe("proxy-key");
      expect(headers["chatgpt-account-id"]).toBeUndefined();
      return Response.json({ output: [{ type: "compaction", encrypted_content: "proxy-opaque" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestChatGptCodexCompaction({
      transport: "unary",
      request: { model: "gpt-6-luna", input: [{ role: "user", content: "hi" }] },
    });
    expect(result.output).toEqual([{ type: "compaction", encrypted_content: "proxy-opaque" }]);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it("fetches Codex model metadata with current subscription authentication", async () => {
    process.env.CHATGPT_CODEX_ENDPOINT = "https://codex.example/backend/responses?workspace=one";
    const models = [{ slug: "gpt-6-luna", context_window: 128_000, max_context_window: 256_000 }];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://codex.example/backend/models?workspace=one&client_version=0.144.0",
      );
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access");
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("test-account");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeDefined();
      return Response.json({ models });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchChatGptCodexModels()).resolves.toEqual(models);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors the configured proxy for model discovery and fails explicitly if metadata is unavailable", async () => {
    configureChatGptCodexProxy({
      url: "https://proxy.example/api/app/responses",
      apiKey: "llmc_app",
    });
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://proxy.example/api/app/models?client_version=0.144.0");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer llmc_app");
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchChatGptCodexModels()).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("compaction.contextWindowTokens"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it("rejects malformed Codex model metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ models: "invalid" })),
    );
    await expect(fetchChatGptCodexModels()).rejects.toThrow("did not include a models array");
  });

  it.each([
    {},
    { output: null },
    { output: [] },
    { output: [null] },
    { output: [{ type: "compaction", encrypted_content: "" }] },
    { output: [{ type: "message", role: "user", content: "not compacted" }] },
    { output: [{ type: "compaction", encrypted_content: "opaque" }, "invalid"] },
  ])("rejects malformed compaction windows without replacing history: %j", async (payload) => {
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestChatGptCodexCompaction({
        transport: "unary",
        request: { model: "gpt-6-luna", input: [{ role: "user", content: "hi" }] },
      }),
    ).rejects.toThrow("ChatGPT Codex compaction response did not include");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates compaction authorization failures without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestChatGptCodexCompaction({
        transport: "unary",
        request: { model: "gpt-6-luna", input: [] },
      }),
    ).rejects.toThrow("ChatGPT Codex compaction request failed (401): denied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient compaction HTTP failure and propagates the abort signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 502 }))
      .mockResolvedValueOnce(
        Response.json({ output: [{ type: "compaction", encrypted_content: "retried-opaque" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestChatGptCodexCompaction({
        transport: "unary",
        request: { model: "gpt-6-luna", input: [] },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ output: [{ type: "compaction", encrypted_content: "retried-opaque" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("uses explicit runtime Codex proxy configuration without process env", async () => {
    configureChatGptCodexProxy({
      url: "https://runtime-proxy.example/",
      apiKey: "runtime-proxy-key",
    });

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://runtime-proxy.example/api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer runtime-proxy-key");
      expect(headers["x-llm-proxy-auth"]).toBe("runtime-proxy-key");
      expect(headers["chatgpt-account-id"]).toBeUndefined();

      return buildSseResponse([
        {
          type: "response.output_text.delta",
          delta: "runtime-proxied",
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });

    expect(result.text).toBe("runtime-proxied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it("uses the Vercel Codex proxy without reading ChatGPT auth", async () => {
    process.env.LLM_PROXY_URL = "https://codex-proxy.example/api/codex/responses";
    process.env.LLM_PROXY_API_KEY = "proxy-key";

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://codex-proxy.example/api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer proxy-key");
      expect(headers["x-llm-proxy-auth"]).toBe("proxy-key");
      expect(headers["chatgpt-account-id"]).toBeUndefined();

      return buildSseResponse([
        {
          type: "response.output_text.delta",
          delta: "proxied",
        },
        {
          type: "response.completed",
          response: {
            model: "gpt-6-luna",
            service_tier: "priority",
            status: "completed",
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });

    expect(result.text).toBe("proxied");
    expect(result.serviceTier).toBe("priority");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it("accepts a root LLM_PROXY_URL", async () => {
    process.env.LLM_PROXY_URL = "https://codex-proxy.example/";
    process.env.LLM_PROXY_API_KEY = "proxy-key";

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://codex-proxy.example/api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer proxy-key");
      expect(headers["x-llm-proxy-auth"]).toBe("proxy-key");
      expect(headers["chatgpt-account-id"]).toBeUndefined();

      return buildSseResponse([
        {
          type: "response.output_text.delta",
          delta: "root-proxied",
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });

    expect(result.text).toBe("root-proxied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it("uses CHATGPT_CODEX_ENDPOINT for direct ChatGPT Codex requests", async () => {
    process.env.CHATGPT_CODEX_ENDPOINT = "https://direct.example/backend-api/codex/responses";

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://direct.example/backend-api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-access");
      expect(headers["chatgpt-account-id"]).toBe("test-account");
      expect(headers.originator).toBe("codex_cli_rs");
      expect(headers["User-Agent"]).toMatch(/^codex_cli_rs\/\S+ @ljoukov\/llm/u);
      return buildSseResponse([
        {
          type: "response.output_text.delta",
          delta: "direct",
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });

    expect(result.text).toBe("direct");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatGptAuthMock.getChatGptAuthProfile).toHaveBeenCalledTimes(1);
  });

  it("retries without reasoning.summary when ChatGPT rejects it", async () => {
    const requestBodies: any[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'reasoning.summary' is not supported with the 'gpt-6-luna' model.",
              type: "invalid_request_error",
              param: "reasoning.summary",
              code: "unsupported_parameter",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return buildSseResponse([
        {
          type: "response.output_text.delta",
          delta: "OK",
        },
        {
          type: "response.completed",
          response: {
            model: "gpt-6-luna",
            status: "completed",
            usage: {
              input_tokens: 2,
              output_tokens: 1,
              total_tokens: 3,
            },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-luna",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
        reasoning: { effort: "low", summary: "detailed" },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]?.reasoning?.summary).toBe("detailed");
    expect(requestBodies[1]?.reasoning?.summary).toBeUndefined();
    expect(requestBodies[1]?.reasoning?.effort).toBe("low");
    expect(result.text).toBe("OK");
    expect(result.model).toBe("gpt-6-luna");
  });

  it("collects completed image_generation_call results", async () => {
    const fetchMock = vi.fn(async () =>
      buildSseResponse([
        {
          type: "response.output_item.done",
          item: {
            id: "ig_123",
            type: "image_generation_call",
            status: "completed",
            revised_prompt: "A small blue square",
            result: Buffer.from("fake-image").toString("base64"),
          },
        },
        {
          type: "response.completed",
          response: {
            model: "gpt-6-sol",
            status: "completed",
            usage: {
              input_tokens: 2,
              output_tokens: 10,
              total_tokens: 12,
            },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-6-sol",
        store: false,
        stream: true,
        input: [{ role: "user", content: "draw a blue square" }],
        tools: [{ type: "image_generation", output_format: "png" }],
        tool_choice: "required",
      },
    });

    expect(result.imageGenerationCalls).toEqual([
      {
        id: "ig_123",
        status: "completed",
        revisedPrompt: "A small blue square",
        result: Buffer.from("fake-image").toString("base64"),
      },
    ]);
  });
});
