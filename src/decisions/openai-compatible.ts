import { runFireworksCall } from "../fireworks/calls.js";
import { runOpenAiCall } from "../openai/calls.js";
import type { DecisionInput, DecisionQuestion, DecisionQuestions } from "./types.js";

type OpenAiCompatibleDecisionOptions = {
  readonly provider: "openai" | "fireworks";
  readonly model: string;
  readonly input: DecisionInput;
  readonly questions: DecisionQuestions;
  readonly signal?: AbortSignal;
};

function predicateInstructions(question: Extract<DecisionQuestion, { type: "boolean" }>): string {
  const descriptions = [question.instructions];
  if (question.criteria?.true !== undefined) {
    descriptions.push(`True: ${question.criteria.true}`);
  }
  if (question.criteria?.false !== undefined) {
    descriptions.push(`False: ${question.criteria.false}`);
  }
  return descriptions.join("\n");
}

function toNativeInput(
  input: DecisionInput,
  provider: OpenAiCompatibleDecisionOptions["provider"],
): string | readonly { readonly role: "user"; readonly content: readonly unknown[] }[] {
  if (typeof input === "string") return input;
  const content = input.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (provider === "fireworks") {
      throw new Error("Fireworks decision models support text input only.");
    }
    if (part.type !== "image") {
      throw new Error(`OpenAI decisions do not support ${part.type} input.`);
    }
    if (part.resolution !== undefined && part.resolution !== "low" && part.resolution !== "high") {
      throw new Error("OpenAI decision image resolution must be low or high.");
    }
    const imageUrl =
      part.uri ?? (part.data ? `data:${part.mimeType};base64,${part.data}` : undefined);
    if (!imageUrl || !/^(?:https?:\/\/|data:)/u.test(imageUrl)) {
      throw new Error("OpenAI decision images require an HTTP(S) URI or inline base64 data.");
    }
    return {
      type: "input_image",
      image_url: imageUrl,
      ...(part.resolution === undefined ? {} : { detail: part.resolution }),
    };
  });
  return [{ role: "user", content }];
}

/** Invoke the providers' native Decisions endpoint without generating or parsing text. */
export async function createOpenAiCompatibleDecision(
  options: OpenAiCompatibleDecisionOptions,
): Promise<unknown> {
  const input = toNativeInput(options.input, options.provider);
  const questions = Object.entries(options.questions).map(([name, question]) => {
    if (question.type === "boolean") {
      return { name, type: "predicate", instructions: predicateInstructions(question) };
    }
    if (question.type === "choice") {
      return {
        name,
        type: "choice",
        instructions: question.instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          description,
        })),
      };
    }
    return {
      name,
      type: "score",
      instructions: question.instructions,
      levels: question.criteria.map((label) => ({ label })),
    };
  });
  const runCall = options.provider === "openai" ? runOpenAiCall : runFireworksCall;
  return runCall(
    async (client) =>
      await client.post<unknown>("/decisions", {
        body: { model: options.model, input, questions },
        signal: options.signal,
      }),
    options.model,
    { signal: options.signal },
  );
}
