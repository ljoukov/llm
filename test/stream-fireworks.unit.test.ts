import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let capturedRequest: any = null;
let streamOverride: (() => AsyncIterable<any>) | null = null;

async function* defaultStream() {
  yield {
    model: "kimi-k3",
    choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I should " } }],
  };
  yield {
    choices: [{ index: 0, delta: { reasoning_content: "greet the user.", content: "Hel" } }],
  };
  yield { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] };
  yield {
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function callDirectory(root: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const calls = await fs.readdir(path.join(root, "llm_calls"));
      const callRoot = path.join(root, "llm_calls", calls[0] ?? "");
      const models = await fs.readdir(callRoot);
      const directory = path.join(callRoot, models[0] ?? "");
      await fs.stat(path.join(directory, "request.txt"));
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("Native request artifact was not created.");
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

vi.mock("../src/fireworks/calls.js", () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          capturedRequest = request;
          return (streamOverride ?? defaultStream)();
        },
      },
    },
  };

  return {
    runFireworksCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("streamText (Fireworks)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "fireworks");
    capturedRequest = null;
    streamOverride = null;
  });

  it("routes kimi-k3 through Fireworks provider and reports usage", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "kimi-k3", input: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("fireworks");
    expect(result.text).toBe("Hello");
    expect(result.thoughts).toBe("I should greet the user.");
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(capturedRequest.stream).toBe(true);
    expect(capturedRequest.stream_options).toEqual({ include_usage: true });
    expect(
      events
        .filter((event) => event.type === "delta" && event.channel === "thought")
        .map((event) => event.text)
        .join(""),
    ).toBe(result.thoughts);
    expect(
      events
        .filter((event) => event.type === "delta" && event.channel === "response")
        .map((event) => event.text)
        .join(""),
    ).toBe(result.text);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("persists streamed partial traces after five seconds while inference is still running", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-fireworks-stream-"));
    const paused = deferred();
    const resume = deferred();
    streamOverride = async function* () {
      yield {
        model: "kimi-k3",
        choices: [{ index: 0, delta: { reasoning_content: "still thinking" } }],
      };
      yield { choices: [{ index: 0, delta: { content: "partial " } }] };
      paused.resolve();
      await resume.promise;
      yield { choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] };
    };
    const { createAgentLoggingSession, runWithAgentLoggingSession } = await import(
      "../src/agentLogging.js"
    );
    const { streamText } = await import("../src/llm.js");
    const session = createAgentLoggingSession({ workspaceDir: root, mirrorToConsole: false });
    const events: any[] = [];
    let settled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = runWithAgentLoggingSession(session, async () => {
      const call = streamText({ model: "kimi-k3", input: "hi" });
      const drain = (async () => {
        for await (const event of call.events) events.push(event);
      })();
      const value = await call.result;
      await drain;
      return value;
    });
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
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(events).toContainEqual({ type: "delta", channel: "thought", text: "still thinking" });
      expect(events).toContainEqual({ type: "delta", channel: "response", text: "partial " });
      await vi.advanceTimersByTimeAsync(4_999);
      const directory = await callDirectory(root);
      await expect(fs.stat(path.join(directory, "thoughts.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(await readArtifact(path.join(directory, "thoughts.txt"))).toBe("still thinking");
      expect(await readArtifact(path.join(directory, "response.txt"))).toBe("partial ");
      expect(settled).toBe(false);
      resume.resolve();
      expect((await result).text).toBe("partial answer");
      expect(await fs.readFile(path.join(directory, "thoughts.txt"), "utf8")).toBe(
        "still thinking",
      );
      expect(await fs.readFile(path.join(directory, "response.txt"), "utf8")).toBe(
        "partial answer",
      );
      expect(
        events.filter((event) => event.type === "delta" && event.channel === "thought"),
      ).toHaveLength(1);
    } finally {
      resume.resolve();
      await result.catch(() => undefined);
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps partial thought and response artifacts when the stream fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-fireworks-error-"));
    const paused = deferred();
    const resume = deferred();
    streamOverride = async function* () {
      yield {
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "unfinished thought", content: "partial response" },
          },
        ],
      };
      paused.resolve();
      await resume.promise;
      throw new Error("provider connection lost");
    };
    let observed: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const { createAgentLoggingSession, runWithAgentLoggingSession } = await import(
        "../src/agentLogging.js"
      );
      const { streamText } = await import("../src/llm.js");
      const session = createAgentLoggingSession({ workspaceDir: root, mirrorToConsole: false });
      const events: any[] = [];
      observed = runWithAgentLoggingSession(session, async () => {
        const call = streamText({ model: "kimi-k3", input: "hi" });
        const drain = (async () => {
          for await (const event of call.events) events.push(event);
        })();
        return Promise.allSettled([call.result, drain]);
      });
      await paused.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toContainEqual({
        type: "delta",
        channel: "thought",
        text: "unfinished thought",
      });
      resume.resolve();
      const outcomes = await observed;
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected")
          expect(outcome.reason.message).toContain("provider connection lost");
      }
      const directory = await callDirectory(root);
      expect(await fs.readFile(path.join(directory, "thoughts.txt"), "utf8")).toBe(
        "unfinished thought",
      );
      expect(await fs.readFile(path.join(directory, "response.txt"), "utf8")).toBe(
        "partial response",
      );
      expect(await fs.readFile(path.join(directory, "error.txt"), "utf8")).toContain(
        "provider connection lost",
      );
    } finally {
      resume.resolve();
      await observed;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sets json_object response_format when JSON mime type is requested", async () => {
    capturedRequest = null;
    const { generateText } = await import("../src/llm.js");

    await generateText({
      model: "glm-5.3",
      thinkingLevel: "high",
      input: "Return JSON.",
      responseMimeType: "application/json",
    });

    expect(capturedRequest?.response_format).toEqual({ type: "json_object" });
    expect(capturedRequest?.reasoning_effort).toBe("high");
  });

  it("rejects provider-native shell tools for Fireworks models", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({
      model: "kimi-k3",
      input: "Use shell.",
      tools: [{ type: "shell" }],
    });
    const events = (async () => {
      for await (const _event of call.events) {
        // Drain until the stream surfaces the rejection.
      }
    })();

    await expect(call.result).rejects.toThrow(
      "Fireworks provider does not support provider-native tools in generateText",
    );
    await expect(events).rejects.toThrow(
      "Fireworks provider does not support provider-native tools in generateText",
    );
  });
});
