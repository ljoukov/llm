import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let requests: any[] = [];
let callCount = 0;
let responseOverride: any = null;
let streamOverride: (() => AsyncIterable<any>) | null = null;

async function* completionStream(response: any) {
  const choice = response.choices[0];
  const message = choice.message;
  yield { model: response.model, choices: [{ index: 0, delta: { role: "assistant" } }] };
  for (const field of ["reasoning_content", "content"] as const) {
    const text = message[field];
    if (typeof text !== "string" || !text.length) continue;
    const split = Math.ceil(text.length / 2);
    yield { choices: [{ index: 0, delta: { [field]: text.slice(0, split) } }] };
    yield { choices: [{ index: 0, delta: { [field]: text.slice(split) } }] };
  }
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const nameSplit = Math.ceil(call.function.name.length / 2);
    const argsSplit = Math.ceil(call.function.arguments.length / 2);
    yield {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: call.type,
                function: {
                  name: call.function.name.slice(0, nameSplit),
                  arguments: call.function.arguments.slice(0, argsSplit),
                },
              },
            ],
          },
        },
      ],
    };
    yield {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                function: {
                  name: call.function.name.slice(nameSplit),
                  arguments: call.function.arguments.slice(argsSplit),
                },
              },
            ],
          },
        },
      ],
    };
  }
  yield { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] };
  if (response.usage) yield { choices: [], usage: response.usage };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readArtifact(filename: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await fs.readFile(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return fs.readFile(filename, "utf8");
}

async function callDirectory(root: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const calls = await fs.readdir(path.join(root, "llm_calls"));
      const directory = path.join(root, "llm_calls", calls[0] ?? "", "deepseek-v4.1-flash-1017");
      await fs.stat(path.join(directory, "request.txt"));
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("Native request artifact was not created.");
}

vi.mock("../src/fireworks/calls.js", () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(structuredClone(request));
          const current = callCount++;
          if (streamOverride) return streamOverride();
          if (responseOverride) return completionStream(structuredClone(responseOverride));
          if (current === 0) {
            return completionStream({
              model: "kimi-k3",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    reasoning_content: "  Use the multiply tool.\n",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "multiply",
                          arguments: JSON.stringify({ a: 2, b: 3 }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                completion_tokens_details: { reasoning_tokens: 2 },
                total_tokens: 15,
              },
            });
          }

          return completionStream({
            model: "kimi-k3",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "6",
                  reasoning_content: "The tool returned six.",
                },
              },
            ],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 4,
              total_tokens: 12,
            },
          });
        },
      },
    },
  };

  return {
    runFireworksCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("runToolLoop (Fireworks)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "fireworks");
    requests = [];
    callCount = 0;
    responseOverride = null;
    streamOverride = null;
  });
  it.each([
    "deepseek-v4.1-flash-1017",
    "glm-5.3",
    "kimi-k3",
  ] as const)("executes reasoning function tools for %s", async (model) => {
    requests = [];
    callCount = 0;
    const { runToolLoop, tool } = await import("../src/llm.js");

    const result = await runToolLoop({
      model,
      thinkingLevel: "high",
      input: "Use multiply then return result",
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });

    expect(result.text).toBe("6");
    expect(result.thoughts).toBe("The tool returned six.");
    expect(result.steps[0]?.thoughts).toBe("  Use the multiply tool.\n");
    expect(result.steps[0]?.usage?.thinkingTokens).toBe(2);
    expect(result.steps[0]?.usage?.responseTokens).toBe(3);
    expect(requests[0]?.reasoning_effort).toBe("high");
    expect(requests.every((request) => request.stream === true)).toBe(true);
    expect(requests.every((request) => request.stream_options?.include_usage === true)).toBe(true);
    expect(requests[0]).not.toHaveProperty("max_tokens");
    expect(result.steps.map((step) => step.finishReason)).toEqual(["tool_calls", "stop"]);
    expect(result.steps).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.[0]?.function?.name).toBe("multiply");
    const secondMessages = requests[1]?.messages ?? [];
    expect(secondMessages.some((m: any) => m?.role === "tool")).toBe(true);
    expect(secondMessages.find((m: any) => m?.tool_calls)?.reasoning_content).toBe(
      "  Use the multiply tool.\n",
    );
    expect(secondMessages.find((m: any) => m?.tool_calls)?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "multiply", arguments: '{"a":2,"b":3}' },
      },
    ]);
  });

  it("streams and persists thoughts during a paused DeepSeek tool-loop completion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-fireworks-loop-"));
    const paused = deferred();
    const resume = deferred();
    streamOverride = async function* () {
      yield {
        model: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
        choices: [{ index: 0, delta: { reasoning_content: "working " } }],
      };
      yield {
        choices: [{ index: 0, delta: { reasoning_content: "through it", content: "partial " } }],
      };
      paused.resolve();
      await resume.promise;
      yield { choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] };
      yield {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          completion_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 18,
        },
      };
    };
    const { createAgentLoggingSession, runWithAgentLoggingSession } = await import(
      "../src/agentLogging.js"
    );
    const { runToolLoop, tool } = await import("../src/llm.js");
    const session = createAgentLoggingSession({ workspaceDir: root, mirrorToConsole: false });
    const events: any[] = [];
    let settled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = runWithAgentLoggingSession(session, async () =>
      runToolLoop({
        model: "deepseek-v4.1-flash-1017",
        input: "work on this",
        onEvent: (event) => events.push(event),
        tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await paused.promise;
      expect(settled).toBe(false);
      expect(
        events
          .filter((event) => event.type === "delta" && event.channel === "thought")
          .map((event) => event.text),
      ).toEqual(["working ", "through it"]);
      await vi.advanceTimersByTimeAsync(4_999);
      const directory = await callDirectory(root);
      await expect(fs.stat(path.join(directory, "thoughts.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(await readArtifact(path.join(directory, "thoughts.txt"))).toBe("working through it");
      expect(await readArtifact(path.join(directory, "response.txt"))).toBe("partial ");
      expect(settled).toBe(false);
      resume.resolve();
      const completed = await result;
      expect(completed.text).toBe("partial answer");
      expect(completed.thoughts).toBe("working through it");
      expect(completed.steps[0]?.usage).toMatchObject({
        thinkingTokens: 5,
        responseTokens: 3,
        totalTokens: 18,
      });
      expect(await fs.readFile(path.join(directory, "thoughts.txt"), "utf8")).toBe(
        "working through it",
      );
      expect(await fs.readFile(path.join(directory, "response.txt"), "utf8")).toBe(
        "partial answer",
      );
      expect(
        events.filter((event) => event.type === "delta" && event.channel === "thought"),
      ).toHaveLength(2);
      expect(
        events
          .filter((event) => event.type === "delta" && event.channel === "response")
          .map((event) => event.text)
          .join(""),
      ).toBe("partial answer");
      expect(events.filter((event) => event.type === "model")).toHaveLength(1);
      expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    } finally {
      resume.resolve();
      await result.catch(() => undefined);
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["deepseek-v4.1-flash-1017", "ultra", "max"],
    ["glm-5.3", "xhigh", "xhigh"],
    ["kimi-k3", "max", "max"],
  ] as const)("maps %s thinking %s to %s", async (model, thinkingLevel, expectedEffort) => {
    requests = [];
    callCount = 0;
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      model,
      thinkingLevel,
      input: "Use multiply",
      tools: {
        multiply: tool({
          terminal: true,
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });
    expect(requests[0]?.reasoning_effort).toBe(expectedEffort);
  });

  it("forwards maxOutputTokens on each Fireworks completion", async () => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await runToolLoop({
      model: "deepseek-v4.1-flash-1017",
      input: "Use multiply then return result",
      maxOutputTokens: 131_072,
      tools: {
        multiply: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ value: a * b }),
        }),
      },
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.max_tokens).toBe(131_072);
      expect(request).not.toHaveProperty("max_completion_tokens");
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid maxOutputTokens %s before inference", async (maxOutputTokens) => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        model: "kimi-k3",
        input: "test",
        maxOutputTokens,
        tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    ).rejects.toThrow("maxOutputTokens must be a positive safe integer");
    expect(requests).toHaveLength(0);
  });

  it.each([
    "gpt-6-luna",
  ] as const)("rejects maxOutputTokens for unsupported route %s before inference", async (model) => {
    const { runToolLoop, tool } = await import("../src/llm.js");
    await expect(
      runToolLoop({
        model,
        input: "test",
        maxOutputTokens: 1024,
        tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
      }),
    ).rejects.toThrow("maxOutputTokens is only supported for Fireworks");
    expect(requests).toHaveLength(0);
  });

  it("retains a reasoning-only length stop in steps and events without retrying", async () => {
    responseOverride = {
      model: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
      choices: [
        {
          finish_reason: "length",
          message: { content: null, reasoning_content: "unfinished work" },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 13,
      },
    };
    const events: unknown[] = [];
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "deepseek-v4.1-flash-1017",
      input: "test",
      maxOutputTokens: 3,
      onEvent: (event) => events.push(event),
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(requests).toHaveLength(1);
    expect(result.text).toBe("");
    expect(result.thoughts).toBe("unfinished work");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.finishReason).toBe("length");
    expect(result.steps[0]?.usage?.thinkingTokens).toBe(3);
    expect(result.steps[0]?.usage?.responseTokens).toBe(0);
    expect(events).toContainEqual({
      type: "model",
      modelVersion: responseOverride.model,
      finishReason: "length",
    });
  });

  it("preserves unknown provider finish reasons without reclassifying them", async () => {
    responseOverride = {
      model: "kimi-k3",
      choices: [{ finish_reason: "vendor_future_stop", message: { content: "6" } }],
    };
    const { runToolLoop, tool } = await import("../src/llm.js");
    const result = await runToolLoop({
      model: "kimi-k3",
      input: "test",
      tools: { unused: tool({ inputSchema: z.object({}), execute: () => "unused" }) },
    });
    expect(result.steps[0]?.finishReason).toBe("vendor_future_stop");
    expect(result.text).toBe("6");
  });

  it("rejects custom/freeform tools for Fireworks provider", async () => {
    const { customTool, runToolLoop } = await import("../src/llm.js");

    await expect(
      runToolLoop({
        model: "glm-5.3",
        input: "test",
        tools: {
          custom_only: customTool({
            execute: async (input) => input,
          }),
        },
      }),
    ).rejects.toThrow("Fireworks provider does not support custom/freeform tools");
  });
});
