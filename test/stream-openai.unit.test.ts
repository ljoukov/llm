import { describe, expect, it, vi } from "vitest";

vi.mock("../src/openai/calls.js", () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.output_text.delta", delta: "Hello" };
      yield { type: "response.reasoning_summary_text.delta", delta: "Thinking" };
    },
    async finalResponse() {
      return {
        id: "resp_123",
        model: "gpt-5.2",
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 16,
        },
      };
    },
  };

  const fakeClient = {
    responses: {
      stream: () => fakeStream,
    },
  };

  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("streamText (OpenAI)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gpt-5.2", prompt: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("openai");
    expect(result.text).toBe("Hello");
    expect(result.thoughts).toBe("Thinking");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});
