import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function importModuleCopy<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

describe("runtime singletons", () => {
  it("shares agent logging sessions across duplicate module instances", async () => {
    const [
      { createAgentLoggingSession, runWithAgentLoggingSession },
      { getCurrentAgentLoggingSession },
    ] = await Promise.all([
      importModuleCopy<typeof import("../src/agentLogging.js")>(
        "../src/agentLogging.js?copy=logging-session-a",
      ),
      importModuleCopy<typeof import("../src/agentLogging.js")>(
        "../src/agentLogging.js?copy=logging-session-b",
      ),
    ]);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-runtime-singletons-"));
    try {
      const session = createAgentLoggingSession({
        workspaceDir: tempRoot,
        mirrorToConsole: false,
      });
      await runWithAgentLoggingSession(session, async () => {
        expect(getCurrentAgentLoggingSession()).toBe(session);
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("shares configured model concurrency across duplicate module instances", async () => {
    const [
      { configureModelConcurrency, resetModelConcurrencyConfig },
      { resolveModelConcurrencyCap },
    ] = await Promise.all([
      importModuleCopy<typeof import("../src/utils/modelConcurrency.js")>(
        "../src/utils/modelConcurrency.js?copy=model-concurrency-a",
      ),
      importModuleCopy<typeof import("../src/utils/modelConcurrency.js")>(
        "../src/utils/modelConcurrency.js?copy=model-concurrency-b",
      ),
    ]);
    configureModelConcurrency({
      providerCaps: {
        openai: 7,
      },
    });
    try {
      expect(resolveModelConcurrencyCap({ provider: "openai" })).toBe(7);
    } finally {
      resetModelConcurrencyConfig();
    }
  });
});
