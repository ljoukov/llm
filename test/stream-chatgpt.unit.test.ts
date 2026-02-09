import { describe, expect, it, vi } from "vitest";

let capturedRequest: any = null;

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      capturedRequest = options.request;
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

  it("maps inlineData application/pdf to input_file", async () => {
    capturedRequest = null;
    const { generateText } = await import("../src/llm.js");

    const pdfB64 = Buffer.from("%PDF-1.4\\nhello").toString("base64");
    await generateText({
      model: "chatgpt-gpt-5.1-codex-mini",
      contents: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Summarize the PDF." },
            { type: "inlineData", mimeType: "application/pdf", data: pdfB64 },
          ],
        },
      ],
    });

    const input = capturedRequest?.input;
    expect(Array.isArray(input)).toBe(true);
    expect(input[0]?.role).toBe("user");
    expect(Array.isArray(input[0]?.content)).toBe(true);
    const filePart = input[0].content.find((p: any) => p?.type === "input_file");
    expect(filePart).toBeTruthy();
    expect(filePart.file_data).toBe(pdfB64);
    expect(filePart.filename).toBe("document.pdf");
  });
});
