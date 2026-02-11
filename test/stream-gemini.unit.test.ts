import { describe, expect, it, vi } from "vitest";

vi.mock("../src/google/calls.js", () => {
  async function* stream() {
    yield {
      modelVersion: "gemini-2.5-pro",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 6,
        thoughtsTokenCount: 2,
        totalTokenCount: 16,
      },
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello " }, { text: "Thinking", thought: true }, { text: "world" }],
          },
        },
      ],
    };
  }

  const fakeClient = {
    models: {
      generateContentStream: async () => stream(),
    },
  };

  return {
    runGeminiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("streamText (Gemini)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gemini-2.5-pro", input: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("gemini");
    expect(result.text).toBe("Hello world");
    expect(result.thoughts).toBe("Thinking");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});
