import type OpenAI from "openai";

import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

import { getOpenAiClient } from "./client.js";

export type OpenAiReasoningEffort = "low" | "medium" | "high" | "xhigh";
export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAiReasoningEffort = "medium";

const DEFAULT_SCHEDULER_KEY = "__default__";
const schedulerByModel = new Map<string, CallScheduler>();

function getSchedulerForModel(modelId?: string): CallScheduler {
  const normalizedModelId = modelId?.trim();
  const schedulerKey =
    normalizedModelId && normalizedModelId.length > 0 ? normalizedModelId : DEFAULT_SCHEDULER_KEY;
  const existing = schedulerByModel.get(schedulerKey);
  if (existing) {
    return existing;
  }
  const created = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({
      providerEnvPrefix: "OPENAI",
      modelId: normalizedModelId,
    }),
    minIntervalBetweenStartMs: 200,
    startJitterMs: 200,
  });
  schedulerByModel.set(schedulerKey, created);
  return created;
}

export async function runOpenAiCall<T>(
  fn: (client: OpenAI) => Promise<T>,
  modelId?: string,
  runOptions?: CallSchedulerRunOptions,
): Promise<T> {
  return getSchedulerForModel(modelId).run(async () => fn(getOpenAiClient()), runOptions);
}
