import { describe, expect, it } from "vitest";

import { createInMemoryAgentFilesystem } from "../src/tools/filesystem.js";
import {
  createCodexApplyPatchTool,
  createFilesystemToolSetForModel,
  createGlobTool,
  createRgSearchTool,
  createListDirectoryTool,
  createReadFilesTool,
  createReplaceTool,
  createWriteFileTool,
  resolveFilesystemToolProfile,
} from "../src/tools/filesystemTools.js";

describe("filesystemTools profiles", () => {
  it("resolves profile by model when profile=auto", () => {
    expect(resolveFilesystemToolProfile("chatgpt-gpt-5.3-codex")).toBe("codex");
    expect(resolveFilesystemToolProfile("gemini-2.5-pro")).toBe("gemini");
    expect(resolveFilesystemToolProfile("gpt-5.2")).toBe("model-agnostic");
  });

  it("creates codex toolset for codex model ids", () => {
    const toolSet = createFilesystemToolSetForModel("chatgpt-gpt-5.3-codex");
    expect(Object.keys(toolSet).sort()).toEqual([
      "apply_patch",
      "grep_files",
      "list_dir",
      "read_file",
    ]);
  });

  it("creates gemini-style toolset for gemini model ids", () => {
    const toolSet = createFilesystemToolSetForModel("gemini-2.5-pro");
    expect(Object.keys(toolSet).sort()).toEqual([
      "glob",
      "grep_search",
      "list_directory",
      "read_file",
      "replace",
      "write_file",
    ]);
  });
});

describe("filesystemTools behavior", () => {
  it("writes, reads, replaces, lists, greps, and globs with AgentFilesystem", async () => {
    const fs = createInMemoryAgentFilesystem();
    const cwd = "/repo";

    const writeFile = createWriteFileTool({ cwd, fs });
    await writeFile.execute({
      file_path: "src/example.ts",
      content: "export const value = 1;\n",
    });

    const readFiles = createReadFilesTool({ cwd, fs });
    expect(
      await readFiles.execute({
        paths: ["src/example.ts"],
      }),
    ).toContain("L1: export const value = 1;");

    const replace = createReplaceTool({ cwd, fs });
    await replace.execute({
      file_path: "src/example.ts",
      instruction: "Change the constant.",
      old_string: "value = 1",
      new_string: "value = 2",
    });

    const listDirectory = createListDirectoryTool({ cwd, fs });
    expect(
      await listDirectory.execute({
        dir_path: "src",
      }),
    ).toBe("example.ts");

    expect(listDirectory.inputSchema.safeParse({ dir_path: "src", ignore: null }).success).toBe(
      true,
    );
    expect(
      await listDirectory.execute({
        dir_path: "src",
        ignore: null,
        file_filtering_options: null,
      }),
    ).toBe("example.ts");

    const rgSearch = createRgSearchTool({ cwd, fs });
    expect(
      await rgSearch.execute({
        pattern: "value\\s*=\\s*2",
        path: "src",
      }),
    ).toContain("src/example.ts:1:export const value = 2;");

    const glob = createGlobTool({ cwd, fs });
    expect(
      await glob.execute({
        pattern: "**/*.ts",
        dir_path: cwd,
      }),
    ).toContain("/repo/src/example.ts");
  });

  it("applies Codex-style apply_patch through filesystem tool wrapper", async () => {
    const fs = createInMemoryAgentFilesystem({
      "/repo/example.ts": "export const value = 1;\n",
    });

    const applyPatchTool = createCodexApplyPatchTool({ cwd: "/repo", fs });
    expect((applyPatchTool as any).type).toBe("custom");
    expect((applyPatchTool as any).format?.type).toBe("grammar");
    const summary = await applyPatchTool.execute(
      [
        "*** Begin Patch",
        "*** Update File: example.ts",
        "@@",
        "-export const value = 1;",
        "+export const value = 2;",
        "*** End Patch",
      ].join("\n"),
    );

    expect(summary).toContain("M example.ts");
    expect(fs.snapshot()).toEqual({
      "/repo/example.ts": "export const value = 2;\n",
    });
  });
});
