import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

let openAiRequests: any[] = [];
let chatGptRequests: any[] = [];
let chatGptCallCount = 0;
let uploadedFiles: any[] = [];

vi.mock("../src/openai/calls.js", () => {
  const fakeClient = {
    responses: {
      stream: (request: any) => {
        openAiRequests.push(request);
        const callIndex = openAiRequests.length - 1;
        const functionCalls =
          callIndex === 0
            ? Array.from({ length: 22 }, (_value, index) => ({
                type: "function_call",
                id: `fc_${index + 1}`,
                call_id: `call_${index + 1}`,
                name: "view_image",
                arguments: JSON.stringify({ path: `image-${index + 1}.png` }),
              }))
            : [];
        const finalResponse =
          callIndex === 0
            ? {
                id: "resp_1",
                model: "gpt-5.4-mini",
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  total_tokens: 15,
                },
                output: functionCalls,
              }
            : {
                id: "resp_2",
                model: "gpt-5.4-mini",
                usage: {
                  input_tokens: 8,
                  output_tokens: 4,
                  total_tokens: 12,
                },
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
              };
        return {
          async *[Symbol.asyncIterator]() {},
          async finalResponse() {
            return finalResponse;
          },
        };
      },
    },
  };

  return {
    DEFAULT_OPENAI_REASONING_EFFORT: "medium",
    runOpenAiCall: async (fn: (client: any) => Promise<any>) => await fn(fakeClient),
  };
});

vi.mock("../src/openai/chatgpt-codex.js", () => ({
  collectChatGptCodexResponse: async (options: any) => {
    chatGptRequests.push(options.request);
    const callIndex = chatGptCallCount++;
    if (callIndex === 0) {
      return {
        text: "",
        reasoningText: "",
        reasoningSummaryText: "",
        toolCalls: Array.from({ length: 22 }, (_value, index) => ({
          kind: "function" as const,
          id: `fc_${index + 1}`,
          callId: `call_${index + 1}`,
          name: "view_image",
          arguments: JSON.stringify({ path: `image-${index + 1}.png` }),
        })),
        webSearchCalls: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        model: "gpt-5.4",
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
      model: "gpt-5.4",
      status: "completed",
      blocked: false,
    };
  },
}));

vi.mock("../src/openai/client.js", () => ({
  getOpenAiClient: () => ({
    files: {
      create: async (body: any) => {
        uploadedFiles.push(body);
        const id = `file_${uploadedFiles.length}`;
        return {
          id,
          bytes: body?.file?.size ?? 0,
          created_at: uploadedFiles.length,
          filename: body?.file?.name ?? "uploaded.bin",
          object: "file",
          purpose: body?.purpose ?? "user_data",
          status: "processed",
          expires_at: uploadedFiles.length + 48 * 60 * 60,
        };
      },
    },
    uploads: {
      create: async () => ({ id: "upload_123" }),
      parts: {
        create: async (_uploadId: string, _body: any) => ({ id: "part_123" }),
      },
      complete: async () => ({ file: { id: "file_large" } }),
    },
  }),
}));

function createPngBuffer(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes, 0x11);
  buffer[0] = 0x89;
  buffer[1] = 0x50;
  buffer[2] = 0x4e;
  buffer[3] = 0x47;
  buffer[4] = 0x0d;
  buffer[5] = 0x0a;
  buffer[6] = 0x1a;
  buffer[7] = 0x0a;
  return buffer;
}

describe("runAgentLoop uploads", () => {
  it("logs uploads and reports telemetry when many images exceed the combined prompt threshold", async () => {
    openAiRequests = [];
    chatGptRequests = [];
    chatGptCallCount = 0;
    uploadedFiles = [];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-run-agent-uploads-"));
    try {
      const workspaceDir = path.join(tempRoot, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const imageBytes = 720 * 1024;
      await Promise.all(
        Array.from({ length: 22 }, async (_value, index) => {
          await fs.writeFile(
            path.join(workspaceDir, `image-${index + 1}.png`),
            createPngBuffer(imageBytes),
          );
        }),
      );

      const telemetryEvents: any[] = [];
      const { runAgentLoop } = await import("../src/agent.js");
      const result = await runAgentLoop({
        model: "gpt-5.4-mini",
        input: "Inspect all of the images and finish.",
        filesystemTool: {
          profile: "codex",
          options: { cwd: workspaceDir },
        },
        logging: {
          workspaceDir,
          mirrorToConsole: false,
        },
        telemetry: {
          sink: {
            emit: (event) => {
              telemetryEvents.push(event);
            },
          },
        },
      });

      expect(result.text).toBe("done");
      expect(openAiRequests).toHaveLength(2);
      expect(uploadedFiles).toHaveLength(22);

      const secondRequestInput = openAiRequests[1]?.input;
      expect(Array.isArray(secondRequestInput)).toBe(true);
      const toolOutputs = secondRequestInput.filter(
        (item: any) => item?.type === "function_call_output",
      );
      expect(toolOutputs).toHaveLength(22);
      for (const output of toolOutputs) {
        expect(Array.isArray(output.output)).toBe(true);
        expect(output.output[0]?.type).toBe("input_image");
        expect(output.output[0]?.file_id).toMatch(/^file_/u);
        expect(output.output[0]?.image_url).toBeUndefined();
      }

      const completed = telemetryEvents.find((event) => event?.type === "agent.run.completed") as {
        uploadCount?: number;
        uploadBytes?: number;
        uploadLatencyMs?: number;
      };
      expect(completed.uploadCount).toBe(22);
      expect(completed.uploadBytes).toBeGreaterThan(0);
      expect(completed.uploadLatencyMs).toBeGreaterThanOrEqual(0);

      const agentLog = await fs.readFile(path.join(workspaceDir, "agent.log"), "utf8");
      const uploadLines = agentLog
        .split("\n")
        .filter((line) => line.includes("[upload]") && line.includes("source=tool_output_spill"));
      expect(uploadLines).toHaveLength(22);
      expect(agentLog).toContain("uploadCount=22");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps ChatGPT image tool outputs inline when the combined prompt threshold is exceeded", async () => {
    openAiRequests = [];
    chatGptRequests = [];
    chatGptCallCount = 0;
    uploadedFiles = [];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-run-agent-chatgpt-uploads-"));
    try {
      const workspaceDir = path.join(tempRoot, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const imageBytes = 720 * 1024;
      await Promise.all(
        Array.from({ length: 22 }, async (_value, index) => {
          await fs.writeFile(
            path.join(workspaceDir, `image-${index + 1}.png`),
            createPngBuffer(imageBytes),
          );
        }),
      );

      const { runAgentLoop } = await import("../src/agent.js");
      const result = await runAgentLoop({
        model: "chatgpt-gpt-5.4",
        input: "Inspect all of the images and finish.",
        filesystemTool: {
          profile: "codex",
          options: { cwd: workspaceDir },
        },
        logging: {
          workspaceDir,
          mirrorToConsole: false,
        },
      });

      expect(result.text).toBe("done");
      expect(chatGptRequests).toHaveLength(2);
      expect(uploadedFiles).toHaveLength(0);

      const secondRequestInput = chatGptRequests[1]?.input;
      expect(Array.isArray(secondRequestInput)).toBe(true);
      const toolOutputs = secondRequestInput.filter(
        (item: any) => item?.type === "function_call_output",
      );
      expect(toolOutputs).toHaveLength(22);
      for (const output of toolOutputs) {
        expect(Array.isArray(output.output)).toBe(true);
        expect(output.output[0]?.type).toBe("input_image");
        expect(output.output[0]?.file_id).toBeUndefined();
        expect(output.output[0]?.image_url).toMatch(/^data:image\/png;base64,/u);
      }

      const agentLog = await fs.readFile(path.join(workspaceDir, "agent.log"), "utf8");
      const uploadLines = agentLog
        .split("\n")
        .filter((line) => line.includes("[upload]") && line.includes("source=tool_output_spill"));
      expect(uploadLines).toHaveLength(0);
      expect(agentLog).toContain("uploadCount=0");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
