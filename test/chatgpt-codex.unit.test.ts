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

import { collectChatGptCodexResponse } from "../src/openai/chatgpt-codex.js";

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
  const originalChatGptCodexProxyUrl = process.env.CHATGPT_CODEX_PROXY_URL;
  const originalChatGptCodexProxyApiKey = process.env.CHATGPT_CODEX_PROXY_API_KEY;

  beforeEach(() => {
    process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE = "off";
    delete process.env.CHATGPT_CODEX_ENDPOINT;
    delete process.env.CHATGPT_CODEX_PROXY_URL;
    delete process.env.CHATGPT_CODEX_PROXY_API_KEY;
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
      delete process.env.CHATGPT_CODEX_PROXY_URL;
    } else {
      process.env.CHATGPT_CODEX_PROXY_URL = originalChatGptCodexProxyUrl;
    }
    if (originalChatGptCodexProxyApiKey === undefined) {
      delete process.env.CHATGPT_CODEX_PROXY_API_KEY;
    } else {
      process.env.CHATGPT_CODEX_PROXY_API_KEY = originalChatGptCodexProxyApiKey;
    }
    vi.unstubAllGlobals();
  });

  it("uses the Vercel Codex proxy without reading ChatGPT auth", async () => {
    process.env.CHATGPT_CODEX_PROXY_URL = "https://codex-proxy.example/api/codex/responses";
    process.env.CHATGPT_CODEX_PROXY_API_KEY = "proxy-key";

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://codex-proxy.example/api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer proxy-key");
      expect(headers["x-codex-proxy-auth"]).toBe("proxy-key");
      expect(headers["chatgpt-account-id"]).toBeUndefined();

      return buildSseResponse([
        {
          type: "response.output_text.delta",
          delta: "proxied",
        },
        {
          type: "response.completed",
          response: {
            model: "gpt-5.3-codex-spark",
            status: "completed",
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectChatGptCodexResponse({
      request: {
        model: "gpt-5.3-codex-spark",
        store: false,
        stream: true,
        input: [{ role: "user", content: "hi" }],
      },
    });

    expect(result.text).toBe("proxied");
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
        model: "gpt-5.3-codex-spark",
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
                "Unsupported parameter: 'reasoning.summary' is not supported with the 'gpt-5.3-codex-spark' model.",
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
            model: "gpt-5.3-codex-spark",
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
        model: "gpt-5.3-codex-spark",
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
    expect(result.model).toBe("gpt-5.3-codex-spark");
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
            model: "gpt-5.4",
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
        model: "gpt-5.4",
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
