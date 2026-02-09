import type OpenAI from "openai";

import { createCallScheduler } from "../utils/scheduler.js";

import { getOpenAiClient } from "./client.js";

export type OpenAiReasoningEffort = "low" | "medium" | "high" | "xhigh";
export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAiReasoningEffort = "medium";

const scheduler = createCallScheduler({
  maxParallelRequests: 3,
  minIntervalBetweenStartMs: 200,
  startJitterMs: 200,
});

export async function runOpenAiCall<T>(fn: (client: OpenAI) => Promise<T>): Promise<T> {
  return scheduler.run(async () => fn(getOpenAiClient()));
}
