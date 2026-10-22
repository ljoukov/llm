import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

import { type AnthropicClient, getAnthropicClient } from "./client.js";

const DEFAULT_SCHEDULER_KEY = "__default__";
const anthropicCallState = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.anthropicCallState"),
  () => ({ schedulerByModel: new Map<string, CallScheduler>() }),
);

function getSchedulerForModel(modelId?: string): CallScheduler {
  const normalizedModelId = modelId?.trim();
  const schedulerKey = normalizedModelId || DEFAULT_SCHEDULER_KEY;
  const existing = anthropicCallState.schedulerByModel.get(schedulerKey);
  if (existing) {
    return existing;
  }
  const created = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({
      provider: "anthropic",
      modelId: normalizedModelId,
    }),
    minIntervalBetweenStartMs: 200,
    startJitterMs: 200,
  });
  anthropicCallState.schedulerByModel.set(schedulerKey, created);
  return created;
}

export async function runAnthropicCall<T>(
  fn: (client: AnthropicClient) => Promise<T>,
  modelId?: string,
  runOptions?: CallSchedulerRunOptions,
): Promise<T> {
  return getSchedulerForModel(modelId).run(async () => fn(getAnthropicClient()), runOptions);
}
