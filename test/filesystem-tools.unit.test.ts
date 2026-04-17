import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

import { createInMemoryAgentFilesystem } from "../src/tools/filesystem.js";
import {
  createCodexReadFileTool,
  createCodexApplyPatchTool,
  createViewImageTool,
  createFilesystemToolSetForModel,
  createGeminiReadFileTool,
  createGlobTool,
  createListDirTool,
  createRgSearchTool,
  createListDirectoryTool,
  createReplaceTool,
  createWriteFileTool,
  resolveFilesystemToolProfile,
} from "../src/tools/filesystemTools.js";

describe("filesystemTools profiles", () => {
  it("resolves profile by model when profile=auto", () => {
    expect(resolveFilesystemToolProfile("gpt-5.4")).toBe("codex");
    expect(resolveFilesystemToolProfile("chatgpt-gpt-5.4")).toBe("codex");
    expect(resolveFilesystemToolProfile("chatgpt-gpt-5.4-fast")).toBe("codex");
    expect(resolveFilesystemToolProfile("chatgpt-gpt-5.3-codex-spark")).toBe("codex");
    expect(resolveFilesystemToolProfile("experimental-chatgpt-private-model")).toBe("codex");
    expect(resolveFilesystemToolProfile("gemini-2.5-pro")).toBe("gemini");
    expect(resolveFilesystemToolProfile("gemini-3.1-pro-preview")).toBe("gemini");
    expect(resolveFilesystemToolProfile("gpt-5.4-mini")).toBe("model-agnostic");
    expect(resolveFilesystemToolProfile("chatgpt-gpt-5.4-mini")).toBe("model-agnostic");
  });

  it("creates codex toolset for codex-like model ids", () => {
    const toolSet = createFilesystemToolSetForModel("chatgpt-gpt-5.4");
    expect(Object.keys(toolSet).sort()).toEqual([
      "apply_patch",
      "grep_files",
      "list_dir",
      "read_file",
      "view_image",
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

    const codexReadFile = createCodexReadFileTool({ cwd, fs });
    expect(
      codexReadFile.inputSchema.safeParse({
        file_path: "src/example.ts",
        offset: null,
        limit: null,
      }).success,
    ).toBe(true);
    expect(
      await codexReadFile.execute({
        file_path: "src/example.ts",
        offset: null,
        limit: null,
      }),
    ).toContain("L1: export const value = 1;");
    expect(
      codexReadFile.inputSchema.safeParse({
        file_path: "src/example.ts",
      }).success,
    ).toBe(true);
    expect(
      await codexReadFile.execute({
        file_path: "src/example.ts",
      }),
    ).toContain("L1: export const value = 1;");
    expect(
      codexReadFile.inputSchema.safeParse({
        path: "src/example.ts",
        file_path: null,
      }).success,
    ).toBe(true);
    const parsedFromPathAlias = codexReadFile.inputSchema.parse({
      path: "src/example.ts",
      file_path: null,
    });
    expect(await codexReadFile.execute(parsedFromPathAlias)).toContain(
      "L1: export const value = 1;",
    );
    expect(
      codexReadFile.inputSchema.safeParse({
        file_path: "src/example.ts",
        path: "src/example.ts",
      }).success,
    ).toBe(true);
    expect(
      codexReadFile.inputSchema.safeParse({
        file_path: "src/example.ts",
        path: "src/other.ts",
      }).success,
    ).toBe(false);
    expect(
      codexReadFile.inputSchema.safeParse({
        file_path: "src/example.ts",
        mode: "base64",
      }).success,
    ).toBe(false);

    const codexListDir = createListDirTool({ cwd, fs });
    expect(
      codexListDir.inputSchema.safeParse({
        dir_path: "src",
        offset: null,
        limit: null,
        depth: null,
      }).success,
    ).toBe(true);
    expect(
      await codexListDir.execute({
        dir_path: "src",
        offset: null,
        limit: null,
        depth: null,
      }),
    ).toContain("example.ts");

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

    expect(
      listDirectory.inputSchema.safeParse({
        dir_path: "src",
        file_filtering_options: {
          respect_git_ignore: null,
          respect_gemini_ignore: null,
        },
      }).success,
    ).toBe(true);

    const geminiReadFile = createGeminiReadFileTool({ cwd, fs });
    expect(
      geminiReadFile.inputSchema.safeParse({ file_path: "src/example.ts", limit: null }).success,
    ).toBe(true);
    expect(
      await geminiReadFile.execute({
        file_path: "src/example.ts",
        offset: null,
        limit: null,
      }),
    ).toContain("L1: export const value = 2;");

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
    ).toContain("src/example.ts");
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

  it("returns input_image items for supported images and input_text fallback otherwise", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-view-image-"));
    try {
      const pngPath = path.join(tempRoot, "pixel.png");
      const txtPath = path.join(tempRoot, "note.txt");
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
        "base64",
      );
      await fs.writeFile(pngPath, pngBytes);
      await fs.writeFile(txtPath, "hello");

      const viewImage = createViewImageTool({ cwd: tempRoot });
      const imageOutput = await viewImage.execute({ path: "pixel.png" });
      expect(imageOutput).toHaveLength(1);
      expect(imageOutput[0]).toMatchObject({ type: "input_image" });
      const imageUrl = (imageOutput[0] as { image_url?: string }).image_url;
      expect(typeof imageUrl).toBe("string");
      expect(imageUrl?.startsWith("data:image/png;base64,")).toBe(true);

      const originalViewImage = createViewImageTool({
        cwd: tempRoot,
        mediaResolution: "original",
      });
      const originalOutput = await originalViewImage.execute({ path: "pixel.png" });
      expect(originalOutput[0]).toMatchObject({
        type: "input_image",
        detail: "original",
      });

      const fallbackOutput = await viewImage.execute({ path: "note.txt" });
      expect(fallbackOutput).toHaveLength(1);
      expect(fallbackOutput[0]).toMatchObject({ type: "input_text" });
      const fallbackText = (fallbackOutput[0] as { text?: string }).text;
      expect(fallbackText).toContain("unsupported image format");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects binary assets in codex read_file", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-read-file-asset-"));
    try {
      const pngPath = path.join(tempRoot, "pixel.png");
      const pngNoExtPath = path.join(tempRoot, "pixel-no-ext");
      const pdfPath = path.join(tempRoot, "document.pdf");
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
        "base64",
      );
      const pdfBytes = Buffer.from("%PDF-1.4\n%tiny\n", "utf8");
      await fs.writeFile(pngPath, pngBytes);
      await fs.writeFile(pngNoExtPath, pngBytes);
      await fs.writeFile(pdfPath, pdfBytes);

      const readFile = createCodexReadFileTool({ cwd: tempRoot });

      await expect(
        readFile.execute({
          file_path: "pixel.png",
          offset: null,
          limit: null,
        }),
      ).rejects.toThrow("is an image");

      await expect(
        readFile.execute({
          file_path: "pixel-no-ext",
          offset: null,
          limit: null,
        }),
      ).rejects.toThrow("is an image");

      await expect(
        readFile.execute({
          file_path: "document.pdf",
          offset: null,
          limit: null,
        }),
      ).rejects.toThrow("is a PDF");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
