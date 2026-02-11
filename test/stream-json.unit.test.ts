import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let capturedRequest: any = null;
let streamedEvents: any[] = [];
let finalResponse: any = null;

vi.mock("../src/openai/calls.js", () => {
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      for (const event of streamedEvents) {
        yield event;
      }
    },
    async finalResponse() {
      return finalResponse;
    },
  };

  const fakeClient = {
    responses: {
      stream: (request: any) => {
        capturedRequest = request;
        return fakeStream;
      },
    },
  };

  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("streamJson", () => {
  beforeEach(() => {
    capturedRequest = null;
    streamedEvents = [
      { type: "response.output_text.delta", delta: '{"ok":true,"message":"hel' },
      { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
      { type: "response.output_text.delta", delta: 'lo"}' },
    ];
    finalResponse = {
      id: "resp_123",
      model: "gpt-5.2",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 30,
      },
    };
  });

  it("emits partial JSON snapshots while streaming and returns the final validated value", async () => {
    const { streamJson } = await import("../src/llm.js");

    const schema = z.object({ ok: z.boolean(), message: z.string() });
    const call = streamJson({ model: "gpt-5.2", input: "hi", schema });

    const partials: any[] = [];
    let finalFromEvents: any = null;
    let thoughts = "";

    for await (const ev of call.events) {
      if (ev.type === "delta" && ev.channel === "thought") {
        thoughts += ev.text;
      }
      if (ev.type === "json" && ev.stage === "partial") {
        partials.push(ev.value);
      }
      if (ev.type === "json" && ev.stage === "final") {
        finalFromEvents = ev.value;
      }
    }

    const { value } = await call.result;

    expect(thoughts).toContain("Thinking");
    expect(partials).toEqual([
      { ok: true, message: "hel" },
      { ok: true, message: "hello" },
    ]);
    expect(finalFromEvents).toEqual({ ok: true, message: "hello" });
    expect(value).toEqual({ ok: true, message: "hello" });

    expect(capturedRequest?.text?.format?.type).toBe("json_schema");
  });

  it("emits structured partials for trailing commas and incomplete strings", async () => {
    const { streamJson } = await import("../src/llm.js");

    streamedEvents = [
      { type: "response.output_text.delta", delta: '{"key1":"value1",' },
      { type: "response.output_text.delta", delta: '"key2":' },
      { type: "response.output_text.delta", delta: '"v' },
      { type: "response.output_text.delta", delta: 'alue2"}' },
    ];

    const schema = z.object({ key1: z.string(), key2: z.string() });
    const call = streamJson({ model: "gpt-5.2", input: "hi", schema });
    const partials: any[] = [];

    for await (const ev of call.events) {
      if (ev.type === "json" && ev.stage === "partial") {
        partials.push(ev.value);
      }
    }

    const { value } = await call.result;
    expect(partials).toEqual([
      { key1: "value1" },
      { key1: "value1", key2: "v" },
      { key1: "value1", key2: "value2" },
    ]);
    expect(value).toEqual({ key1: "value1", key2: "value2" });
  });

  it("handles preamble/fenced text and still produces JSON partials", async () => {
    const { streamJson } = await import("../src/llm.js");

    streamedEvents = [
      { type: "response.output_text.delta", delta: "Sure, here it is:\\n```json\\n" },
      { type: "response.output_text.delta", delta: '{"a":1' },
      { type: "response.output_text.delta", delta: "}\\n```" },
    ];

    const schema = z.object({ a: z.number() });
    const call = streamJson({ model: "gpt-5.2", input: "hi", schema });
    const partials: any[] = [];

    for await (const ev of call.events) {
      if (ev.type === "json" && ev.stage === "partial") {
        partials.push(ev.value);
      }
    }

    const { value } = await call.result;
    expect(partials).toEqual([{ a: 1 }]);
    expect(value).toEqual({ a: 1 });
  });

  it("supports streamMode=final to only emit final validated JSON", async () => {
    const { streamJson } = await import("../src/llm.js");

    const schema = z.object({ ok: z.boolean(), message: z.string() });
    const call = streamJson({ model: "gpt-5.2", input: "hi", schema, streamMode: "final" });

    let partialCount = 0;
    let sawFinal = false;
    for await (const ev of call.events) {
      if (ev.type === "json" && ev.stage === "partial") {
        partialCount += 1;
      }
      if (ev.type === "json" && ev.stage === "final") {
        sawFinal = true;
      }
    }

    const { value } = await call.result;
    expect(partialCount).toBe(0);
    expect(sawFinal).toBe(true);
    expect(value).toEqual({ ok: true, message: "hello" });
  });
});
