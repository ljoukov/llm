import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";
import { installMockStorageEnv, resetMockStorageState } from "./helpers/mock-storage.js";

let generateContentStream = vi.fn<() => Promise<AsyncIterable<any>>>();
const initialTimeMs = Date.parse("2026-10-23T12:00:00Z");

vi.mock("@google-cloud/storage", async () => import("./helpers/mock-storage.js"));
vi.mock("../src/google/client.js", async () => {
  const actual = await vi.importActual("../src/google/client.js");
  return {
    ...actual,
    getGeminiBackend: () => "api",
    getGeminiClient: async () => ({
      models: { generateContentStream: () => generateContentStream() },
    }),
  };
});

function errorWithStatus(status: number, message = "temporarily unavailable"): Error {
  return Object.assign(new Error(message), { status });
}

function textChunk(text: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  };
}

async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return settled;
}

describe("Google safe retries", () => {
  beforeEach(() => {
    vi.resetModules();
    resetRuntimeSingletonsForTesting();
    resetMockStorageState();
    installMockStorageEnv();
    vi.useFakeTimers();
    vi.setSystemTime(initialTimeMs);
    vi.spyOn(Math, "random").mockReturnValue(0);
    generateContentStream = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([429, 503])("does not replay text after an interrupted %s stream", async (status) => {
    const original = errorWithStatus(status);
    generateContentStream.mockImplementation(async () =>
      (async function* () {
        yield textChunk("partial");
        throw original;
      })(),
    );
    const { streamText } = await import("../src/llm.js");
    const deltas: string[] = [];
    const call = streamText({ provider: "google", model: "gemini-2.5-pro", input: "hello" });
    const result = call.result.catch((error: unknown) => error);
    const stream = (async () => {
      try {
        for await (const event of call.events) {
          if (event.type === "delta" && event.channel === "response") {
            deltas.push(event.text);
          }
        }
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ cause: original, status });
    expect(await stream).toMatchObject({ cause: original, status });
    expect(deltas).toEqual(["partial"]);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it("does not restart a tool turn after an interrupted stream", async () => {
    const original = errorWithStatus(429);
    generateContentStream.mockImplementation(async () =>
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "partial" }, { functionCall: { name: "echo", args: {} } }],
              },
            },
          ],
        };
        throw original;
      })(),
    );
    const { runToolLoop, tool } = await import("../src/llm.js");
    const execute = vi.fn(async () => "done");
    const deltas: string[] = [];
    const result = await outcome(
      runToolLoop({
        provider: "google",
        model: "gemini-2.5-pro",
        input: "hello",
        tools: { echo: tool({ inputSchema: z.object({}), execute }) },
        onEvent: (event) => {
          if (event.type === "delta") {
            deltas.push(event.text);
          }
        },
      }),
    );

    expect(result.error).toMatchObject({ cause: original, status: 429 });
    expect(deltas).toEqual(["partial"]);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats a metadata-only first chunk as received response data", async () => {
    const { guardGeminiStreamRetries, runGeminiCall } = await import("../src/google/calls.js");
    const original = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    let attempts = 0;
    const result = await outcome(
      runGeminiCall(async () => {
        attempts += 1;
        const stream = (async function* () {
          yield { modelVersion: "gemini-2.5-pro" };
          throw original;
        })();
        for await (const _chunk of guardGeminiStreamRetries(stream)) {
          // Metadata is already part of the observable stream.
        }
      }, "gemini-2.5-pro"),
    );
    expect(result.error).toMatchObject({ cause: original });
    expect(attempts).toBe(1);
  });

  it("retries stream-opening failures before any chunk is received", async () => {
    const { guardGeminiStreamRetries, runGeminiCall } = await import("../src/google/calls.js");
    let attempts = 0;
    const chunks: string[] = [];
    const result = await outcome(
      runGeminiCall(async () => {
        attempts += 1;
        const stream = (async function* () {
          if (attempts === 1) {
            throw errorWithStatus(429);
          }
          yield "complete";
        })();
        for await (const chunk of guardGeminiStreamRetries(stream)) {
          chunks.push(chunk);
        }
        return "complete";
      }, "gemini-2.5-pro"),
    );
    expect(result.value).toBe("complete");
    expect(chunks).toEqual(["complete"]);
    expect(attempts).toBe(2);
  });

  it("retries generation startup errors at most three total attempts", async () => {
    const { runGeminiCall } = await import("../src/google/calls.js");
    const original = errorWithStatus(503);
    const request = vi.fn(async () => {
      throw original;
    });
    const result = await outcome(runGeminiCall(request, "gemini-2.5-pro"));
    expect(result.error).toBe(original);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ headers: new Headers({ "retry-after": "1.5" }) }, 1500],
    [{ response: { headers: { "Retry-After": "1.25" } } }, 1250],
    [{ headers: { "retry-after": "Fri, 23 Oct 2026 12:00:02 GMT" } }, 2000],
    [{ errorDetails: [{ retryDelay: "1.75s" }] }, 1750],
    [{ errorDetails: [{ retryDelay: { seconds: "1", nanos: 250_000_000 } }] }, 1250],
    [{ message: "Please retry in 1.2 seconds." }, 1200],
  ] as const)("honors a valid retry hint %j", async (details, expectedDelay) => {
    const { runGeminiCall } = await import("../src/google/calls.js");
    const startedAt: number[] = [];
    const original = Object.assign(errorWithStatus(429), details);
    const result = await outcome(
      runGeminiCall(async () => {
        startedAt.push(Date.now());
        if (startedAt.length === 1) {
          throw original;
        }
        return "complete";
      }, "gemini-2.5-pro"),
    );
    expect(result.value).toBe("complete");
    expect(startedAt).toEqual([initialTimeMs, initialTimeMs + expectedDelay]);
  });

  it.each([
    { headers: { "retry-after": "-1" } },
    { headers: { "retry-after": "Infinity" } },
    { headers: { "retry-after": "not-a-date" } },
    { errorDetails: [{ retryDelay: { seconds: "NaN", nanos: 0 } }] },
    { errorDetails: [{ retryDelay: { seconds: false, nanos: 0 } }] },
    { errorDetails: [{ retryDelay: { seconds: "", nanos: 0 } }] },
    { errorDetails: [{ retryDelay: { seconds: -1, nanos: 0 } }] },
    { errorDetails: [{ retryDelay: { seconds: 1, nanos: -1 } }] },
    { errorDetails: [{ retryDelay: { seconds: 1, nanos: 1_000_000_000 } }] },
    { message: "Please retry in -1 seconds." },
  ])("ignores an invalid or negative retry hint %j", async (details) => {
    const { runGeminiCall } = await import("../src/google/calls.js");
    const startedAt: number[] = [];
    const result = await outcome(
      runGeminiCall(async () => {
        startedAt.push(Date.now());
        if (startedAt.length === 1) {
          throw Object.assign(errorWithStatus(429), details);
        }
        return "complete";
      }, "gemini-2.5-pro"),
    );
    expect(result.value).toBe("complete");
    expect(startedAt).toEqual([initialTimeMs, initialTimeMs + 500]);
  });

  it("does not retry an abort error even when it also has retryable status", async () => {
    const { runGeminiCall } = await import("../src/google/calls.js");
    const original = Object.assign(new Error("aborted"), { name: "AbortError", status: 429 });
    const request = vi.fn(async () => {
      throw original;
    });
    const result = await outcome(runGeminiCall(request, "gemini-2.5-pro"));
    expect(result.error).toBe(original);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
