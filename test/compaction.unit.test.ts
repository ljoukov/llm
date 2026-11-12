import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPACTION_PROMPT,
  assertCompleteCompactionHistory,
  compactionTranscript,
  estimateCompactionTokens,
  resolveCompactionOptions,
  splitCompactionHistory,
} from "../src/compaction.js";

describe("compaction configuration", () => {
  it("is disabled until explicitly configured and resolves useful summary defaults", () => {
    expect(resolveCompactionOptions(undefined)).toBeUndefined();
    expect(resolveCompactionOptions(false)).toBeUndefined();
    expect(resolveCompactionOptions({ thresholdTokens: 80_000 })).toEqual({
      mode: "auto",
      thresholdTokens: 80_000,
      contextWindowTokens: undefined,
      thresholdRatio: 0.8,
      reserveOutputTokens: undefined,
      prompt: DEFAULT_COMPACTION_PROMPT,
      maxSummaryTokens: 4096,
      preserveRecentMessages: 4,
    });
    expect(
      resolveCompactionOptions({
        thresholdTokens: 500,
        mode: "summary",
        prompt: "Keep tasks",
        maxSummaryTokens: 123,
        preserveRecentMessages: 0,
      }),
    ).toEqual({
      mode: "summary",
      thresholdTokens: 500,
      contextWindowTokens: undefined,
      thresholdRatio: 0.8,
      reserveOutputTokens: undefined,
      prompt: "Keep tasks",
      maxSummaryTokens: 123,
      preserveRecentMessages: 0,
    });
    expect(resolveCompactionOptions({})?.thresholdTokens).toBeUndefined();
    expect(
      resolveCompactionOptions({
        contextWindowTokens: 200_000,
        thresholdRatio: 0.9,
        reserveOutputTokens: 8_000,
      }),
    ).toMatchObject({
      contextWindowTokens: 200_000,
      thresholdRatio: 0.9,
      reserveOutputTokens: 8_000,
    });
  });

  it.each([
    { thresholdTokens: 0 },
    { thresholdTokens: -1 },
    { thresholdTokens: 1.5 },
    { thresholdTokens: Number.NaN },
    { thresholdTokens: Number.MAX_SAFE_INTEGER + 1 },
    { thresholdTokens: "10" },
    { thresholdTokens: null },
    { thresholdTokens: 10, mode: "unknown" },
    { mode: null },
    { thresholdTokens: 10, maxSummaryTokens: 0 },
    { thresholdTokens: 10, maxSummaryTokens: Number.POSITIVE_INFINITY },
    { maxSummaryTokens: null },
    { maxSummaryTokens: "4096" },
    { thresholdTokens: 10, preserveRecentMessages: -1 },
    { thresholdTokens: 10, preserveRecentMessages: 0.5 },
    { preserveRecentMessages: null },
    { thresholdTokens: 10, prompt: "  " },
    { prompt: null },
    { contextWindowTokens: 0 },
    { contextWindowTokens: 1.5 },
    { contextWindowTokens: Number.POSITIVE_INFINITY },
    { reserveOutputTokens: 0 },
    { reserveOutputTokens: -1 },
    { reserveOutputTokens: 1.5 },
    { thresholdRatio: 0 },
    { thresholdRatio: 1 },
    { thresholdRatio: -0.1 },
    { thresholdRatio: Number.NaN },
    { thresholdRatio: "0.8" },
    { thresholdRatio: null },
    [],
    true,
    null,
  ])("rejects invalid settings before generation: %j", (value) => {
    expect(() => resolveCompactionOptions(value as never)).toThrow(/compaction/);
  });
});

describe("completed tool boundary validation", () => {
  it.each([
    [
      { type: "function_call", call_id: "a" },
      { type: "function_call_output", call_id: "a", output: "done" },
    ],
    [
      { type: "custom_tool_call", call_id: "a" },
      { type: "custom_tool_call_output", call_id: "a", output: "done" },
    ],
    [
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "b" },
      { role: "tool", tool_call_id: "a" },
    ],
    [
      { role: "assistant", content: [{ type: "tool_use", id: "a" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a" }] },
    ],
    [
      {
        role: "model",
        parts: [{ functionCall: { name: "lookup" } }, { functionCall: { name: "lookup" } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "lookup", response: {} } },
          { functionResponse: { name: "lookup", response: {} } },
        ],
      },
    ],
  ])("accepts completed tool interactions from every supported history shape", (...history) => {
    expect(() => assertCompleteCompactionHistory(history)).not.toThrow();
  });

  it.each([
    [{ type: "function_call", call_id: "a" }],
    [{ type: "custom_tool_call", call_id: "a" }],
    [
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a" },
    ],
    [{ role: "assistant", content: [{ type: "tool_use", id: "a" }] }],
    [
      { role: "model", parts: [{ functionCall: { id: "a", name: "lookup" } }] },
      { role: "user", parts: [{ functionResponse: { id: "b", name: "lookup", response: {} } }] },
    ],
  ])("rejects unfinished or mismatched tool calls", (...history) => {
    expect(() => assertCompleteCompactionHistory(history)).toThrow(/unresolved tool calls/);
  });

  it("rejects orphan and duplicate tool results", () => {
    expect(() =>
      assertCompleteCompactionHistory([{ role: "tool", tool_call_id: "missing" }]),
    ).toThrow(/unmatched tool results/);
    expect(() =>
      assertCompleteCompactionHistory([
        { type: "function_call", call_id: "a" },
        { type: "function_call_output", call_id: "a" },
        { type: "function_call_output", call_id: "a" },
      ]),
    ).toThrow(/unmatched tool results/);
  });
});

describe("compaction transcript", () => {
  it("redacts raw file data and redacted thinking while retaining media references", () => {
    const result = compactionTranscript([
      { type: "input_file", filename: "evidence.pdf", file_data: "raw-base64-secret" },
      { type: "input_file", filename: "remote.pdf", file_url: "https://example.com/evidence.pdf" },
      { type: "redacted_thinking", data: "encrypted-thinking-secret" },
      {
        file_data: {
          filename: "nested.pdf",
          file_url: "https://example.com/nested.pdf",
          data: "nested-base64-secret",
        },
      },
      { inline_data: "raw-image-secret" },
      { fileData: "raw-file-secret" },
      { input_audio: { format: "wav", data: "raw-audio-secret" } },
      { image_url: "https://example.com/image.png" },
      { role: "tool", content: { data: "ordinary tool data" } },
    ]);
    for (const omitted of [
      "raw-base64-secret",
      "encrypted-thinking-secret",
      "nested-base64-secret",
      "raw-image-secret",
      "raw-file-secret",
      "raw-audio-secret",
    ]) {
      expect(result).not.toContain(omitted);
    }
    for (const retained of [
      "evidence.pdf",
      "remote.pdf",
      "nested.pdf",
      "https://example.com/evidence.pdf",
      "https://example.com/nested.pdf",
      "https://example.com/image.png",
      "ordinary tool data",
      '"format":"wav"',
    ]) {
      expect(result).toContain(retained);
    }
  });

  it("preserves visible state and file references but omits binary and opaque payloads", () => {
    const result = compactionTranscript([
      { type: "compaction", encrypted_content: "encrypted-secret" },
      {
        type: "thinking",
        thinking: "visible provider-returned thought",
        signature: "signature-secret",
      },
      {
        parts: [
          { inlineData: { mimeType: "image/png", data: "binary-secret" } },
          { fileData: { mimeType: "text/plain", fileUri: "gs://bucket/task.txt" } },
        ],
      },
      { image_url: { url: "data:image/png;base64,base64-secret" } },
      { type: "tool_result", content: { data: "important ordinary tool output" } },
    ]);
    expect(result).toContain("visible provider-returned thought");
    expect(result).toContain("important ordinary tool output");
    expect(result).toContain("gs://bucket/task.txt");
    expect(result).toContain("image/png");
    for (const omitted of [
      "encrypted-secret",
      "signature-secret",
      "binary-secret",
      "base64-secret",
    ]) {
      expect(result).not.toContain(omitted);
    }
  });

  it("handles cycles, duplicate objects, and scalar values", () => {
    const object: Record<string, unknown> = { content: "same text" };
    object.cycle = object;
    expect(compactionTranscript([object, object])).toContain("circular reference");
    expect(compactionTranscript([object, object]).match(/same text/g)).toHaveLength(2);
    expect(compactionTranscript(1n)).toBe('"1"');
    expect(compactionTranscript(undefined)).toBe("null");
  });
});

describe("compaction token estimation", () => {
  it("counts ordinary text and JSON tool output while excluding encoded payload sizes", () => {
    expect(estimateCompactionTokens({ content: "x".repeat(300) })).toBeGreaterThanOrEqual(100);
    expect(estimateCompactionTokens({ content: { data: "x".repeat(300) } })).toBeGreaterThanOrEqual(
      100,
    );
    const native = (size: number) => [
      { type: "compaction", encrypted_content: "x".repeat(size) },
      { type: "thinking", signature: "x".repeat(size) },
      { inlineData: { mimeType: "image/png", data: "x".repeat(size) } },
      { image_url: `data:image/png;base64,${"x".repeat(size)}` },
      { type: "input_file", filename: "report.pdf", file_data: "x".repeat(size) },
      { type: "redacted_thinking", data: "x".repeat(size) },
      { input_audio: { format: "wav", data: "x".repeat(size) } },
    ];
    expect(estimateCompactionTokens(native(1_000_000))).toBe(estimateCompactionTokens(native(10)));
  });

  it("handles shared and cyclic objects without recursion failures", () => {
    const object: Record<string, unknown> = { text: "retained" };
    object.circular = object;
    expect(estimateCompactionTokens([object, object])).toBeGreaterThan(0);
    expect(estimateCompactionTokens(undefined)).toBe(0);
  });
});

describe("summary compaction history boundaries", () => {
  it("pins instructions verbatim and keeps a complete recent user turn", () => {
    const history = [
      { role: "system", content: "Never forget the rules" },
      { role: "developer", content: "Exact API requirements" },
      { role: "user", content: "Original task" },
      { role: "assistant", content: "First result" },
      { role: "user", content: "Latest correction" },
      { role: "assistant", content: "In progress" },
    ];
    const split = splitCompactionHistory(history, { preserveRecentMessages: 1 });
    expect(split.instructions).toEqual(history.slice(0, 2));
    expect(split.prefix).toEqual(history.slice(2, 4));
    expect(split.suffix).toEqual(history.slice(4));
    expect(split.suffix[0]).toBe(history[4]);
  });

  it("does not confuse Anthropic or Gemini tool-result user messages with new turns", () => {
    const old = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old result" },
    ];
    const anthropic = [
      ...old,
      { role: "user", content: "new" },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "result" }],
      },
    ];
    expect(splitCompactionHistory(anthropic, { preserveRecentMessages: 1 }).suffix).toEqual(
      anthropic.slice(2),
    );
    const gemini = [
      ...old,
      { role: "user", parts: [{ text: "new" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup" } }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: {} } }] },
    ];
    expect(splitCompactionHistory(gemini, { preserveRecentMessages: 1 }).suffix).toEqual(
      gemini.slice(2),
    );
  });

  it("extends a suffix backward when Responses tools cross an ordinary user boundary", () => {
    const history = [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second turn" },
      { type: "function_call", call_id: "call_a", name: "lookup" },
      { role: "user", content: "steered while tool was pending" },
      { type: "function_call_output", call_id: "call_a", output: "found" },
    ];
    const split = splitCompactionHistory(history, { preserveRecentMessages: 1 });
    expect(split.prefix).toEqual(history.slice(0, 2));
    expect(split.suffix).toEqual(history.slice(2));
  });

  it("keeps parallel Chat Completions calls and tool outputs together", () => {
    const history = [
      { role: "user", content: "old" },
      { role: "assistant", content: "done" },
      { role: "user", content: "new" },
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "first result" },
      { role: "tool", tool_call_id: "b", content: "second result" },
    ];
    expect(splitCompactionHistory(history, { preserveRecentMessages: 1 }).suffix).toEqual(
      history.slice(2),
    );
  });

  it("keeps recent complete tool exchanges for a single long-running user goal", () => {
    const history: Array<Record<string, unknown>> = [
      { role: "user", content: "Keep working until all checks pass" },
    ];
    for (let index = 0; index < 5; index += 1) {
      history.push({ role: "assistant", tool_calls: [{ id: `tool_${index}` }] });
      history.push({
        role: "tool",
        tool_call_id: `tool_${index}`,
        content: `check ${index} complete`,
      });
    }
    const split = splitCompactionHistory(history, { preserveRecentMessages: 4 });
    expect(split.prefix).toEqual(history.slice(0, 7));
    expect(split.suffix).toEqual(history.slice(7));
    expect(() => assertCompleteCompactionHistory(split.prefix)).not.toThrow();
    expect(() => assertCompleteCompactionHistory(split.suffix)).not.toThrow();
  });

  it("expands recent tool results back to their call instead of dropping the whole suffix", () => {
    const history: Array<Record<string, unknown>> = [
      { role: "user", parts: [{ text: "Long task" }] },
    ];
    for (let index = 0; index < 4; index += 1) {
      history.push({
        role: "model",
        parts: [{ functionCall: { id: `id_${index}`, name: "check" } }],
      });
      history.push({
        role: "user",
        parts: [
          { functionResponse: { id: `id_${index}`, name: "check", response: { complete: true } } },
        ],
      });
    }
    const split = splitCompactionHistory(history, { preserveRecentMessages: 3 });
    expect(split.prefix).toEqual(history.slice(0, 5));
    expect(split.suffix).toEqual(history.slice(5));
    expect(() => assertCompleteCompactionHistory(split.suffix)).not.toThrow();
  });

  it("summarizes the full conversation when retaining recent messages would prevent progress", () => {
    const history = [
      { role: "user", content: "one turn" },
      { role: "assistant", content: "large output" },
    ];
    expect(splitCompactionHistory(history, { preserveRecentMessages: 4 })).toEqual({
      instructions: [],
      prefix: history,
      suffix: [],
    });
    expect(splitCompactionHistory(history, { preserveRecentMessages: 0 })).toEqual({
      instructions: [],
      prefix: history,
      suffix: [],
    });
  });
});
