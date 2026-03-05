import { describe, expect, it, vi } from "vitest";

let geminiRequests: any[] = [];

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
      generateContentStream: async (request: any) => {
        geminiRequests.push(request);
        return stream();
      },
    },
  };

  return {
    runGeminiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("streamText (Gemini)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    geminiRequests = [];
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
    expect(geminiRequests[0]?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 32_768,
    });
  });

  it("maps thinkingLevel=low to gemini-2.5-pro thinkingBudget=256", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gemini-2.5-pro", input: "hi", thinkingLevel: "low" });
    for await (const _event of call.events) {
      // Drain stream to completion.
    }
    await call.result;

    expect(geminiRequests[0]?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 256,
    });
  });

  it("maps thinkingLevel=medium to gemini-3.1-pro-preview thinkingLevel=MEDIUM", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({
      model: "gemini-3.1-pro-preview",
      input: "hi",
      thinkingLevel: "medium",
    });
    for await (const _event of call.events) {
      // Drain stream to completion.
    }
    await call.result;

    expect(geminiRequests[0]?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });

  it("does not send thinkingConfig for Gemini image models", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({
      model: "gemini-3.1-flash-image-preview",
      input: "Generate an image",
      responseModalities: ["IMAGE", "TEXT"],
    });

    for await (const _event of call.events) {
      // Drain stream to completion.
    }
    const result = await call.result;

    expect(result.provider).toBe("gemini");
    expect(geminiRequests[0]?.model).toBe("gemini-3.1-flash-image-preview");
    expect(geminiRequests[0]?.config?.thinkingConfig).toBeUndefined();
  });
});
