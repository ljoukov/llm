import type OpenAI from "openai";

import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

import { getVercelClient } from "./client.js";

const DEFAULT_SCHEDULER_KEY = "__default__";
const vercelCallState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.vercelCallState"), () => ({
  schedulerByModel: new Map<string, CallScheduler>(),
}));

function getSchedulerForModel(modelId?: string): CallScheduler {
  const normalizedModelId = modelId?.trim();
  const schedulerKey = normalizedModelId || DEFAULT_SCHEDULER_KEY;
  const existing = vercelCallState.schedulerByModel.get(schedulerKey);
  if (existing) {
    return existing;
  }
  const created = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({
      provider: "vercel",
      modelId: normalizedModelId,
    }),
    minIntervalBetweenStartMs: 200,
    startJitterMs: 200,
  });
  vercelCallState.schedulerByModel.set(schedulerKey, created);
  return created;
}

export async function runVercelCall<T>(
  fn: (client: OpenAI) => Promise<T>,
  modelId?: string,
  runOptions?: CallSchedulerRunOptions,
): Promise<T> {
  return getSchedulerForModel(modelId).run(async () => fn(getVercelClient()), runOptions);
}
