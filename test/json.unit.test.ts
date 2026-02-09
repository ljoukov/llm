import { describe, expect, it } from "vitest";

import { parseJsonFromLlmText } from "../src/llm.js";

describe("parseJsonFromLlmText", () => {
  it("parses fenced json blocks", () => {
    const raw = ["```json", '{ "ok": true, "message": "hi" }', "```"].join("\n");
    expect(parseJsonFromLlmText(raw)).toEqual({ ok: true, message: "hi" });
  });

  it("extracts a JSON object from surrounding text", () => {
    const raw = ["Here is the payload:", "", '{ "a": 1, "b": 2 }', "", "Thanks!"].join("\n");
    expect(parseJsonFromLlmText(raw)).toEqual({ a: 1, b: 2 });
  });

  it("repairs unescaped newlines inside JSON strings", () => {
    const raw = `{\n  "a": "line1\nline2"\n}`;
    expect(parseJsonFromLlmText(raw)).toEqual({ a: "line1\nline2" });
  });
});
