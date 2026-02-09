import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
