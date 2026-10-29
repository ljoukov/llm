import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { streamFireworksChatCompletion } from "../src/fireworks/stream.js";
import { extractVercelServingMetadata } from "../src/vercel/speed.js";

function mockClient(chunks: unknown[]) {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            yield* chunks;
          },
        })),
      },
    },
  } as unknown as OpenAI;
}

describe("Vercel AI Gateway SSE accumulation", () => {
  it("preserves the actually served tier across streaming metadata updates", async () => {
    const client = mockClient([
      {
        model: "openai/gpt-6.1-sol",
        service_tier: "priority",
        choices: [{ index: 0, delta: { content: "OK" } }],
      },
      {
        service_tier: "default",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);
    const response = await streamFireworksChatCompletion(
      client,
      { model: "openai/gpt-6.1-sol" },
      { provider: "vercel" },
    );
    expect(response.service_tier).toBe("default");
    expect(extractVercelServingMetadata(response)).toEqual({
      effectiveSpeed: "standard",
      serviceTier: "default",
    });
  });

  it("preserves unified reasoning, provider charges, and fragmented tool calls", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, cost: 0.000012 };
    const client = mockClient([
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning: "Let me ",
              reasoning_content: "Let me ",
              tool_calls: [{ index: 0, id: "call_1", function: { name: "sum", arguments: "{" } }],
              provider_metadata: { gateway: { generationId: "gen_test", routing: { tries: 1 } } },
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning: "calculate.",
              tool_calls: [{ index: 0, function: { arguments: '"a":2}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        model: "deepseek/deepseek-v4.1-flash-1017",
        choices: [],
        usage,
        provider_metadata: {
          gateway: { cost: "0.000012", routing: { finalProvider: "deepseek" } },
        },
      },
    ]);
    const onDelta = vi.fn();
    const result = await streamFireworksChatCompletion(
      client,
      { model: "deepseek/deepseek-v4.1-flash-1017" },
      { provider: "vercel", onDelta },
    );
    expect(onDelta.mock.calls).toEqual([
      ["thought", "Let me "],
      ["thought", "calculate."],
    ]);
    expect(result.usage).toEqual(usage);
    expect(result.provider_metadata).toEqual({
      gateway: {
        generationId: "gen_test",
        cost: "0.000012",
        routing: { tries: 1, finalProvider: "deepseek" },
      },
    });
    expect(result.choices[0]?.message).toMatchObject({
      reasoning: "Let me calculate.",
      tool_calls: [{ id: "call_1", function: { name: "sum", arguments: '{"a":2}' } }],
      provider_metadata: result.provider_metadata,
    });
  });

  it("assembles reasoning details and signatures for replay across tool steps", async () => {
    const client = mockClient([
      {
        choices: [
          {
            delta: {
              reasoning: "Think ",
              reasoning_details: [
                { type: "reasoning.text", index: 0, text: "Think ", format: "anthropic-claude-v1" },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning: "carefully.",
              reasoning_details: [
                { type: "reasoning.text", index: 0, text: "carefully.", signature: "sig-" },
                { type: "reasoning.summary", index: 1, summary: "Summary", format: "unknown" },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: "42",
              reasoning_details: [
                { type: "reasoning.text", index: 0, signature: "end" },
                { type: "reasoning.encrypted", index: 2, data: "encrypted" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);
    const result = await streamFireworksChatCompletion(client, {}, { provider: "vercel" });
    expect(result.choices[0]?.message.reasoning_details).toEqual([
      {
        type: "reasoning.text",
        index: 0,
        text: "Think carefully.",
        format: "anthropic-claude-v1",
        signature: "sig-end",
      },
      { type: "reasoning.summary", index: 1, summary: "Summary", format: "unknown" },
      { type: "reasoning.encrypted", index: 2, data: "encrypted" },
    ]);
  });

  it("names the gateway when a stream ends without completing a choice", async () => {
    await expect(
      streamFireworksChatCompletion(mockClient([]), {}, { provider: "vercel" }),
    ).rejects.toThrow(
      "Vercel AI Gateway stream ended before the first choice supplied a finish reason.",
    );
  });
});
