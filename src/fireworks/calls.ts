import type OpenAI from "openai";

import { createCallScheduler } from "../utils/scheduler.js";

import { getFireworksClient } from "./client.js";

const scheduler = createCallScheduler({
  maxParallelRequests: 3,
  minIntervalBetweenStartMs: 200,
  startJitterMs: 200,
});

export async function runFireworksCall<T>(fn: (client: OpenAI) => Promise<T>): Promise<T> {
  return scheduler.run(async () => fn(getFireworksClient()));
}
