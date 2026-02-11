import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

let capturedRequest: any = null;
let capturedRequests: any[] = [];
let callCount = 0;
let failFirstStructuredAttempt = false;

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      callCount += 1;
      capturedRequest = options.request;
      capturedRequests.push(options.request);
      if (failFirstStructuredAttempt && callCount === 1) {
        throw new Error("Unsupported text.format=json_schema");
      }
      options.onDelta?.({ thoughtDelta: "Thinking" });
      options.onDelta?.({ textDelta: '{"ok":true,"message":"hello"}' });
      return {
        text: '{"ok":true,"message":"hello"}',
        reasoningText: "",
        reasoningSummaryText: "Thinking",
        toolCalls: [],
        webSearchCalls: [],
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 16,
        },
        model: "gpt-5.1-codex-mini",
        status: "completed",
        blocked: false,
      };
    },
  };
});

describe("generateJson (ChatGPT)", () => {
  it("passes json_schema text.format when using chatgpt-* models", async () => {
    const { generateJson } = await import("../src/llm.js");

    callCount = 0;
    capturedRequests = [];
    failFirstStructuredAttempt = false;
    const schema = z.object({ ok: z.boolean(), message: z.string() });
    let streamedThoughts = "";
    const { value } = await generateJson({
      model: "chatgpt-gpt-5.1-codex-mini",
      input: "Return JSON",
      schema,
      onEvent: (event) => {
        if (event.type === "delta" && event.channel === "thought") {
          streamedThoughts += event.text;
        }
      },
    });

    expect(value).toEqual({ ok: true, message: "hello" });
    expect(streamedThoughts).toContain("Thinking");
    expect(capturedRequest?.text?.format?.type).toBe("json_schema");
  });

  it("retries without json_schema when ChatGPT rejects structured format", async () => {
    const { generateJson } = await import("../src/llm.js");

    callCount = 0;
    capturedRequests = [];
    failFirstStructuredAttempt = true;
    const schema = z.object({ ok: z.boolean(), message: z.string() });

    const { value } = await generateJson({
      model: "chatgpt-gpt-5.1-codex-mini",
      input: "Return JSON",
      schema,
      maxAttempts: 2,
    });

    expect(value).toEqual({ ok: true, message: "hello" });
    expect(callCount).toBe(2);
    expect(capturedRequests[0]?.text?.format?.type).toBe("json_schema");
    expect(capturedRequest?.text?.format?.type).toBe("text");
  });
});
