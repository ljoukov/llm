import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

let openAiRequests: any[] = [];
let openAiCallCount = 0;
let openAiFirstResponseGate: Promise<void> | null = null;

let chatGptRequests: any[] = [];
let chatGptCallCount = 0;
let chatGptFirstResponseGate: Promise<void> | null = null;

vi.mock("../src/openai/calls.js", () => {
  const fakeClient = {
    responses: {
      stream: (request: any) => {
        openAiRequests.push(request);
        const callIndex = openAiCallCount++;
        const firstResponse = {
          id: "resp_1",
          model: "gpt-5.2",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "draft" }],
            },
          ],
        };
        const secondResponse = {
          id: "resp_2",
          model: "gpt-5.2",
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
        };
        const finalResponse = callIndex === 0 ? firstResponse : secondResponse;

        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", delta: callIndex === 0 ? "draft" : "done" };
          },
          async finalResponse() {
            if (callIndex === 0 && openAiFirstResponseGate) {
              await openAiFirstResponseGate;
            }
            return finalResponse;
          },
        };
      },
    },
  };

  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

vi.mock("../src/openai/chatgpt-codex.js", () => {
  return {
    collectChatGptCodexResponse: async (options: any) => {
      chatGptRequests.push(options.request);
      const callIndex = chatGptCallCount++;
      if (callIndex === 0 && chatGptFirstResponseGate) {
        await chatGptFirstResponseGate;
      }
      if (callIndex === 0) {
        return {
          text: "draft",
          reasoningText: "",
          reasoningSummaryText: "",
          toolCalls: [],
          webSearchCalls: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          model: "gpt-5.3-codex-spark",
          status: "completed",
          blocked: false,
        };
      }
      return {
        text: "done",
        reasoningText: "",
        reasoningSummaryText: "",
        toolCalls: [],
        webSearchCalls: [],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        model: "gpt-5.3-codex-spark",
        status: "completed",
        blocked: false,
      };
    },
  };
});

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("streamToolLoop steering", () => {
  it("queues steering mid-run for OpenAI and applies it on the next model step", async () => {
    openAiRequests = [];
    openAiCallCount = 0;
    const gate = createGate();
    openAiFirstResponseGate = gate.promise;

    const { streamToolLoop, tool } = await import("../src/llm.js");
    const call = streamToolLoop({
      model: "gpt-5.2",
      input: "start",
      tools: {
        noop: tool({
          inputSchema: z.object({}),
          execute: () => "ok",
        }),
      },
    });

    await vi.waitFor(() => expect(openAiRequests).toHaveLength(1));
    const appended = call.append("please continue with this direction");
    expect(appended.accepted).toBe(true);
    expect(appended.queuedCount).toBe(1);
    gate.resolve();

    await call.result;

    expect(openAiRequests).toHaveLength(2);
    expect(openAiRequests[1]?.previous_response_id).toBe("resp_1");
    const secondInput = openAiRequests[1]?.input ?? [];
    expect(
      secondInput.some(
        (item: any) =>
          item?.role === "user" &&
          ((typeof item?.content === "string" &&
            item.content.includes("please continue with this direction")) ||
            (Array.isArray(item?.content) &&
              item.content.some(
                (part: any) =>
                  part?.type === "input_text" &&
                  typeof part?.text === "string" &&
                  part.text.includes("please continue with this direction"),
              ))),
      ),
    ).toBe(true);
  });

  it("queues steering mid-run for ChatGPT and appends assistant + user follow-up", async () => {
    chatGptRequests = [];
    chatGptCallCount = 0;
    const gate = createGate();
    chatGptFirstResponseGate = gate.promise;

    const { streamToolLoop, tool } = await import("../src/llm.js");
    const call = streamToolLoop({
      model: "chatgpt-gpt-5.3-codex-spark",
      input: "start",
      tools: {
        noop: tool({
          inputSchema: z.object({}),
          execute: () => "ok",
        }),
      },
    });

    await vi.waitFor(() => expect(chatGptRequests).toHaveLength(1));
    const appended = call.append("please revise the plan");
    expect(appended.accepted).toBe(true);
    expect(appended.queuedCount).toBe(1);
    gate.resolve();

    await call.result;

    expect(chatGptRequests).toHaveLength(2);
    const secondInput = chatGptRequests[1]?.input ?? [];
    expect(
      secondInput.some(
        (item: any) =>
          item?.role === "assistant" &&
          Array.isArray(item?.content) &&
          item.content.some(
            (part: any) =>
              part?.type === "output_text" &&
              typeof part?.text === "string" &&
              part.text.includes("draft"),
          ),
      ),
    ).toBe(true);
    expect(
      secondInput.some(
        (item: any) =>
          item?.role === "user" &&
          Array.isArray(item?.content) &&
          item.content.some(
            (part: any) =>
              part?.type === "input_text" &&
              typeof part?.text === "string" &&
              part.text.includes("please revise the plan"),
          ),
      ),
    ).toBe(true);
  });
});
