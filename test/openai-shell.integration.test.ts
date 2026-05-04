import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateText, type LlmTextModelId } from "../src/index.js";
import { assertIntegrationCredentialsForModels } from "./integration-env.js";

const shellModel = "gpt-5.5" satisfies LlmTextModelId;

assertIntegrationCredentialsForModels([shellModel]);

describe("integration: OpenAI shell tool", () => {
  it("runs a hosted shell command and returns its output", async () => {
    const nonce = `llm-shell-${randomBytes(16).toString("hex")}`;
    const expectedDigest = createHash("sha256").update(nonce, "utf8").digest("hex");

    const result = await generateText({
      model: shellModel,
      thinkingLevel: "low",
      tools: [{ type: "shell" }],
      input:
        "Use the shell tool to run Python and compute the SHA-256 hex digest of this exact UTF-8 string: " +
        `${nonce}\nReturn only the digest.`,
    });

    expect(result.provider).toBe("openai");
    expect(result.text.toLowerCase()).toContain(expectedDigest);
  }, 240_000);
});
