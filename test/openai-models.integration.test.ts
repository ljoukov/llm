import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateJson, streamText } from "../src/index.js";
import {
  assertIntegrationCredentialsForModels,
  integrationModelLabel,
  openAiIntegrationModels,
  openAiIntegrationSpeedVariants,
  resolveIntegrationRequestedModels,
} from "./integration-env.js";

const allSupportedOpenAiTextModels = openAiIntegrationModels();
const requestedOpenAiTextModels = process.env.LLM_INTEGRATION_MODELS?.trim()
  ? resolveIntegrationRequestedModels()
  : allSupportedOpenAiTextModels;
if (
  requestedOpenAiTextModels.length === 0 ||
  requestedOpenAiTextModels.some((ref) => ref.provider !== "openai")
) {
  throw new Error(
    `LLM_INTEGRATION_MODELS must select supported OpenAI text routes; received: ${requestedOpenAiTextModels.map(integrationModelLabel).join(", ")}`,
  );
}
const supportedOpenAiTextModels = openAiIntegrationSpeedVariants(requestedOpenAiTextModels);
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
    it(`${integrationModelLabel(model)}: streams text`, async () => {
      const call = streamText({
        ...model,
        input: "Return exactly: OK",
        thinkingLevel: "low",
      });
      const [streamed, result] = await Promise.all([streamToStrings(call), call.result]);

      expect(result.text.toUpperCase()).toContain("OK");
      expect(streamed.response.toUpperCase()).toContain("OK");
      expect(streamed.sawUsage).toBe(true);
      expect(result.usage?.totalTokens).toBeTypeOf("number");
      expect(result.provider).toBe("openai");
      expect(result.access).toBe(model.access ?? "api");
      expect(result.requestedSpeed).toBe(model.speed);
      expect(result.modelVersion).not.toMatch(/-fast$/u);
      if (model.access === "subscription") {
        expect(result.costUsd).toBeNull();
        expect(result.costSource).toBe("subscription");
        expect(Number.isFinite(result.apiEquivalentCostUsd)).toBe(true);
      } else {
        expect(Number.isFinite(result.costUsd)).toBe(true);
      }
    }, 180_000);

    it(`${integrationModelLabel(model)}: returns validated JSON`, async () => {
      const schema = z.object({ ok: z.boolean(), message: z.string() });
      const { value } = await generateJson({
        ...model,
        input: 'Return exactly this JSON object: {"ok":true,"message":"hello"}. Return only JSON.',
        schema,
        thinkingLevel: "low",
      });

      expect(value.ok).toBe(true);
      expect(value.message).toContain("hello");
    }, 180_000);
  }
});
