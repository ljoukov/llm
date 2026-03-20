import { describe, expect, it, vi } from "vitest";

let geminiRequests: any[] = [];
let geminiUploadedFiles: any[] = [];
let geminiStoredFiles = new Map<string, any>();
let openAiStoredFiles = new Map<string, { file: any; bytes: Buffer; mimeType: string }>();

vi.mock("../src/google/calls.js", () => {
  async function* stream() {
    yield {
      modelVersion: "gemini-2.5-pro",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 6,
        thoughtsTokenCount: 2,
        totalTokenCount: 16,
      },
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello " }, { text: "Thinking", thought: true }, { text: "world" }],
          },
        },
      ],
    };
  }

  const fakeClient = {
    models: {
      generateContentStream: async (request: any) => {
        geminiRequests.push(request);
        return stream();
      },
    },
  };

  return {
    runGeminiCall: async (fn: (client: any) => Promise<any>) => fn(fakeClient),
  };
});

vi.mock("../src/google/client.js", async () => {
  const actual = await vi.importActual("../src/google/client.js");
  const fakeClient = {
    files: {
      upload: async (params: any) => {
        geminiUploadedFiles.push(params);
        const uploaded = {
          name: params?.config?.name ?? "files/test-file",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/test-file",
          mimeType: params?.config?.mimeType ?? "application/pdf",
          state: "ACTIVE",
        };
        geminiStoredFiles.set(uploaded.name, uploaded);
        return uploaded;
      },
      get: async (params: any) => {
        const file = geminiStoredFiles.get(params?.name);
        if (!file) {
          throw new Error(`Missing file: ${String(params?.name)}`);
        }
        return file;
      },
    },
  };
  return {
    ...actual,
    getGeminiBackend: () => "api",
    getGeminiClient: async () => fakeClient,
  };
});

vi.mock("../src/openai/client.js", () => ({
  getOpenAiClient: () => ({
    files: {
      create: async (body: any) => {
        const file = {
          id: "file_123",
          bytes: body?.file?.size ?? 0,
          created_at: 1,
          filename: body?.file?.name ?? "uploaded.bin",
          object: "file",
          purpose: body?.purpose ?? "user_data",
          status: "processed",
          expires_at: 1 + 48 * 60 * 60,
        };
        const bytes = Buffer.from(await body.file.arrayBuffer());
        openAiStoredFiles.set(file.id, {
          file,
          bytes,
          mimeType: body?.file?.type ?? "application/octet-stream",
        });
        return file;
      },
      retrieve: async (fileId: string) => {
        const stored = openAiStoredFiles.get(fileId);
        if (!stored) {
          throw new Error(`Missing OpenAI file: ${fileId}`);
        }
        return stored.file;
      },
      content: async (fileId: string) => {
        const stored = openAiStoredFiles.get(fileId);
        if (!stored) {
          throw new Error(`Missing OpenAI file: ${fileId}`);
        }
        return new Response(stored.bytes, {
          status: 200,
          headers: {
            "content-type": stored.mimeType,
          },
        });
      },
    },
    uploads: {
      create: async () => ({ id: "upload_123" }),
      parts: {
        create: async (_uploadId: string, _body: any) => ({ id: "part_123" }),
      },
      complete: async () => ({ file: { id: "file_123" } }),
    },
  }),
}));

describe("streamText (Gemini)", () => {
  it("streams response + thought deltas and returns usage/cost", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gemini-2.5-pro", input: "hi" });

    const events: any[] = [];
    for await (const ev of call.events) {
      events.push(ev);
    }
    const result = await call.result;

    expect(result.provider).toBe("gemini");
    expect(result.text).toBe("Hello world");
    expect(result.thoughts).toBe("Thinking");
    expect(result.usage?.totalTokens).toBe(16);
    expect(result.costUsd).toBeGreaterThan(0);

    expect(events.some((e) => e.type === "delta" && e.channel === "response")).toBe(true);
    expect(events.some((e) => e.type === "delta" && e.channel === "thought")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(geminiRequests[0]?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 32_768,
    });
  });

  it("maps thinkingLevel=low to gemini-2.5-pro thinkingBudget=256", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({ model: "gemini-2.5-pro", input: "hi", thinkingLevel: "low" });
    for await (const _event of call.events) {
      // Drain stream to completion.
    }
    await call.result;

    expect(geminiRequests[0]?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 256,
    });
  });

  it("maps thinkingLevel=medium to gemini-3.1-pro-preview thinkingLevel=MEDIUM", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({
      model: "gemini-3.1-pro-preview",
      input: "hi",
      thinkingLevel: "medium",
    });
    for await (const _event of call.events) {
      // Drain stream to completion.
    }
    await call.result;

    expect(geminiRequests[0]?.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });

  it("maps mediaResolution=original to Gemini high config and ultra-high image parts", async () => {
    geminiRequests = [];
    const { generateText } = await import("../src/llm.js");

    await generateText({
      model: "gemini-2.5-pro",
      mediaResolution: "original",
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            {
              type: "inlineData",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
            },
          ],
        },
      ],
    });

    expect(geminiRequests[0]?.config?.mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
    expect(geminiRequests[0]?.contents?.[0]?.parts?.[1]?.mediaResolution?.level).toBe(
      "MEDIA_RESOLUTION_ULTRA_HIGH",
    );
  });

  it("does not send thinkingConfig for Gemini image models", async () => {
    geminiRequests = [];
    const { streamText } = await import("../src/llm.js");

    const call = streamText({
      model: "gemini-3.1-flash-image-preview",
      input: "Generate an image",
      responseModalities: ["IMAGE", "TEXT"],
    });

    for await (const _event of call.events) {
      // Drain stream to completion.
    }
    const result = await call.result;

    expect(result.provider).toBe("gemini");
    expect(geminiRequests[0]?.model).toBe("gemini-3.1-flash-image-preview");
    expect(geminiRequests[0]?.config?.thinkingConfig).toBeUndefined();
  });

  it("uploads large prompt attachments and replaces inlineData with fileData uri", async () => {
    geminiRequests = [];
    geminiUploadedFiles = [];
    geminiStoredFiles = new Map();
    openAiStoredFiles = new Map();
    const { generateText } = await import("../src/llm.js");

    const largePdfB64 = Buffer.alloc(16 * 1024 * 1024, 0x61).toString("base64");
    await generateText({
      model: "gemini-2.5-pro",
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize the PDF." },
            {
              type: "inlineData",
              mimeType: "application/pdf",
              filename: "report.pdf",
              data: largePdfB64,
            },
          ],
        },
      ],
    });

    const filePart = geminiRequests[0]?.contents?.[0]?.parts?.find((part: any) => part?.fileData);
    expect(filePart?.fileData?.fileUri).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/test-file",
    );
    expect(filePart?.fileData?.mimeType).toBe("application/pdf");
    expect(geminiUploadedFiles).toHaveLength(1);
    expect(geminiUploadedFiles[0]?.config?.displayName).toBe("report.pdf");
  });
});
