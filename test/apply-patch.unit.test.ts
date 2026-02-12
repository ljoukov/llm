import { describe, expect, it, vi } from "vitest";

import { applyPatch, createApplyPatchTool } from "../src/tools/applyPatch.js";
import { createInMemoryAgentFilesystem } from "../src/tools/filesystem.js";

describe("applyPatch", () => {
  it("adds a new file in the in-memory filesystem", async () => {
    const filesystem = createInMemoryAgentFilesystem();
    const result = await applyPatch({
      cwd: "/repo",
      fs: filesystem,
      patch: [
        "*** Begin Patch",
        "*** Add File: notes/todo.txt",
        "+line one",
        "+line two",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.added).toEqual(["notes/todo.txt"]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.summary).toContain("A notes/todo.txt");
    expect(filesystem.snapshot()).toEqual({
      "/repo/notes/todo.txt": "line one\nline two\n",
    });
  });

  it("updates and moves a file", async () => {
    const filesystem = createInMemoryAgentFilesystem({
      "/repo/src/file.txt": "alpha\nbeta\n",
    });

    const result = await applyPatch({
      cwd: "/repo",
      fs: filesystem,
      patch: [
        "*** Begin Patch",
        "*** Update File: src/file.txt",
        "*** Move to: dst/file.txt",
        "@@",
        " alpha",
        "-beta",
        "+gamma",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.added).toEqual([]);
    expect(result.modified).toEqual(["dst/file.txt"]);
    expect(result.deleted).toEqual([]);
    expect(filesystem.snapshot()).toEqual({
      "/repo/dst/file.txt": "alpha\ngamma\n",
    });
  });

  it("deletes an existing file", async () => {
    const filesystem = createInMemoryAgentFilesystem({
      "/repo/remove-me.txt": "temp\n",
    });

    const result = await applyPatch({
      cwd: "/repo",
      fs: filesystem,
      patch: ["*** Begin Patch", "*** Delete File: remove-me.txt", "*** End Patch"].join("\n"),
    });

    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual(["remove-me.txt"]);
    expect(filesystem.snapshot()).toEqual({});
  });

  it("rejects paths outside cwd by default", async () => {
    const filesystem = createInMemoryAgentFilesystem();
    await expect(
      applyPatch({
        cwd: "/repo",
        fs: filesystem,
        patch: ["*** Begin Patch", "*** Add File: ../escape.txt", "+unsafe", "*** End Patch"].join(
          "\n",
        ),
      }),
    ).rejects.toThrow('resolves outside cwd "/repo"');
  });

  it("calls access hook for policy checks", async () => {
    const filesystem = createInMemoryAgentFilesystem();
    const hook = vi.fn((context: { path: string }) => {
      if (context.path.endsWith("/blocked.txt")) {
        throw new Error("blocked by policy");
      }
    });

    await expect(
      applyPatch({
        cwd: "/repo",
        fs: filesystem,
        checkAccess: hook,
        patch: ["*** Begin Patch", "*** Add File: blocked.txt", "+content", "*** End Patch"].join(
          "\n",
        ),
      }),
    ).rejects.toThrow("blocked by policy");
    expect(hook).toHaveBeenCalled();
  });
});

describe("createApplyPatchTool", () => {
  it("returns a tool executable with apply_patch schema", async () => {
    const filesystem = createInMemoryAgentFilesystem({
      "/repo/a.txt": "before\n",
    });
    const applyPatchTool = createApplyPatchTool({
      cwd: "/repo",
      fs: filesystem,
    });

    const output = await applyPatchTool.execute({
      input: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n"),
    });

    expect(output.success).toBe(true);
    expect(output.modified).toEqual(["a.txt"]);
    expect(filesystem.snapshot()).toEqual({
      "/repo/a.txt": "after\n",
    });
  });
});
