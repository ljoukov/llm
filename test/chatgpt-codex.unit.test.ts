import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/openai/chatgpt-auth.js", () => {
  return {
    getChatGptAuthProfile: async () => ({
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
      accountId: "test-account",
    }),
  };
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

  beforeEach(() => {
    process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE = "off";
  });

  afterEach(() => {
    if (originalChatGptWebSocketMode === undefined) {
      delete process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE;
    } else {
      process.env.CHATGPT_RESPONSES_WEBSOCKET_MODE = originalChatGptWebSocketMode;
    }
    vi.unstubAllGlobals();
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
});
