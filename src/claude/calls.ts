import { resolveModelConcurrencyCap } from "../utils/modelConcurrency.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import {
  createCallScheduler,
  type CallScheduler,
  type CallSchedulerRunOptions,
} from "../utils/scheduler.js";

import { runClaudeQueryImpl, type ClaudeQueryRequest, type ClaudeQueryResult } from "./client.js";

const claudeCallState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.claudeCallState"), () => ({
  schedulerByModel: new Map<string, CallScheduler>(),
  queryScopes: new AsyncLocalStorage<readonly { model: string; active: boolean }[]>(),
}));

/** Subscription sessions are limited separately from Anthropic API requests. */
export async function runClaudeQuery(
  request: ClaudeQueryRequest,
  runOptions?: CallSchedulerRunOptions,
): Promise<ClaudeQueryResult> {
  if (request.signal?.aborted)
    throw new DOMException("The Claude query was aborted.", "AbortError");
  const inheritedScopes = claudeCallState.queryScopes.getStore() ?? [];
  // A tool may await a child using the parent's model. The parent retains its
  // session lease while awaiting tools, so acquiring it again could deadlock.
  if (inheritedScopes.some((scope) => scope.active && scope.model === request.model)) {
    return runClaudeQueryImpl(request);
  }
  let scheduler = claudeCallState.schedulerByModel.get(request.model);
  if (!scheduler) {
    scheduler = createCallScheduler({
      maxParallelRequests: resolveModelConcurrencyCap({
        provider: "claude",
        modelId: request.model,
      }),
    });
    claudeCallState.schedulerByModel.set(request.model, scheduler);
  }
  const scheduled = scheduler.run(async () => {
    const scope = { model: request.model, active: true };
    try {
      return await claudeCallState.queryScopes.run([...inheritedScopes, scope], () =>
        runClaudeQueryImpl(request),
      );
    } finally {
      scope.active = false;
    }
  }, runOptions);
  if (!request.signal) return scheduled;
  const signal = request.signal;
  return new Promise<ClaudeQueryResult>((resolve, reject) => {
    const abort = () => reject(new DOMException("The Claude query was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    scheduled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
import { AsyncLocalStorage } from "node:async_hooks";
