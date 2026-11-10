import { tool } from "@ljoukov/llm";
import { z } from "zod";
import type { BrowserSession, BrowserAction } from "./browser.js";

// These descriptions and prompts/browser.md are the entire harness-authored model context.
export const browserToolDescription = `Operate Chrome using an independent local extension.
Actions: tabs; open(url); activate/close(tabId); snapshot(tabId,maxChars?);
navigate(tabId,url); back/forward/reload(tabId); click(tabId,ref OR x,y);
fill(tabId,ref,text); press(tabId,key); scroll(tabId,x,y);
screenshot(tabId); evaluate(tabId,expression); wait(tabId,expression?,timeoutMs?).
Refs come from snapshot and expire across navigation. press accepts Enter, Tab, Escape,
Backspace, Delete, arrows, Home, End, PageUp, PageDown, single characters, and modifiers
such as Control+A or Meta+A. scroll x/y are pixel deltas. wait expressions run in the page
and finish when truthy. evaluate returns JSON-compatible values. Screenshots return images.`;

export const browserInputSchema = z
  .object({
    action: z.enum([
      "tabs",
      "open",
      "activate",
      "close",
      "snapshot",
      "navigate",
      "back",
      "forward",
      "reload",
      "click",
      "fill",
      "press",
      "scroll",
      "screenshot",
      "evaluate",
      "wait",
    ]),
    // OpenAI strict function schemas represent omitted fields as null. Accept
    // those placeholders at the boundary and remove them before browser dispatch.
    tabId: z.number().int().positive().nullish(),
    url: z.string().min(1).nullish(),
    ref: z
      .string()
      .regex(/^e[1-9][0-9]*$/)
      .nullish(),
    text: z.string().nullish(),
    key: z.string().min(1).nullish(),
    x: z.number().finite().nullish(),
    y: z.number().finite().nullish(),
    expression: z.string().min(1).nullish(),
    timeoutMs: z.number().int().min(1).max(30000).nullish(),
    maxChars: z.number().int().min(256).max(100000).nullish(),
  })
  .superRefine((input, context) => {
    const required = (name: "url" | "ref" | "text" | "key" | "expression") => {
      if (input[name] == null)
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required for ${input.action}.`,
        });
    };
    if (input.action !== "tabs" && input.action !== "open" && input.tabId == null) {
      context.addIssue({
        code: "custom",
        path: ["tabId"],
        message: "tabId is required for this action.",
      });
    }
    if (input.action === "open" || input.action === "navigate") required("url");
    if (input.action === "fill") {
      required("ref");
      required("text");
    }
    if (input.action === "press") required("key");
    if (input.action === "evaluate") required("expression");
    if (input.action === "click") {
      if (input.ref != null && (input.x != null || input.y != null)) {
        context.addIssue({ code: "custom", message: "Click accepts ref or x/y, not both." });
      } else if (input.ref == null && (input.x == null || input.y == null)) {
        context.addIssue({ code: "custom", message: "Click requires ref or both x and y." });
      }
    }
    if (input.action === "scroll" && (input.x == null || input.y == null)) {
      context.addIssue({ code: "custom", message: "Scroll requires x and y pixel deltas." });
    }
  });

export function parseBrowserAction(input: unknown): BrowserAction {
  const parsed = browserInputSchema.parse(input);
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value != null),
  ) as BrowserAction;
}

export function createBrowserTools(session: BrowserSession) {
  return {
    browser: tool({
      description: browserToolDescription,
      inputSchema: browserInputSchema,
      execute: (input) => session.execute(parseBrowserAction(input)),
    }),
  };
}

export function describeBrowserTool() {
  return {
    name: "browser",
    description: browserToolDescription,
    inputSchema: z.toJSONSchema(browserInputSchema),
  };
}
