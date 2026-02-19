import { describe, expect, it } from "vitest";
import { z } from "zod";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateJson, loadLocalEnv, streamText } from "../src/index.js";

loadLocalEnv();

const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());
const hasGemini = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim());
const tokenProviderUrl = process.env.CHATGPT_AUTH_TOKEN_PROVIDER_URL?.trim();
const tokenProviderKey =
  process.env.CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY?.trim() ||
  process.env.CHATGPT_AUTH_API_KEY?.trim();

function hasCodexStore(): boolean {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const doc = JSON.parse(raw) as any;
    const tokens = doc?.tokens;
    return Boolean(tokens?.access_token && tokens?.refresh_token);
  } catch {
    return false;
  }
}

const hasChatGpt = Boolean((tokenProviderUrl && tokenProviderKey) || hasCodexStore());

const openAiIt = hasOpenAi ? it : it.skip;
const geminiIt = hasGemini ? it : it.skip;
const chatGptIt = hasChatGpt ? it : it.skip;

async function streamToStrings(call: ReturnType<typeof streamText>): Promise<{
  response: string;
  thought: string;
  sawUsage: boolean;
}> {
  let response = "";
  let thought = "";
  let sawUsage = false;
  for await (const event of call.events) {
    if (event.type === "delta") {
      if (event.channel === "response") {
        response += event.text;
      } else {
        thought += event.text;
      }
    } else if (event.type === "usage") {
      sawUsage = true;
    }
  }
  return { response, thought, sawUsage };
}

describe("integration: providers", () => {
  openAiIt("OpenAI: streams and returns result", async () => {
    const call = streamText({
      model: "gpt-5.1-codex-mini",
      input: "Return exactly: OK",
      openAiReasoningEffort: "low",
    });
    const streamed = await streamToStrings(call);
    const result = await call.result;

    expect(result.provider).toBe("openai");
    expect(result.text).toContain("OK");
    expect(streamed.response).toContain("OK");
    expect(streamed.sawUsage).toBe(true);
    expect(result.usage?.totalTokens).toBeTypeOf("number");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  geminiIt("Gemini: streams and returns result", async () => {
    const call = streamText({
      model: "gemini-2.5-pro",
      input: "Return exactly: OK",
    });
    const streamed = await streamToStrings(call);
    const result = await call.result;

    expect(result.provider).toBe("gemini");
    expect(result.text).toContain("OK");
    expect(streamed.response).toContain("OK");
    expect(streamed.sawUsage).toBe(true);
    expect(result.usage?.totalTokens).toBeTypeOf("number");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  chatGptIt("ChatGPT: streams and returns result", async () => {
    const call = streamText({
      model: "chatgpt-gpt-5.1-codex-mini",
      input: "Return exactly: OK",
      openAiReasoningEffort: "low",
    });
    const streamed = await streamToStrings(call);
    const result = await call.result;

    expect(result.provider).toBe("chatgpt");
    expect(result.text).toContain("OK");
    expect(streamed.response).toContain("OK");
    expect(streamed.sawUsage).toBe(true);
    expect(result.usage?.totalTokens).toBeTypeOf("number");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  chatGptIt("ChatGPT: generateJson returns validated JSON", async () => {
    const schema = z.object({ ok: z.boolean(), message: z.string() });
    const { value } = await generateJson({
      model: "chatgpt-gpt-5.1-codex-mini",
      input: 'Return exactly this JSON object: {"ok":true,"message":"hello"}. Return only JSON.',
      schema,
      openAiReasoningEffort: "low",
    });

    expect(value.ok).toBe(true);
    expect(value.message).toContain("hello");
  });
});
