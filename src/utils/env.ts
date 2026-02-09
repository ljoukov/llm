import fs from "node:fs";
import path from "node:path";

let envLoaded = false;

/**
 * Loads `.env.local` from `process.cwd()` once.
 *
 * - Does not override already-set `process.env` values.
 * - Missing file is silently ignored.
 */
export function loadLocalEnv(): void {
  if (envLoaded) {
    return;
  }
  const envPath = path.join(process.cwd(), ".env.local");
  loadEnvFromFile(envPath, { override: false });
  envLoaded = true;
}

export function loadEnvFromFile(
  filePath: string,
  { override = false }: { override?: boolean } = {},
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const line of content.split(/\r?\n/u)) {
    const entry = parseEnvLine(line);
    if (!entry) {
      continue;
    }
    const [key, value] = entry;
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_\-.]*)\s*=\s*(.*)$/u);
  if (!match) {
    return null;
  }

  const key = match[1];
  if (!key) {
    return null;
  }
  let value = match[2] ?? "";

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex);
    }
    value = value.trim();
  }

  return [key, value];
}
