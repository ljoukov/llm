import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { withRetryFetchMetrics } from "../utils/retryFetch.js";
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
  const concurrencyCap = resolveModelConcurrencyCap({
    provider: "anthropic",
    modelId: normalizedModelId,
  });
  const schedulerKey = normalizedModelId || DEFAULT_SCHEDULER_KEY;
  const existing = anthropicCallState.schedulerByModel.get(schedulerKey);
  if (existing) {
    existing.setMaxParallelRequests(concurrencyCap);
    return existing;
  }
  const created = createCallScheduler({
    maxParallelRequests: concurrencyCap,
    initialParallelRequests: concurrencyCap,
  });
  anthropicCallState.schedulerByModel.set(schedulerKey, created);
  return created;
}

export async function runAnthropicCall<T>(
  fn: (client: AnthropicClient) => Promise<T>,
  modelId?: string,
  runOptions?: CallSchedulerRunOptions,
): Promise<T> {
  let fetchMetrics = { retryCount: 0, retryDelayMs: 0, overloadCount: 0 };
  return getSchedulerForModel(modelId).run(
    () =>
      withRetryFetchMetrics(
        async () => fn(getAnthropicClient()),
        (metrics) => {
          fetchMetrics = metrics;
        },
      ),
    {
      ...runOptions,
      onSettled: (metrics) => {
        runOptions?.onSettled?.({
          ...metrics,
          attempts: metrics.attempts + fetchMetrics.retryCount,
          retryDelayMs: metrics.retryDelayMs + fetchMetrics.retryDelayMs,
          overloadCount: metrics.overloadCount + fetchMetrics.overloadCount,
        });
      },
    },
  );
}
