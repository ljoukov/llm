import { describe, expect, it, vi } from "vitest";

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      options.onDelta?.({ thoughtDelta: "Thinking" });
      options.onDelta?.({ textDelta: "Hello" });
      return {
        text: "Hello",
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

describe("streamText (ChatGPT)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "chatgpt-gpt-5.1-codex-mini", prompt: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("chatgpt");
    expect(result.text).toBe("Hello");
    expect(result.thoughts).toBe("Thinking");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});
