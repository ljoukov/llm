import { describe, expect, it } from "vitest";

import { appendMarkdownSourcesSection, stripCodexCitationMarkers } from "../src/llm.js";

describe("citations", () => {
  it("strips Codex private-use citation markers", () => {
    const input = `hello \uE200cite\uE202turn1search0\uE201 world`;
    const out = stripCodexCitationMarkers(input);
    expect(out.stripped).toBe(true);
    expect(out.text).toContain("hello");
    expect(out.text).toContain("world");
    expect(out.text).not.toContain("\uE200");
    expect(out.text).not.toContain("\uE201");
    expect(out.text).not.toContain("\uE202");
  });

  it("does not change text without markers", () => {
    const out = stripCodexCitationMarkers("plain text");
    expect(out.stripped).toBe(false);
    expect(out.text).toBe("plain text");
  });

  it("appends a Sources section once", () => {
    const withSources = appendMarkdownSourcesSection("hello", ["https://example.com"]);
    expect(withSources).toContain("## Sources");
    expect(withSources).toContain("<https://example.com>");

    const again = appendMarkdownSourcesSection(withSources, ["https://another.example"]);
    expect(again).toBe(withSources);
  });
});
