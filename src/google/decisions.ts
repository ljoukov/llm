import type { DecisionInput, DecisionQuestions } from "../decisions/types.js";
import { proxyFetch } from "../utils/proxyFetch.js";
import { runGeminiCall } from "./calls.js";
import { resolveGeminiApiKey } from "./client.js";

const GOOGLE_DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions";
const GOOGLE_DECISIONS_TIMEOUT_MS = 15 * 60_000;

function toGoogleInput(input: DecisionInput): unknown {
  if (typeof input === "string") return input;
  return input.map((content) => {
    if (content.type === "text") return { type: "text", text: content.text };
    const { mimeType, ...rest } = content;
    return { ...rest, mime_type: mimeType };
  });
}

function toGoogleQuestions(questions: DecisionQuestions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => {
      if (question.type !== "boolean") return [name, question];
      return [
        name,
        {
          type: "noul",
          instructions: question.instructions,
          ...(question.criteria
            ? {
                criteria: {
                  true_description: question.criteria.true,
                  false_description: question.criteria.false,
                },
              }
            : {}),
        },
      ];
    }),
  );
}

/** Native Gemini Decisions REST API; Vertex AI does not yet expose this endpoint. */
export async function createGoogleDecision(request: {
  readonly model: string;
  readonly input: DecisionInput;
  readonly questions: DecisionQuestions;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  request.signal?.throwIfAborted();
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Google Decisions requires GEMINI_API_KEY or GOOGLE_API_KEY. Vertex AI access is not supported yet; remove GOOGLE_SERVICE_ACCOUNT_JSON to use the Gemini API key backend.",
    );
  }
  const body = JSON.stringify({
    model: request.model,
    input: toGoogleInput(request.input),
    questions: toGoogleQuestions(request.questions),
  });
  return runGeminiCall(
    async () => {
      const timeoutSignal = AbortSignal.timeout(GOOGLE_DECISIONS_TIMEOUT_MS);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      const response = await proxyFetch(GOOGLE_DECISIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Preserve status and retry headers for the existing Google scheduler.
        throw Object.assign(
          new Error(`Google Decisions request failed with HTTP ${response.status}.`),
          { status: response.status, headers: response.headers },
        );
      }
      return response.json();
    },
    request.model,
    { signal: request.signal },
  );
}
