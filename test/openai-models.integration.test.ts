import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CHATGPT_MODEL_IDS,
  generateJson,
  isChatGptModelId,
  isOpenAiModelId,
  OPENAI_MODEL_IDS,
  streamText,
  type LlmTextModelId,
} from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const allSupportedOpenAiTextModels = [
  ...OPENAI_MODEL_IDS,
  ...CHATGPT_MODEL_IDS,
] as const satisfies readonly LlmTextModelId[];

const supportedOpenAiTextModels = process.env.LLM_INTEGRATION_MODELS?.trim()
  ? resolveIntegrationRequestedModels()
  : allSupportedOpenAiTextModels;
const outsideMatrix = supportedOpenAiTextModels.filter(
  (model) => !(allSupportedOpenAiTextModels as readonly string[]).includes(model),
);
if (outsideMatrix.length > 0 || supportedOpenAiTextModels.length === 0) {
  throw new Error(
    `LLM_INTEGRATION_MODELS must select supported OpenAI/ChatGPT text models; received: ${supportedOpenAiTextModels.join(", ")}`,
  );
}
assertIntegrationCredentialsForModels(supportedOpenAiTextModels);

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
      continue;
    }

    if (event.type === "usage") {
      sawUsage = true;
    }
  }

  return { response, thought, sawUsage };
}

describe.concurrent("integration: supported OpenAI text models", () => {
  for (const model of supportedOpenAiTextModels) {
    it(`${model}: streams text`, async () => {
      const call = streamText({
        model,
        input: "Return exactly: OK",
        ...(isOpenAiModelId(model) || isChatGptModelId(model)
          ? { thinkingLevel: "low" as const }
          : {}),
      });
      const [streamed, result] = await Promise.all([streamToStrings(call), call.result]);

      expect(result.text.toUpperCase()).toContain("OK");
      expect(streamed.response.toUpperCase()).toContain("OK");
      expect(streamed.sawUsage).toBe(true);
      expect(result.usage?.totalTokens).toBeTypeOf("number");
      expect(Number.isFinite(result.costUsd)).toBe(true);
    }, 180_000);

    it(`${model}: returns validated JSON`, async () => {
      const schema = z.object({ ok: z.boolean(), message: z.string() });
      const { value } = await generateJson({
        model,
        input: 'Return exactly this JSON object: {"ok":true,"message":"hello"}. Return only JSON.',
        schema,
        thinkingLevel: "low",
      });

      expect(value.ok).toBe(true);
      expect(value.message).toContain("hello");
    }, 180_000);
  }
});
