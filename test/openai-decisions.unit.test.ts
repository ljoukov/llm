import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleDecision } from "../src/decisions/openai-compatible.js";

const mocks = vi.hoisted(() => ({
  openaiPost: vi.fn(),
  fireworksPost: vi.fn(),
  runOpenAiCall: vi.fn(),
  runFireworksCall: vi.fn(),
}));
vi.mock("../src/openai/calls.js", () => ({ runOpenAiCall: mocks.runOpenAiCall }));
vi.mock("../src/fireworks/calls.js", () => ({ runFireworksCall: mocks.runFireworksCall }));

describe("OpenAI-compatible Decisions adapters", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runOpenAiCall.mockImplementation(async (fn: (client: OpenAI) => Promise<unknown>) =>
      fn({ post: mocks.openaiPost } as unknown as OpenAI),
    );
    mocks.runFireworksCall.mockImplementation(async (fn: (client: OpenAI) => Promise<unknown>) =>
      fn({ post: mocks.fireworksPost } as unknown as OpenAI),
    );
  });

  it("maps all question types to native OpenAI Decisions and preserves the raw response", async () => {
    const rawResponse = { model: "gpt-6-luna", answers: [], usage: { input_tokens: 12 } };
    mocks.openaiPost.mockResolvedValue(rawResponse);
    const result = await createOpenAiCompatibleDecision({
      provider: "openai",
      model: "gpt-6-luna",
      input: "Please refund the duplicate charge.",
      questions: {
        refund: {
          type: "boolean",
          instructions: "Does the customer request a refund?",
          criteria: { true: "Refund requested.", false: "No refund requested." },
        },
        queue: {
          type: "choice",
          instructions: "Choose the correct queue.",
          criteria: { billing: "Payments and invoices.", technical: "Product failures." },
        },
        severity: {
          type: "score",
          instructions: "Rate the issue severity.",
          criteria: ["Minor", "Critical"],
        },
      },
    });
    expect(result).toBe(rawResponse);
    expect(mocks.runOpenAiCall).toHaveBeenCalledWith(expect.any(Function), "gpt-6-luna", {
      signal: undefined,
    });
    expect(mocks.openaiPost).toHaveBeenCalledWith("/decisions", {
      body: {
        model: "gpt-6-luna",
        input: "Please refund the duplicate charge.",
        questions: [
          {
            name: "refund",
            type: "predicate",
            instructions:
              "Does the customer request a refund?\nTrue: Refund requested.\nFalse: No refund requested.",
          },
          {
            name: "queue",
            type: "choice",
            instructions: "Choose the correct queue.",
            choices: [
              { value: "billing", description: "Payments and invoices." },
              { value: "technical", description: "Product failures." },
            ],
          },
          {
            name: "severity",
            type: "score",
            instructions: "Rate the issue severity.",
            levels: [{ label: "Minor" }, { label: "Critical" }],
          },
        ],
      },
      signal: undefined,
    });
    expect(mocks.runFireworksCall).not.toHaveBeenCalled();
  });

  it("routes Rune to the Fireworks client and passes cancellation to the queue and request", async () => {
    const controller = new AbortController();
    await createOpenAiCompatibleDecision({
      provider: "fireworks",
      model: "accounts/fireworks/models/rune",
      input: [{ type: "text", text: "The screen arrived broken." }],
      questions: { damaged: { type: "boolean", instructions: "Is the screen damaged?" } },
      signal: controller.signal,
    });
    expect(mocks.runFireworksCall).toHaveBeenCalledWith(
      expect.any(Function),
      "accounts/fireworks/models/rune",
      { signal: controller.signal },
    );
    expect(mocks.fireworksPost).toHaveBeenCalledWith("/decisions", {
      body: {
        model: "accounts/fireworks/models/rune",
        input: [
          { role: "user", content: [{ type: "input_text", text: "The screen arrived broken." }] },
        ],
        questions: [{ name: "damaged", type: "predicate", instructions: "Is the screen damaged?" }],
      },
      signal: controller.signal,
    });
    expect(mocks.runOpenAiCall).not.toHaveBeenCalled();
  });

  it("maps hosted and inline OpenAI images without fetching them locally", async () => {
    await createOpenAiCompatibleDecision({
      provider: "openai",
      model: "gpt-6-luna",
      input: [
        { type: "text", text: "Check both product photos." },
        {
          type: "image",
          uri: "https://example.com/photo.jpg",
          mimeType: "image/jpeg",
          resolution: "high",
        },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      questions: { damaged: { type: "boolean", instructions: "Is there visible damage?" } },
    });
    expect(mocks.openaiPost.mock.calls[0]?.[1].body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Check both product photos." },
          { type: "input_image", image_url: "https://example.com/photo.jpg", detail: "high" },
          { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
        ],
      },
    ]);
  });

  it.each([
    "audio",
    "video",
    "document",
  ] as const)("rejects unsupported OpenAI %s input before requesting a client", async (type) => {
    await expect(
      createOpenAiCompatibleDecision({
        provider: "openai",
        model: "gpt-6-luna",
        input: [{ type, data: "Ynl0ZXM=", mimeType: "application/octet-stream" }],
        questions: { check: { type: "boolean", instructions: "Is this relevant?" } },
      }),
    ).rejects.toThrow(`OpenAI decisions do not support ${type} input.`);
    expect(mocks.runOpenAiCall).not.toHaveBeenCalled();
  });

  it("rejects Fireworks image inputs before requesting a client", async () => {
    await expect(
      createOpenAiCompatibleDecision({
        provider: "fireworks",
        model: "accounts/fireworks/models/rune",
        input: [{ type: "image", uri: "https://example.com/photo.jpg", mimeType: "image/jpeg" }],
        questions: { damaged: { type: "boolean", instructions: "Is there visible damage?" } },
      }),
    ).rejects.toThrow("Fireworks decision models support text input only.");
    expect(mocks.runFireworksCall).not.toHaveBeenCalled();
  });

  it.each([
    "medium",
    "ultra_high",
  ] as const)("rejects unsupported OpenAI image resolution %s", async (resolution) => {
    await expect(
      createOpenAiCompatibleDecision({
        provider: "openai",
        model: "gpt-6-luna",
        input: [{ type: "image", data: "Ynl0ZXM=", mimeType: "image/png", resolution }],
        questions: { damaged: { type: "boolean", instructions: "Is there visible damage?" } },
      }),
    ).rejects.toThrow("OpenAI decision image resolution must be low or high.");
    expect(mocks.runOpenAiCall).not.toHaveBeenCalled();
  });

  it("rejects Google Files API URIs for OpenAI images", async () => {
    await expect(
      createOpenAiCompatibleDecision({
        provider: "openai",
        model: "gpt-6-luna",
        input: [{ type: "image", uri: "files/123", mimeType: "image/jpeg" }],
        questions: { damaged: { type: "boolean", instructions: "Is there visible damage?" } },
      }),
    ).rejects.toThrow("OpenAI decision images require an HTTP(S) URI or inline base64 data.");
    expect(mocks.runOpenAiCall).not.toHaveBeenCalled();
  });

  it("preserves provider errors so callers retain status and request details", async () => {
    const providerError = Object.assign(new Error("Forbidden"), { status: 403 });
    mocks.openaiPost.mockRejectedValue(providerError);
    await expect(
      createOpenAiCompatibleDecision({
        provider: "openai",
        model: "gpt-6-luna",
        input: "Customer message",
        questions: { refund: { type: "boolean", instructions: "Is a refund requested?" } },
      }),
    ).rejects.toBe(providerError);
  });
});
