import type { DecisionInput, DecisionQuestions } from "../decisions/types.js";
import { loadLocalEnv } from "../utils/env.js";
import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { proxyFetch } from "../utils/proxyFetch.js";
import { createRetryingFetch, withRetryFetchMetrics } from "../utils/retryFetch.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_TYPESAFE_TIMEOUT_MS = 15 * 60_000;

const typesafeDecisionState = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.typesafeDecisionState"),
  () => ({ schedulerByModel: new Map<string, CallScheduler>() }),
);

const requestFetch = createRetryingFetch(proxyFetch, {
  maxAttempts: 4,
  scope: "typesafe",
});

function getScheduler(model: string): CallScheduler {
  const existing = typesafeDecisionState.schedulerByModel.get(model);
  if (existing) return existing;
  const scheduler = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({ provider: "typesafe", modelId: model }),
  });
  typesafeDecisionState.schedulerByModel.set(model, scheduler);
  return scheduler;
}

function textState(input: DecisionInput): string {
  if (typeof input === "string") return input;
  return input
    .map((part) => {
      if (part.type !== "text") {
        throw new Error(
          `TypeSafe decisions currently support text input only; received ${part.type}.`,
        );
      }
      return part.text;
    })
    .join("");
}

export async function createTypesafeDecision(
  options: {
    readonly model: string;
    readonly input: DecisionInput;
    readonly questions: DecisionQuestions;
  } & CallSchedulerRunOptions,
): Promise<unknown> {
  const state = textState(options.input);
  const questions = Object.fromEntries(
    Object.entries(options.questions).map(([name, question]) => [
      name,
      {
        ...question,
        type: question.type === "boolean" ? "noul" : question.type,
      },
    ]),
  );

  loadLocalEnv();
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY must be provided to access TypeSafe APIs.");
  }
  const baseUrl = process.env.TYPESAFE_BASE_URL?.trim() || DEFAULT_TYPESAFE_BASE_URL;
  const endpoint = new URL("systemone", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const configuredTimeout = Number(process.env.TYPESAFE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TYPESAFE_TIMEOUT_MS;
  const body = JSON.stringify({ model: options.model, state, questions });
  let fetchMetrics = { retryCount: 0, retryDelayMs: 0, overloadCount: 0 };

  return getScheduler(options.model).run(
    () =>
      withRetryFetchMetrics(
        async () => {
          const timeoutSignal = AbortSignal.timeout(timeoutMs);
          const signal = options.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal;
          const response = await requestFetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body,
            signal,
          });
          if (!response.ok) {
            const error = Object.assign(
              new Error(`TypeSafe decision request failed with HTTP ${response.status}.`),
              { status: response.status },
            );
            await response.body?.cancel();
            throw error;
          }
          return response.json();
        },
        (metrics) => {
          fetchMetrics = metrics;
        },
      ),
    {
      signal: options.signal,
      onSettled: (metrics) => {
        options.onSettled?.({
          ...metrics,
          attempts: metrics.attempts + fetchMetrics.retryCount,
          retryDelayMs: metrics.retryDelayMs + fetchMetrics.retryDelayMs,
          overloadCount: metrics.overloadCount + fetchMetrics.overloadCount,
        });
      },
    },
  );
}
