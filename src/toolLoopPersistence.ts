import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type { LlmToolLoopResult } from "./llm.js";

export type ToolLoopCheckpoint = {
  readonly schema: "llm-tool-loop/v1";
  readonly identity: string;
  readonly fingerprint: string;
  readonly values: Record<string, unknown>;
  readonly models: Record<string, { fingerprint: string; value: unknown }>;
  readonly tools: Record<
    string,
    {
      fingerprint: string;
      toolName: string;
      status: "started" | "completed";
      value?: unknown;
    }
  >;
  readonly result?: LlmToolLoopResult;
};

/** The caller owns atomic storage and exclusive ownership of the run. */
export type ToolLoopPersistence = {
  /** Pin tool implementations, task files, environment and other caller-owned inputs. */
  readonly identity: string;
  readonly load: () => Promise<ToolLoopCheckpoint | null>;
  /** Must commit before resolving; failures stop the loop. Payloads contain model/tool data, not auth. */
  readonly save: (checkpoint: ToolLoopCheckpoint) => Promise<void>;
  /** Opt in only for tools whose interrupted effects can safely be restored or retried. */
  readonly retryInterruptedTools?: readonly string[];
};

export class ToolLoopRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolLoopRecoveryError";
  }
}

// Canonical JSON also detaches data from mutable provider objects. Unsupported values fail closed.
function canonical(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === "function" || typeof item === "bigint" || typeof item === "symbol") {
      throw new ToolLoopRecoveryError("Checkpoint data must be JSON serializable.");
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });
  if (json === undefined)
    throw new ToolLoopRecoveryError("Checkpoint value must not be undefined.");
  return json;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

type Journal = {
  checkpoint: ToolLoopCheckpoint;
  persistence: ToolLoopPersistence;
  queue: Promise<unknown>;
};
const storage = new AsyncLocalStorage<Journal>();

/** A custom tool may start another loop; it must not reuse its parent's journal implicitly. */
export function withoutToolLoopPersistence<T>(run: () => Promise<T>): Promise<T> {
  return storage.exit(run);
}

function clone<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}

async function commit(journal: Journal): Promise<void> {
  await journal.persistence.save(clone(journal.checkpoint));
}

export function hasToolLoopPersistence(): boolean {
  return storage.getStore() !== undefined;
}

export async function withToolLoopPersistence(
  persistence: ToolLoopPersistence,
  request: unknown,
  run: () => Promise<LlmToolLoopResult>,
): Promise<LlmToolLoopResult> {
  if (!persistence.identity.trim())
    throw new ToolLoopRecoveryError("Persistence identity is required.");
  const expected = fingerprint(request);
  const saved = await persistence.load();
  if (
    saved &&
    (saved.schema !== "llm-tool-loop/v1" ||
      saved.identity !== persistence.identity ||
      saved.fingerprint !== expected)
  ) {
    throw new ToolLoopRecoveryError(
      "Checkpoint task, route, tools or settings differ from this run.",
    );
  }
  const checkpoint: ToolLoopCheckpoint = saved
    ? clone(saved)
    : {
        schema: "llm-tool-loop/v1",
        identity: persistence.identity,
        fingerprint: expected,
        values: {},
        models: {},
        tools: {},
      };
  if (checkpoint.result) return clone(checkpoint.result);
  const journal: Journal = { checkpoint, persistence, queue: Promise.resolve() };
  return await storage.run(journal, async () => {
    if (!saved) await commit(journal);
    const result = await run();
    journal.checkpoint = { ...journal.checkpoint, result: clone(result) };
    await commit(journal);
    return result;
  });
}

export async function persistentLoopValue<T>(key: string, create: () => T): Promise<T> {
  const journal = storage.getStore();
  if (!journal) return create();
  if (Object.hasOwn(journal.checkpoint.values, key))
    return clone(journal.checkpoint.values[key]) as T;
  const value = create();
  journal.checkpoint.values[key] = clone(value);
  await commit(journal);
  return value;
}

/** Rebuild native history from recorded responses without making completed model calls again. */
export async function persistentModelCall<T>(
  turn: number,
  request: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const journal = storage.getStore();
  if (!journal) return await call();
  const key = String(turn),
    expected = fingerprint(request);
  const previous = journal.checkpoint.models[key];
  if (previous) {
    if (previous.fingerprint !== expected)
      throw new ToolLoopRecoveryError(`Model request ${turn} changed during recovery.`);
    return clone(previous.value) as T;
  }
  const value = await call();
  journal.checkpoint.models[key] = { fingerprint: expected, value: clone(value) };
  // No runtime tool may execute before its complete model response is durable.
  await commit(journal);
  return value;
}

export async function persistentToolCall<T>(
  key: string,
  toolName: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const journal = storage.getStore();
  if (!journal) return await execute();
  const expected = fingerprint({ toolName, input });
  // Serialize tools while journaling so each saved workspace corresponds to one receipt boundary.
  const operation = journal.queue.then(async () => {
    const previous = journal.checkpoint.tools[key];
    if (previous) {
      if (previous.fingerprint !== expected)
        throw new ToolLoopRecoveryError(`Tool call ${key} changed during recovery.`);
      if (previous.status === "completed") return clone(previous.value) as T;
      if (!journal.persistence.retryInterruptedTools?.includes(toolName)) {
        throw new ToolLoopRecoveryError(
          `Tool ${toolName} (${key}) was interrupted; reconcile its effects before opting into retry.`,
        );
      }
    }
    journal.checkpoint.tools[key] = { fingerprint: expected, toolName, status: "started" };
    await commit(journal);
    const value = await execute();
    journal.checkpoint.tools[key] = {
      fingerprint: expected,
      toolName,
      status: "completed",
      value: clone(value),
    };
    await commit(journal);
    return value;
  });
  // A failed save or execution fences subsequent tool calls in the same batch.
  journal.queue = operation;
  return await operation;
}

/** Use original receipt timestamps when reconstructing completed steps after downtime. */
export function persistentTurnCompletedAt(turn: number, modelCompletedAtMs: number): number {
  const journal = storage.getStore();
  if (!journal) return Date.now();
  let completed = modelCompletedAtMs;
  for (const [key, tool] of Object.entries(journal.checkpoint.tools)) {
    if (!key.startsWith(`turn${turn}/`) || tool.status !== "completed") continue;
    const value = tool.value as { result?: { completedAt?: string } } | undefined;
    const time = Date.parse(value?.result?.completedAt ?? "");
    if (Number.isFinite(time)) completed = Math.max(completed, time);
  }
  return completed;
}
