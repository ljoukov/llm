import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let responseText = "Hello";
let finishReason = "end_turn";
let waitForAbort = false;

vi.mock("../src/claude/calls.js", () => ({
  runClaudeQuery: async (request: any) => {
    requests.push(request);
    if (waitForAbort) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("Claude request aborted"));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    request.onDelta?.("thought", "A short summary.");
    request.onDelta?.("response", responseText.slice(0, 2));
    request.onDelta?.("response", responseText.slice(2));
    return {
      model: request.model,
      text: responseText,
      thoughts: "A short summary.",
      finishReason,
      usage: {
        input_tokens: 10,
        output_tokens: 6,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
      },
      ...(request.jsonSchema ? { structuredOutput: JSON.parse(responseText) } : {}),
    };
  },
}));

describe("Claude subscription text and JSON streams", () => {
  beforeEach(() => {
    requests = [];
    responseText = "Hello";
    finishReason = "end_turn";
    waitForAbort = false;
  });

  it.each([
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
  ] as const)("routes %s through Claude Code with stream deltas and usage", async (model) => {
    const { streamText } = await import("../src/llm.js");
    const call = streamText({
      provider: "anthropic",
      access: "subscription",
      model,
      input: "Hi",
      instructions: "System",
      thinkingLevel: "ultra",
    });
    const events = [];
    for await (const event of call.events) events.push(event);
    const result = await call.result;
    expect(result.provider).toBe("anthropic");
    expect(result.access).toBe("subscription");
    expect(result.costUsd).toBeNull();
    expect(result.costSource).toBe("subscription");
    expect(result.model).toBe(model);
    expect(result.modelVersion).toBe(model);
    expect(result.text).toBe("Hello");
    expect(result.thoughts).toBe("A short summary.");
    expect(result.usage).toMatchObject({
      promptTokens: 19,
      responseTokens: 6,
      totalTokens: 25,
      cachedTokens: 4,
      cacheWriteTokens: 5,
      anthropicCacheCreation5mInputTokens: 2,
      anthropicCacheCreation1hInputTokens: 3,
    });
    expect(result.apiEquivalentCostUsd).toBeGreaterThan(0);
    expect(
      events.filter((event) => event.type === "delta" && event.channel === "response"),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(requests[0]).toMatchObject({ model, system: "System", effort: "max" });
    expect(requests[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
  });

  it("uses native structured output and validates the original Zod schema", async () => {
    responseText = '{"count":4}';
    const { generateJson } = await import("../src/llm.js");
    const result = await generateJson({
      provider: "anthropic",
      access: "subscription",
      model: "claude-sonnet-5-5",
      input: "Return count",
      schema: z.object({ count: z.number().min(3) }),
      maxAttempts: 1,
    });
    expect(result.value).toEqual({ count: 4 });
    expect(requests[0].jsonSchema).toMatchObject({
      type: "object",
      properties: { count: { type: "number" } },
      additionalProperties: false,
    });

    responseText = '{"count":1}';
    await expect(
      generateJson({
        provider: "anthropic",
        access: "subscription",
        model: "claude-sonnet-5-5",
        input: "Return count",
        schema: z.object({ count: z.number().min(3) }),
        maxAttempts: 1,
      }),
    ).rejects.toThrow("LLM JSON call failed after 1 attempt(s)");
  });

  it("maps developer instructions and native image/PDF inputs", async () => {
    const { generateText } = await import("../src/llm.js");
    await generateText({
      provider: "anthropic",
      access: "subscription",
      model: "claude-haiku-5-5",
      instructions: "Top level",
      responseMimeType: "application/json",
      input: [
        { role: "developer", content: "Developer guidance" },
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,AQID" },
            { type: "input_file", filename: "page.pdf", file_data: "AQID" },
          ],
        },
      ],
    });
    expect(requests[0].system).toContain("Top level\n\nDeveloper guidance");
    expect(requests[0].system).toContain("Return valid JSON only");
    expect(requests[0].messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AQID" } },
    ]);
  });

  it("reports refusals as blocked", async () => {
    finishReason = "refusal";
    const { generateText } = await import("../src/llm.js");
    expect(
      (
        await generateText({
          provider: "anthropic",
          access: "subscription",
          model: "claude-opus-5-5",
          input: "Hi",
        })
      ).blocked,
    ).toBe(true);
  });

  it("aborts an active subscription stream", async () => {
    waitForAbort = true;
    const { streamText } = await import("../src/llm.js");
    const call = streamText({
      provider: "anthropic",
      access: "subscription",
      model: "claude-haiku-5-5",
      input: "Hi",
    });
    const result = expect(call.result).rejects.toThrow("aborted");
    const events = expect(
      (async () => {
        for await (const _event of call.events) {
          // Consume the stream so its matching failure is observed.
        }
      })(),
    ).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    call.abort();
    await Promise.all([result, events]);
    expect(requests[0].signal.aborted).toBe(true);
  });

  it.each([
    { tools: [{ type: "web-search" }] },
    { imageSize: "2K" },
    { responseModalities: ["IMAGE"] },
    { mediaResolution: "high" },
    {
      input: [
        { role: "user", content: [{ type: "inlineData", mimeType: "audio/wav", data: "AQID" }] },
      ],
    },
  ])("rejects unsupported subscription features before inference: %j", async (override) => {
    const { generateText } = await import("../src/llm.js");
    await expect(
      generateText({
        provider: "anthropic",
        access: "subscription",
        model: "claude-haiku-5-5",
        input: "Hi",
        ...override,
      } as any),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
