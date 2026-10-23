import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let responseText = "Hello";
let stopReason = "end_turn";

vi.mock("../src/anthropic/calls.js", () => ({
  runAnthropicCall: async (fn: (client: any) => Promise<unknown>) =>
    fn({
      streamMessage: async (request: any, options: any) => {
        requests.push(structuredClone(request));
        options.onDelta?.("thought", "A short summary.");
        options.onDelta?.("response", responseText.slice(0, 2));
        options.onDelta?.("response", responseText.slice(2));
        return {
          model: request.model,
          stop_reason: stopReason,
          content: [
            { type: "thinking", thinking: "A short summary.", signature: "signed" },
            { type: "text", text: responseText },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 6,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 5,
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
          },
        };
      },
    }),
}));

describe("Anthropic text and JSON streams", () => {
  beforeEach(() => {
    requests = [];
    responseText = "Hello";
    stopReason = "end_turn";
  });

  it.each([
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
  ] as const)("streams %s with usage and cost", async (model) => {
    const { streamText } = await import("../src/llm.js");
    const call = streamText({
      provider: "anthropic",
      model,
      input: "Hi",
      instructions: "System",
      thinkingLevel: "ultra",
    });
    const events = [];
    for await (const event of call.events) events.push(event);
    const result = await call.result;
    expect(result.provider).toBe("anthropic");
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
    expect(result.costUsd).toBeGreaterThan(0);
    expect(
      events.filter((event) => event.type === "delta" && event.channel === "response"),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(requests[0]).toMatchObject({
      model: model,
      max_tokens: 32_000,
      system: "System",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
  });

  it("uses native JSON schema output while retaining runtime validation", async () => {
    responseText = '{"count":4}';
    const { generateJson } = await import("../src/llm.js");
    const result = await generateJson({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      input: "Return count",
      schema: z.object({ count: z.number().min(3) }),
    });
    expect(result.value).toEqual({ count: 4 });
    expect(requests[0].output_config.format).toMatchObject({
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { count: { type: "number", description: "minimum: 3" } },
      },
    });
    expect(requests[0].output_config.format.schema.properties.count).not.toHaveProperty("minimum");
  });

  it("enforces original JSON constraints after schema normalization", async () => {
    responseText = '{"count":1}';
    const { generateJson } = await import("../src/llm.js");
    await expect(
      generateJson({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        input: "Return count",
        schema: z.object({ count: z.number().min(3) }),
        maxAttempts: 1,
      }),
    ).rejects.toThrow("LLM JSON call failed after 1 attempt(s)");
  });

  it("maps system/developer instructions and native image/PDF inputs", async () => {
    const { generateText } = await import("../src/llm.js");
    await generateText({
      provider: "anthropic",
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

  it("reports Anthropic refusals as blocked", async () => {
    stopReason = "refusal";
    const { generateText } = await import("../src/llm.js");
    expect(
      (await generateText({ provider: "anthropic", model: "claude-opus-5-5", input: "Hi" }))
        .blocked,
    ).toBe(true);
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
  ])("rejects unsupported Anthropic features before inference: %j", async (override) => {
    const { generateText } = await import("../src/llm.js");
    await expect(
      generateText({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        input: "Hi",
        ...override,
      } as any),
    ).rejects.toThrow("Anthropic");
    expect(requests).toHaveLength(0);
  });
});
