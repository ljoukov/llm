import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatGptAuthMock = vi.hoisted(() => ({
  getChatGptAuthProfile: vi.fn(async () => ({
    access: "direct-access",
    refresh: "direct-refresh",
    expires: Date.now() + 60_000,
    accountId: "direct-account",
  })),
}));

vi.mock("../src/openai/chatgpt-auth.js", () => chatGptAuthMock);

import { createImageGenerationTool, generateImages } from "../src/index.js";
import {
  configureChatGptCodexProxy,
  requestChatGptCodexImages,
  type ChatGptCodexImageEditRequest,
  type ChatGptCodexImageRequest,
} from "../src/openai/chatgpt-codex.js";

const originalEnv = {
  imagesEndpoint: process.env.CHATGPT_CODEX_IMAGES_ENDPOINT,
  proxyUrl: process.env.CHATGPT_CODEX_PROXY_URL,
  proxyApiKey: process.env.CHATGPT_CODEX_PROXY_API_KEY,
};

const generatedBytes = Buffer.from("generated-image");
const generatedBase64 = generatedBytes.toString("base64");

function imageResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    created: 1,
    data: [{ b64_json: generatedBase64 }],
    background: "auto",
    output_format: "png",
    quality: "low",
    size: "1024x1024",
    ...overrides,
  });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  expect(typeof init?.body).toBe("string");
  return JSON.parse(String(init?.body));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("ChatGPT Codex Images transport", () => {
  beforeEach(() => {
    delete process.env.CHATGPT_CODEX_IMAGES_ENDPOINT;
    delete process.env.CHATGPT_CODEX_PROXY_URL;
    delete process.env.CHATGPT_CODEX_PROXY_API_KEY;
    configureChatGptCodexProxy(null);
    chatGptAuthMock.getChatGptAuthProfile.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureChatGptCodexProxy(null);
    restoreEnv("CHATGPT_CODEX_IMAGES_ENDPOINT", originalEnv.imagesEndpoint);
    restoreEnv("CHATGPT_CODEX_PROXY_URL", originalEnv.proxyUrl);
    restoreEnv("CHATGPT_CODEX_PROXY_API_KEY", originalEnv.proxyApiKey);
  });

  const directCases: ReadonlyArray<{
    operation: "generations" | "edits";
    path: string;
    request: ChatGptCodexImageRequest | ChatGptCodexImageEditRequest;
  }> = [
    {
      operation: "generations",
      path: "generations",
      request: {
        prompt: "A blue square",
        background: "auto",
        model: "gpt-image-2",
        n: 2,
        quality: "low",
        size: "1024x1024",
      },
    },
    {
      operation: "edits",
      path: "edits",
      request: {
        images: [{ image_url: "data:image/png;base64,UkVGRVJFTkNF" }],
        prompt: "Turn the square green",
        background: "opaque",
        model: "gpt-image-2",
        n: 1,
        quality: "medium",
        size: "1536x1024",
      },
    },
  ];

  for (const testCase of directCases) {
    it(`posts direct ${testCase.operation} requests with ChatGPT auth`, async () => {
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe(`https://chatgpt.com/backend-api/codex/images/${testCase.path}`);
        expect(init?.method).toBe("POST");
        expect(parseRequestBody(init)).toEqual(testCase.request);

        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer direct-access");
        expect(headers.get("chatgpt-account-id")).toBe("direct-account");
        expect(headers.get("originator")).toBe("codex_cli_rs");
        expect(headers.get("accept")).toBe("application/json");
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("openai-beta")).toBeNull();
        expect(headers.get("x-codex-proxy-auth")).toBeNull();
        return imageResponse();
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await requestChatGptCodexImages({
        operation: testCase.operation,
        request: testCase.request,
      });

      expect(response.data).toEqual([{ b64_json: generatedBase64 }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(chatGptAuthMock.getChatGptAuthProfile).toHaveBeenCalledTimes(1);
    });
  }

  it("derives the requested operation from the direct Images endpoint override", async () => {
    process.env.CHATGPT_CODEX_IMAGES_ENDPOINT =
      "https://images.example/backend-api/codex/images/generations?workspace=test";
    const fetchMock = vi.fn(async (input: unknown) => {
      expect(String(input)).toBe(
        "https://images.example/backend-api/codex/images/edits?workspace=test",
      );
      return imageResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestChatGptCodexImages({
      operation: "edits",
      request: {
        prompt: "Edit",
        model: "gpt-image-2",
        images: [{ image_url: "data:image/png;base64,SU1BR0U=" }],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("derives generation and edit endpoints from a runtime proxy without reading local auth", async () => {
    configureChatGptCodexProxy({
      url: "https://proxy.example/",
      apiKey: "proxy-key",
    });
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer proxy-key");
      expect(headers.get("x-codex-proxy-auth")).toBe("proxy-key");
      expect(headers.get("chatgpt-account-id")).toBeNull();
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("openai-beta")).toBeNull();
      requests.push({ url: String(input), body: parseRequestBody(init) });
      return imageResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const generationRequest: ChatGptCodexImageRequest = {
      prompt: "Generate",
      model: "gpt-image-2",
      size: "1024x1536",
    };
    const editRequest: ChatGptCodexImageEditRequest = {
      ...generationRequest,
      prompt: "Edit",
      images: [{ image_url: "data:image/jpeg;base64,SU1BR0U=" }],
    };
    await requestChatGptCodexImages({
      operation: "generations",
      request: generationRequest,
    });
    await requestChatGptCodexImages({ operation: "edits", request: editRequest });

    expect(requests).toEqual([
      {
        url: "https://proxy.example/api/codex/images/generations",
        body: generationRequest,
      },
      {
        url: "https://proxy.example/api/codex/images/edits",
        body: editRequest,
      },
    ]);
    expect(chatGptAuthMock.getChatGptAuthProfile).not.toHaveBeenCalled();
  });

  it("surfaces upstream failures and malformed image responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("quota exhausted", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ created: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const request: ChatGptCodexImageRequest = {
      prompt: "A blue square",
      model: "gpt-image-2",
    };

    await expect(requestChatGptCodexImages({ operation: "generations", request })).rejects.toThrow(
      "ChatGPT Codex image request failed (429): quota exhausted",
    );
    await expect(requestChatGptCodexImages({ operation: "generations", request })).rejects.toThrow(
      "ChatGPT Codex image response did not include an image data array",
    );
  });
});

describe("ChatGPT subscription image wrappers", () => {
  beforeEach(() => {
    delete process.env.CHATGPT_CODEX_IMAGES_ENDPOINT;
    delete process.env.CHATGPT_CODEX_PROXY_URL;
    delete process.env.CHATGPT_CODEX_PROXY_API_KEY;
    configureChatGptCodexProxy(null);
    chatGptAuthMock.getChatGptAuthProfile.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureChatGptCodexProxy(null);
    restoreEnv("CHATGPT_CODEX_IMAGES_ENDPOINT", originalEnv.imagesEndpoint);
    restoreEnv("CHATGPT_CODEX_PROXY_URL", originalEnv.proxyUrl);
    restoreEnv("CHATGPT_CODEX_PROXY_API_KEY", originalEnv.proxyApiKey);
  });

  it("uses automatic service controls and the edit endpoint for style images", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/images/edits");
      expect(parseRequestBody(init)).toEqual({
        images: [{ image_url: "data:image/jpeg;base64,cmVmZXJlbmNl" }],
        prompt: [
          "Follow the requested visual style.",
          "Style:",
          "Match the reference palette.",
          "Use the attached reference image or images for palette, lighting, mood, composition, and material feel.",
          "Image:",
          "A lighthouse at dusk",
        ].join("\n"),
        background: "opaque",
        model: "gpt-image-2",
        n: 1,
        quality: "auto",
        size: "auto",
      });
      return imageResponse({
        data: [{ b64_json: Buffer.from("first").toString("base64") }],
        size: "1024x1536",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await generateImages({
      model: "chatgpt-gpt-image-2",
      stylePrompt: "Match the reference palette.",
      styleImages: [{ mimeType: "image/jpeg", data: Buffer.from("reference") }],
      imagePrompts: ["A lighthouse at dusk"],
      background: "opaque",
    });

    expect(images.map((image) => image.data.toString())).toEqual(["first"]);
    expect(images.map((image) => image.mimeType)).toEqual(["image/png"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty successful image response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse({ data: [] })),
    );

    await expect(
      generateImages({
        model: "chatgpt-gpt-image-2",
        stylePrompt: "",
        imagePrompts: ["A blue square"],
      }),
    ).rejects.toThrow("ChatGPT Codex image response contained no generated images");
  });

  it("rejects unsupported subscription controls instead of silently ignoring them", async () => {
    const unsupportedControls = [
      ["imageResolution", "1024x1024"],
      ["imageSize", "landscape"],
      ["imageQuality", "high"],
      ["outputFormat", "jpeg"],
      ["outputCompression", 80],
      ["moderation", "low"],
      ["action", "generate"],
      ["partialImages", 1],
      ["numImages", 2],
    ] as const;

    for (const [control, value] of unsupportedControls) {
      await expect(
        generateImages({
          model: "chatgpt-gpt-image-2",
          stylePrompt: "",
          imagePrompts: ["A wide 3:1 panorama"],
          [control]: value,
        } as never),
      ).rejects.toThrow(`does not support structured control "${control}"`);
    }
  });

  it("returns generated image content suitable for a runtime agent tool result", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(parseRequestBody(init)).toMatchObject({
        prompt: "A paper-cut forest under moonlight",
        model: "gpt-image-2",
        n: 1,
        quality: "auto",
        size: "auto",
      });
      return imageResponse({ size: "1536x1024" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const imageTool = createImageGenerationTool({
      model: "chatgpt-gpt-image-2",
    });

    const output = await imageTool.execute({
      prompt: "A paper-cut forest under moonlight",
    });

    expect(output).toEqual([
      {
        type: "input_image",
        image_url: `data:image/png;base64,${generatedBase64}`,
        filename: "generated-1.png",
        detail: "original",
      },
    ]);
  });
});
