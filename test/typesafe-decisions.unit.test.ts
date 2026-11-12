import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";

vi.mock("../src/utils/env.js", () => ({ loadLocalEnv: vi.fn() }));

const requestFetch = vi.fn();

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const booleanQuestion = {
  refund: { type: "boolean" as const, instructions: "Does the customer request a refund?" },
};

describe("TypeSafe decisions", () => {
  beforeEach(() => {
    resetRuntimeSingletonsForTesting();
    vi.resetModules();
    requestFetch.mockReset();
    vi.stubGlobal("fetch", requestFetch);
    vi.stubEnv("TYPESAFE_API_KEY", " test-typesafe-key ");
    vi.stubEnv("TYPESAFE_BASE_URL", "");
    vi.stubEnv("TYPESAFE_TIMEOUT_MS", "");
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends native question types and preserves the provider response", async () => {
    const response = {
      model: "jev-1.14.0",
      answers: {
        refund: { type: "noul", noul: 0.99 },
        team: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.8,
        },
        severity: {
          type: "score",
          score: 0.2,
          probabilities: { "0": 0.8, "1": 0.2 },
          legend: { "0": "Minor", "1": "Severe" },
          confidence: 0.6,
        },
      },
      usage: { input_tokens: 120, output_tokens: 32 },
    };
    requestFetch.mockResolvedValue(jsonResponse(response));
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    await expect(
      createTypesafeDecision({
        model: "jev-latest",
        input: [
          { type: "text", text: "I was charged twice." },
          { type: "text", text: "Please refund the duplicate charge." },
        ],
        questions: {
          refund: {
            ...booleanQuestion.refund,
            criteria: { true: "A refund is requested", false: "No refund is requested" },
          },
          team: {
            type: "choice",
            instructions: "Which team?",
            criteria: { billing: "Payments", technical: "Product faults" },
          },
          severity: {
            type: "score",
            instructions: "How severe?",
            criteria: ["Minor", "Severe"],
          },
        },
      }),
    ).resolves.toEqual(response);
    const [url, init] = requestFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toEqual({
      Authorization: "Bearer test-typesafe-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      model: "jev-latest",
      state: "I was charged twice.Please refund the duplicate charge.",
      questions: {
        refund: {
          type: "noul",
          instructions: booleanQuestion.refund.instructions,
          criteria: { true: "A refund is requested", false: "No refund is requested" },
        },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Payments", technical: "Product faults" },
        },
        severity: {
          type: "score",
          instructions: "How severe?",
          criteria: ["Minor", "Severe"],
        },
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.dispatcher).toBeDefined();
  });

  it.each([
    "https://proxy.example/typesafe/v1",
    "https://proxy.example/typesafe/v1/",
  ])("preserves a configured API base path: %s", async (baseUrl) => {
    vi.stubEnv("TYPESAFE_BASE_URL", baseUrl);
    requestFetch.mockResolvedValue(jsonResponse({ answers: {} }));
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    await createTypesafeDecision({
      model: "jev-latest",
      input: "Request a refund",
      questions: booleanQuestion,
    });
    expect(String(requestFetch.mock.calls[0]?.[0])).toBe(
      "https://proxy.example/typesafe/v1/systemone",
    );
  });

  it("fails before a request when the credential is missing", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", " ");
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    await expect(
      createTypesafeDecision({
        model: "jev-latest",
        input: "Request a refund",
        questions: booleanQuestion,
      }),
    ).rejects.toThrow("TYPESAFE_API_KEY must be provided");
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it.each([
    "image",
    "audio",
    "video",
    "document",
  ] as const)("rejects unsupported %s input before a request", async (type) => {
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    await expect(
      createTypesafeDecision({
        model: "jev-latest",
        input: [{ type, mimeType: "application/octet-stream", data: "aGVsbG8=" }],
        questions: booleanQuestion,
      }),
    ).rejects.toThrow(`TypeSafe decisions currently support text input only; received ${type}`);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("retries rate limits and reports retry metrics", async () => {
    vi.useFakeTimers();
    requestFetch
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse({ answers: {} }));
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    const settled = vi.fn();
    const pending = createTypesafeDecision({
      model: "jev-latest",
      input: "Request a refund",
      questions: booleanQuestion,
      onSettled: settled,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(requestFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toEqual({ answers: {} });
    expect(requestFetch).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 2, overloadCount: 1, retryDelayMs: 1_000 }),
    );
  });

  it.each([400, 401, 402, 413, 422])("does not retry terminal HTTP %s", async (status) => {
    requestFetch.mockImplementation(async () => jsonResponse({ error: "invalid request" }, status));
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    await expect(
      createTypesafeDecision({
        model: "jev-latest",
        input: "Request a refund",
        questions: booleanQuestion,
      }),
    ).rejects.toMatchObject({ status });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated transient failures to four attempts", async () => {
    vi.useFakeTimers();
    requestFetch.mockImplementation(async () => jsonResponse({ error: "unavailable" }, 503));
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    const pending = createTypesafeDecision({
      model: "jev-latest",
      input: "Request a refund",
      questions: booleanQuestion,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ status: 503 });
    expect(requestFetch).toHaveBeenCalledTimes(4);
  });

  it("does not send an already cancelled request", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled by caller");
    controller.abort(reason);
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    await expect(
      createTypesafeDecision({
        model: "jev-latest",
        input: "Request a refund",
        questions: booleanQuestion,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("cancels a pending retry without another request", async () => {
    vi.useFakeTimers();
    requestFetch.mockImplementation(async () =>
      jsonResponse({ error: "rate limited" }, 429, { "retry-after": "30" }),
    );
    const controller = new AbortController();
    const reason = new Error("Cancelled retry");
    const { createTypesafeDecision } = await import("../src/typesafe/decisions.js");
    const pending = createTypesafeDecision({
      model: "jev-latest",
      input: "Request a refund",
      questions: booleanQuestion,
      signal: controller.signal,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });
});
