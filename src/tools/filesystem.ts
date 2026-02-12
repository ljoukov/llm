import { promises as fs } from "node:fs";
import path from "node:path";

export type AgentPathKind = "file" | "directory" | "symlink" | "other";

export type AgentPathInfo = {
  readonly kind: AgentPathKind;
  readonly mtimeMs: number;
};

export type AgentDirectoryEntry = {
  readonly name: string;
  readonly path: string;
  readonly kind: AgentPathKind;
  readonly mtimeMs: number;
};

export interface AgentFilesystem {
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  ensureDir(directoryPath: string): Promise<void>;
  readDir(directoryPath: string): Promise<readonly AgentDirectoryEntry[]>;
  stat(entryPath: string): Promise<AgentPathInfo>;
}

type InMemoryFileRecord = {
  content: string;
  mtimeMs: number;
};

type InMemoryDirRecord = {
  mtimeMs: number;
};

export class InMemoryAgentFilesystem implements AgentFilesystem {
  readonly #files = new Map<string, InMemoryFileRecord>();
  readonly #dirs = new Map<string, InMemoryDirRecord>();
  #clock = 0;

  constructor(initialFiles: Record<string, string> = {}) {
    const root = path.resolve("/");
    this.#dirs.set(root, { mtimeMs: this.#nextMtime() });
    for (const [filePath, content] of Object.entries(initialFiles)) {
      const absolutePath = path.resolve(filePath);
      this.#ensureDirSync(path.dirname(absolutePath));
      this.#files.set(absolutePath, {
        content,
        mtimeMs: this.#nextMtime(),
      });
    }
  }

  async readTextFile(filePath: string): Promise<string> {
    const absolutePath = path.resolve(filePath);
    const file = this.#files.get(absolutePath);
    if (!file) {
      throw createNoSuchFileError("open", absolutePath);
    }
    return file.content;
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    const parentPath = path.dirname(absolutePath);
    if (!this.#dirs.has(parentPath)) {
      throw createNoSuchFileError("open", parentPath);
    }
    this.#files.set(absolutePath, { content, mtimeMs: this.#nextMtime() });
  }

  async deleteFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    if (!this.#files.delete(absolutePath)) {
      throw createNoSuchFileError("unlink", absolutePath);
    }
  }

  async ensureDir(directoryPath: string): Promise<void> {
    this.#ensureDirSync(path.resolve(directoryPath));
  }

  async readDir(directoryPath: string): Promise<readonly AgentDirectoryEntry[]> {
    const absolutePath = path.resolve(directoryPath);
    const directory = this.#dirs.get(absolutePath);
    if (!directory) {
      throw createNoSuchFileError("scandir", absolutePath);
    }

    const entries: AgentDirectoryEntry[] = [];
    const seenNames = new Set<string>();

    for (const [dirPath, dirRecord] of this.#dirs.entries()) {
      if (dirPath === absolutePath) {
        continue;
      }
      if (path.dirname(dirPath) !== absolutePath) {
        continue;
      }
      const name = path.basename(dirPath);
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      entries.push({
        name,
        path: dirPath,
        kind: "directory",
        mtimeMs: dirRecord.mtimeMs,
      });
    }

    for (const [filePath, fileRecord] of this.#files.entries()) {
      if (path.dirname(filePath) !== absolutePath) {
        continue;
      }
      const name = path.basename(filePath);
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      entries.push({
        name,
        path: filePath,
        kind: "file",
        mtimeMs: fileRecord.mtimeMs,
      });
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }

  async stat(entryPath: string): Promise<AgentPathInfo> {
    const absolutePath = path.resolve(entryPath);
    const file = this.#files.get(absolutePath);
    if (file) {
      return { kind: "file", mtimeMs: file.mtimeMs };
    }
    const directory = this.#dirs.get(absolutePath);
    if (directory) {
      return { kind: "directory", mtimeMs: directory.mtimeMs };
    }
    throw createNoSuchFileError("stat", absolutePath);
  }

  snapshot(): Record<string, string> {
    const entries = [...this.#files.entries()].sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([filePath, record]) => [filePath, record.content]));
  }

  #ensureDirSync(directoryPath: string): void {
    const absolutePath = path.resolve(directoryPath);
    const parts: string[] = [];
    let cursor = absolutePath;
    for (;;) {
      if (this.#dirs.has(cursor)) {
        break;
      }
      parts.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const nextDir = parts[index];
      if (nextDir === undefined) {
        continue;
      }
      if (!this.#dirs.has(nextDir)) {
        this.#dirs.set(nextDir, { mtimeMs: this.#nextMtime() });
      }
    }
  }

  #nextMtime(): number {
    this.#clock += 1;
    return this.#clock;
  }
}

export function createNodeAgentFilesystem(): AgentFilesystem {
  return {
    readTextFile: async (filePath: string) => fs.readFile(filePath, "utf8"),
    writeTextFile: async (filePath: string, content: string) =>
      fs.writeFile(filePath, content, "utf8"),
    deleteFile: async (filePath: string) => fs.unlink(filePath),
    ensureDir: async (directoryPath: string) => {
      await fs.mkdir(directoryPath, { recursive: true });
    },
    readDir: async (directoryPath: string) => {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      const result: AgentDirectoryEntry[] = [];
      for (const entry of entries) {
        const entryPath = path.resolve(directoryPath, entry.name);
        const stats = await fs.lstat(entryPath);
        result.push({
          name: entry.name,
          path: entryPath,
          kind: statsToKind(stats),
          mtimeMs: stats.mtimeMs,
        });
      }
      return result;
    },
    stat: async (entryPath: string) => {
      const stats = await fs.lstat(entryPath);
      return {
        kind: statsToKind(stats),
        mtimeMs: stats.mtimeMs,
      };
    },
  };
}

export function createInMemoryAgentFilesystem(
  initialFiles: Record<string, string> = {},
): InMemoryAgentFilesystem {
  return new InMemoryAgentFilesystem(initialFiles);
}

function statsToKind(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): AgentPathKind {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

function createNoSuchFileError(syscall: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, ${syscall} '${filePath}'`,
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.syscall = syscall;
  error.path = filePath;
  return error;
}
