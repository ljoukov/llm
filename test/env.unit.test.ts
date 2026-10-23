import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadEnvFromFile } from "../src/utils/env.js";

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    prev[key] = process.env[key];
    const next = updates[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(updates)) {
      const value = prev[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("env", () => {
  it("loads .env with .env.local and process environment taking precedence", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-env-defaults-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, ".env"),
        "LLM_ENV_BASE=base\nLLM_ENV_LOCAL=base\nLLM_ENV_PROCESS=base\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, ".env.local"),
        "LLM_ENV_LOCAL=local\nLLM_ENV_PROCESS=local\n",
      );
      const loaderUrl = new URL("../src/utils/env.ts", import.meta.url).href;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
          "--input-type=module",
          "-e",
          `import {loadLocalEnv} from ${JSON.stringify(loaderUrl)}; loadLocalEnv(); console.log(JSON.stringify([process.env.LLM_ENV_BASE, process.env.LLM_ENV_LOCAL, process.env.LLM_ENV_PROCESS]));`,
        ],
        { cwd: tmpDir, env: { ...process.env, LLM_ENV_PROCESS: "process" }, encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toEqual(["base", "local", "process"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads .env-style files without overriding existing variables by default", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-env-"));
    const filePath = path.join(tmpDir, ".env.local");
    fs.writeFileSync(
      filePath,
      [
        "# comment",
        "FOO=from-file",
        'export BAR="quoted"',
        "BAZ='single quoted'",
        "TRIM=  spaced  ",
        "WITH_COMMENT=value # trailing comment",
        "",
      ].join("\n"),
      "utf8",
    );

    withEnv(
      {
        FOO: "existing",
        BAR: undefined,
        BAZ: undefined,
        TRIM: undefined,
        WITH_COMMENT: undefined,
      },
      () => {
        loadEnvFromFile(filePath);

        expect(process.env.FOO).toBe("existing");
        expect(process.env.BAR).toBe("quoted");
        expect(process.env.BAZ).toBe("single quoted");
        expect(process.env.TRIM).toBe("spaced");
        expect(process.env.WITH_COMMENT).toBe("value");
      },
    );
  });

  it("supports override=true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-env-"));
    const filePath = path.join(tmpDir, ".env.local");
    fs.writeFileSync(filePath, "FOO=from-file\n", "utf8");

    withEnv({ FOO: "existing" }, () => {
      loadEnvFromFile(filePath, { override: true });
      expect(process.env.FOO).toBe("from-file");
    });
  });
});
