import type OpenAI from "openai";

import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

import { getXaiClient } from "./client.js";
import type { XaiAccess } from "./models.js";

const xaiCallState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.xaiCallState"), () => ({
  schedulerByRoute: new Map<string, CallScheduler>(),
}));

function schedulerFor(modelId: string | undefined, access: XaiAccess): CallScheduler {
  const key = `${access}:${modelId?.trim() || "__default__"}`;
  const existing = xaiCallState.schedulerByRoute.get(key);
  if (existing) return existing;
  const scheduler = createCallScheduler({
    maxParallelRequests: resolveModelConcurrencyCap({
      provider: "xai",
      modelId,
      defaultCap: access === "subscription" ? 2 : 6,
    }),
    minIntervalBetweenStartMs: 200,
    startJitterMs: 200,
  });
  xaiCallState.schedulerByRoute.set(key, scheduler);
  return scheduler;
}

export async function runXaiCall<T>(
  fn: (client: OpenAI) => Promise<T>,
  modelId?: string,
  access: XaiAccess = "api",
  runOptions?: CallSchedulerRunOptions,
): Promise<T> {
  return await schedulerFor(modelId, access).run(
    async () => await fn(await getXaiClient(modelId, access)),
    runOptions,
  );
}
