import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetRuntimeSingletonsForTesting } from "../src/utils/runtimeSingleton.js";
import {
  getMockStorageState,
  installMockStorageEnv,
  resetMockStorageState,
} from "./helpers/mock-storage.js";

vi.mock("@google-cloud/storage", async () => {
  return await import("./helpers/mock-storage.js");
});

describe("files API", () => {
  beforeEach(() => {
    vi.resetModules();
    resetRuntimeSingletonsForTesting();
    resetMockStorageState();
    installMockStorageEnv();
  });

  it("creates canonical GCS-backed files with a 48h TTL by default", async () => {
    const { DEFAULT_FILE_TTL_SECONDS, files } = await import("../src/index.js");

    const stored = await files.create({
      data: "hello",
      filename: "note.txt",
      mimeType: "text/plain",
    });

    const mockStorage = getMockStorageState();
    expect(stored.id).toMatch(/^file_[a-f0-9]{64}$/u);
    expect(stored.filename).toBe("note.txt");
    expect(stored.expires_at).toBe(stored.created_at + DEFAULT_FILE_TTL_SECONDS);
    expect(mockStorage.saveCalls).toHaveLength(1);
    expect(mockStorage.saveCalls[0]?.bucketName).toBe("llm-test-bucket");
    expect(mockStorage.saveCalls[0]?.objectName).toBe(`canonical-files/${stored.id}.txt`);
    expect((mockStorage.saveCalls[0]?.options.metadata as any)?.contentType).toBe("text/plain");
    expect((mockStorage.saveCalls[0]?.options.metadata as any)?.metadata?.purpose).toBe(
      "user_data",
    );
  });

  it("retrieves, serves, and deletes canonical files", async () => {
    const { files } = await import("../src/index.js");

    const created = await files.create({
      data: "hello",
      filename: "note.txt",
      mimeType: "text/plain",
    });
    const stored = await files.retrieve(created.id);
    const content = await files.content(created.id);
    const deleted = await files.delete(created.id);

    expect(stored.filename).toBe("note.txt");
    expect(await content.text()).toBe("hello");
    expect(content.headers.get("content-type")).toBe("text/plain");
    expect(deleted).toEqual({
      id: created.id,
      deleted: true,
      object: "file",
    });
    expect(getMockStorageState().deleteCalls).toEqual([
      {
        bucketName: "llm-test-bucket",
        objectName: `canonical-files/${created.id}.txt`,
      },
    ]);
  });
});
