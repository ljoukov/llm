import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnthropicClient, type AnthropicMessageRequest } from "../src/anthropic/client.js";
import {
  isAnthropicCompactionSupported,
  sumAnthropicUsageIterations,
} from "../src/anthropic/compaction.js";
import { ANTHROPIC_MODEL_IDS } from "../src/anthropic/models.js";

const signedBlock = {
  type: "compaction" as const,
  content: "The user is designing a recipe app. Preserve RecipeIngredient and its quantity field.",
  signature: "provider-signed-content",
};

const baseRequest: AnthropicMessageRequest = {
  model: "claude-sonnet-5-5",
  max_tokens: 4096,
  system: "Help design a recipe app.",
  messages: [{ role: "user", content: "Store recipes and ingredients." }],
  tools: [{ name: "inspect", input_schema: { type: "object", properties: {} } }],
  thinking: { type: "adaptive" },
  speed: "fast",
};

function event(type: string, value: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function compactionStream(block: Record<string, unknown> = signedBlock): Response {
  const data = [
    event("message_start", {
      message: {
        id: "msg_compact",
        type: "message",
        role: "assistant",
        model: baseRequest.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    event("ping"),
    event("content_block_start", { index: 0, content_block: block }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: "compaction" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }],
      },
    }),
    event("message_stop"),
  ].join("");
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}

describe("Anthropic on-demand server compaction", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-compaction-unit-secret");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the native beta and keeps the model, instructions, tools and thinking configuration", async () => {
    const fetchMock = vi.fn(async () => compactionStream());
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    const signal = new AbortController().signal;
    const request = {
      ...baseRequest,
      tool_choice: { type: "tool" as const, name: "inspect" },
      stop_sequences: ["STOP"],
      output_config: { effort: "high" as const, format: { type: "json_schema" } },
      compaction: { type: "summarize" as const, instructions: "Preserve exact entity names." },
    };
    const original = structuredClone(request);

    const result = await new AnthropicClient().compactMessage(request, { signal, onDelta });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.signal).toBe(signal);
    expect(init.headers).toMatchObject({ "anthropic-beta": "compact-2026-09-04" });
    expect(JSON.parse(String(init.body))).toEqual({
      ...baseRequest,
      output_config: { effort: "high" },
      compaction: request.compaction,
      stream: true,
    });
    expect(result.content).toEqual([signedBlock]);
    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }],
    });
    expect(request).toEqual(original);
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("automatically sends the beta on continuation and preserves the complete signed block", async () => {
    const returnedBlock = { ...signedBlock, provider_extension: { preserve: true } };
    const fetchMock = vi.fn(async () => compactionStream(returnedBlock));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AnthropicClient();
    const result = await client.compactMessage(baseRequest);
    const messages: AnthropicMessageRequest["messages"] = [
      { role: "assistant", content: result.content },
      { role: "user", content: "Now add tags." },
    ];

    await client.streamMessage({ ...baseRequest, messages });

    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ "anthropic-beta": "compact-2026-09-04" });
    const body = JSON.parse(String(init.body));
    expect(body.compaction).toBeUndefined();
    expect(body.messages).toEqual(messages);
    expect(body.messages[0].content).toEqual([returnedBlock]);
  });

  it.each([
    { ...signedBlock, content: null },
    { ...signedBlock, content: "" },
    { ...signedBlock, signature: "" },
    { type: "text", text: "A normal reply is not a compaction result." },
  ])("rejects a missing or invalid signed block without replacing caller history", async (block) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => compactionStream(block)),
    );
    const original = structuredClone(baseRequest);

    await expect(new AnthropicClient().compactMessage(baseRequest)).rejects.toThrow(
      "no signed compaction summary",
    );
    expect(baseRequest).toEqual(original);
  });

  it("uses iteration totals without double counting the mirrored generation counters", () => {
    const usage = {
      input_tokens: 200,
      output_tokens: 20,
      cache_read_input_tokens: 15,
      cache_creation_input_tokens: 2,
      speed: "fast" as const,
      iterations: [
        {
          type: "compaction",
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 3 },
        },
        {
          type: "message",
          input_tokens: 200,
          output_tokens: 20,
          cache_read_input_tokens: 15,
          cache_creation_input_tokens: 2,
          cache_creation: { ephemeral_1h_input_tokens: 2 },
        },
      ],
    };

    expect(sumAnthropicUsageIterations(usage)).toEqual({
      ...usage,
      input_tokens: 300,
      output_tokens: 30,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
    });
    const ordinary = { input_tokens: 12, output_tokens: 3 };
    expect(sumAnthropicUsageIterations(ordinary)).toBe(ordinary);
  });

  it("selects only the documented direct Anthropic models", () => {
    expect(ANTHROPIC_MODEL_IDS.every(isAnthropicCompactionSupported)).toBe(true);
    expect(isAnthropicCompactionSupported("unknown-model")).toBe(false);
  });

  it("retrieves native model context limits using the shared auth and abort signal", async () => {
    const model = { id: baseRequest.model, max_input_tokens: 200_000, max_tokens: 64_000 };
    const fetchMock = vi.fn(async () => Response.json(model));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(new AnthropicClient().getModel(baseRequest.model, { signal })).resolves.toEqual(
      model,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.anthropic.com/v1/models/${baseRequest.model}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "anthropic-compaction-unit-secret",
        },
        signal,
      },
    );
  });

  it("redacts credentials in model metadata errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message:
                "Invalid credential anthropic-compaction-unit-secret or sk-ant-exposed-value",
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(new AnthropicClient().getModel("unrecognized/model")).rejects.toThrow(
      "Anthropic model request failed (HTTP 400): Invalid credential [redacted] or [redacted]",
    );
  });
});
