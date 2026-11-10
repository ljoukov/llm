import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserAction, describeBrowserTool } from "../src/tool.js";

test("strict-provider null placeholders become absent browser parameters", () => {
  assert.deepEqual(
    parseBrowserAction({ action: "click", tabId: 3, ref: "e12", x: null, y: null, text: null }),
    {
      action: "click",
      tabId: 3,
      ref: "e12",
    },
  );
  assert.deepEqual(parseBrowserAction({ action: "snapshot", tabId: 3, maxChars: null }), {
    action: "snapshot",
    tabId: 3,
  });
  assert.doesNotThrow(() => describeBrowserTool());
});

test("action-specific required fields fail before browser dispatch", () => {
  assert.throws(
    () => parseBrowserAction({ action: "fill", tabId: 3, ref: "e12", text: null }),
    /text is required/,
  );
  assert.throws(
    () => parseBrowserAction({ action: "click", tabId: 3, ref: "e12", x: 5, y: 6 }),
    /not both/,
  );
  assert.throws(
    () => parseBrowserAction({ action: "evaluate", tabId: null, expression: "1" }),
    /tabId is required/,
  );
  assert.deepEqual(parseBrowserAction({ action: "fill", tabId: 3, ref: "e12", text: "" }), {
    action: "fill",
    tabId: 3,
    ref: "e12",
    text: "",
  });
});
