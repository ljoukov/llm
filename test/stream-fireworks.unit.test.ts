import { describe, expect, it, vi } from "vitest";

let capturedRequest: any = null;

vi.mock("../src/fireworks/calls.js", () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async (request: any) => {
          capturedRequest = request;
          return {
            model: "kimi-k2.5",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "Hello",
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 6,
              total_tokens: 16,
            },
          };
        },
      },
    },
  };

  return {
    runFireworksCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

describe("streamText (Fireworks)", () => {
  it("routes kimi-k2.5 through Fireworks provider and reports usage", async () => {
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "kimi-k2.5", input: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("fireworks");
    expect(result.text).toBe("Hello");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("sets json_object response_format when JSON mime type is requested", async () => {
    capturedRequest = null;
    const { generateText } = await import("../src/llm.js");

    await generateText({
      model: "glm-5",
      input: "Return JSON.",
      responseMimeType: "application/json",
    });

    expect(capturedRequest?.response_format).toEqual({ type: "json_object" });
  });
});
