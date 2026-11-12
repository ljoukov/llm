import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runGeminiCall: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/google/calls.js", () => ({ runGeminiCall: mocks.runGeminiCall }));
vi.mock("../src/utils/env.js", () => ({ loadLocalEnv: vi.fn() }));

import { createGoogleDecision } from "../src/google/decisions.js";

const request = {
  model: "gemini-decision-1",
  input: "The parcel arrived damaged.",
  questions: {
    damaged: { type: "boolean" as const, instructions: "Is the parcel damaged?" },
  },
};

describe("Google Decisions adapter", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", " test-gemini-key ");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(Response.json({ answers: { damaged: { noul: 0.9 } } }));
    mocks.runGeminiCall.mockReset();
    mocks.runGeminiCall.mockImplementation(async (fn) => fn({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts to the native endpoint with key auth, signal, and scheduling", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    await expect(createGoogleDecision({ ...request, signal })).resolves.toEqual({
      answers: { damaged: { noul: 0.9 } },
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/decisions",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": "test-gemini-key" },
        body: JSON.stringify({
          model: request.model,
          input: request.input,
          questions: { damaged: { type: "noul", instructions: "Is the parcel damaged?" } },
        }),
        signal: expect.any(AbortSignal),
        dispatcher: expect.anything(),
      },
    );
    expect(mocks.runGeminiCall).toHaveBeenCalledWith(expect.any(Function), request.model, {
      signal,
    });
    const fetchSignal = mocks.fetch.mock.calls[0]?.[1].signal as AbortSignal;
    expect(fetchSignal.aborted).toBe(false);
    controller.abort(new Error("caller cancelled"));
    expect(fetchSignal.aborted).toBe(true);
    expect(fetchSignal.reason.message).toBe("caller cancelled");
  });

  it("bounds each HTTP attempt with a timeout while preserving caller cancellation", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const callerController = new AbortController();
    mocks.fetch.mockImplementation(
      async (_url, options: { signal: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const pending = createGoogleDecision({ ...request, signal: callerController.signal });
    expect(timeout).toHaveBeenCalledWith(15 * 60_000);
    timeoutController.abort(new DOMException("Request timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(callerController.signal.aborted).toBe(false);
  });

  it("maps boolean criteria and preserves native choice and score rubrics", async () => {
    await createGoogleDecision({
      ...request,
      questions: {
        damaged: {
          ...request.questions.damaged,
          criteria: { true: "Physical damage", false: "Preference only" },
        },
        department: {
          type: "choice",
          instructions: "Where should this go?",
          criteria: { returns: "Damaged items", support: "Other issues" },
        },
        severity: {
          type: "score",
          instructions: "How serious?",
          criteria: ["Minor", "Severe"],
        },
      },
    });
    const body = JSON.parse(mocks.fetch.mock.calls[0]?.[1].body);
    expect(body.questions).toEqual({
      damaged: {
        type: "noul",
        instructions: "Is the parcel damaged?",
        criteria: { true_description: "Physical damage", false_description: "Preference only" },
      },
      department: {
        type: "choice",
        instructions: "Where should this go?",
        criteria: { returns: "Damaged items", support: "Other issues" },
      },
      severity: { type: "score", instructions: "How serious?", criteria: ["Minor", "Severe"] },
    });
  });

  it("maps media MIME types while retaining data, URIs, resolution, and order", async () => {
    await createGoogleDecision({
      ...request,
      input: [
        { type: "text", text: "Inspect the evidence" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=", resolution: "high" },
        { type: "audio", mimeType: "audio/wav", uri: "https://example.com/audio.wav" },
        { type: "video", mimeType: "video/mp4", uri: "https://example.com/video.mp4" },
        { type: "document", mimeType: "application/pdf", data: "cGRm" },
      ],
    });
    const body = JSON.parse(mocks.fetch.mock.calls[0]?.[1].body);
    expect(body.input).toEqual([
      { type: "text", text: "Inspect the evidence" },
      { type: "image", mime_type: "image/png", data: "aW1hZ2U=", resolution: "high" },
      { type: "audio", mime_type: "audio/wav", uri: "https://example.com/audio.wav" },
      { type: "video", mime_type: "video/mp4", uri: "https://example.com/video.mp4" },
      { type: "document", mime_type: "application/pdf", data: "cGRm" },
    ]);
  });

  it("uses the existing GOOGLE_API_KEY fallback", async () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("GOOGLE_API_KEY", "google-key");
    await createGoogleDecision(request);
    expect(mocks.fetch.mock.calls[0]?.[1].headers["x-goog-api-key"]).toBe("google-key");
  });

  it.each([
    "",
    '{"project_id":"vertex-project"}',
  ])("rejects unavailable API-key or Vertex access before scheduling (%s)", async (serviceAccount) => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", serviceAccount);
    if (!serviceAccount) vi.stubEnv("GEMINI_API_KEY", "");
    await expect(createGoogleDecision(request)).rejects.toThrow(
      "Vertex AI access is not supported",
    );
    expect(mocks.runGeminiCall).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 429, 503])("preserves HTTP %s status and retry hints", async (status) => {
    const response = Response.json(
      { error: { message: "Provider error" } },
      { status, headers: { "retry-after": "2" } },
    );
    const cancel = vi.spyOn(response.body as ReadableStream, "cancel");
    mocks.fetch.mockResolvedValue(response);
    const error = await createGoogleDecision(request).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status });
    expect((error as { headers: Headers }).headers.get("retry-after")).toBe("2");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not schedule an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createGoogleDecision({ ...request, signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(mocks.runGeminiCall).not.toHaveBeenCalled();
  });

  it("surfaces network and malformed response errors", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(createGoogleDecision(request)).rejects.toThrow("fetch failed");
    mocks.fetch.mockResolvedValueOnce(new Response("invalid JSON"));
    await expect(createGoogleDecision(request)).rejects.toBeInstanceOf(SyntaxError);
  });
});
