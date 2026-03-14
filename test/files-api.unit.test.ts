import { describe, expect, it, vi } from "vitest";

let createBodies: any[] = [];
let retrieveIds: string[] = [];
let deleteIds: string[] = [];

vi.mock("../src/openai/client.js", () => ({
  getOpenAiClient: () => ({
    files: {
      create: async (body: any) => {
        createBodies.push(body);
        return {
          id: "file_123",
          bytes: body?.file?.size ?? 0,
          created_at: 1,
          filename: body?.file?.name ?? "uploaded.bin",
          object: "file",
          purpose: body?.purpose ?? "user_data",
          status: "processed",
          expires_at: 1 + 48 * 60 * 60,
        };
      },
      retrieve: async (fileId: string) => {
        retrieveIds.push(fileId);
        return {
          id: fileId,
          bytes: 5,
          created_at: 1,
          filename: "note.txt",
          object: "file",
          purpose: "user_data",
          status: "processed",
          expires_at: 1 + 48 * 60 * 60,
        };
      },
      delete: async (fileId: string) => {
        deleteIds.push(fileId);
        return {
          id: fileId,
          deleted: true,
          object: "file",
        };
      },
      content: async () =>
        new Response(Buffer.from("hello"), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    },
    uploads: {
      create: async () => ({ id: "upload_123" }),
      parts: {
        create: async (_uploadId: string, _body: any) => ({ id: "part_123" }),
      },
      complete: async () => ({ file: { id: "file_123" } }),
    },
  }),
}));

describe("files API", () => {
  it("creates canonical OpenAI files with a 48h TTL by default", async () => {
    createBodies = [];
    const { DEFAULT_FILE_TTL_SECONDS, files } = await import("../src/index.js");

    const stored = await files.create({
      data: "hello",
      filename: "note.txt",
      mimeType: "text/plain",
    });

    expect(stored.id).toBe("file_123");
    expect(stored.filename).toBe("note.txt");
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]?.purpose).toBe("user_data");
    expect(createBodies[0]?.expires_after).toEqual({
      anchor: "created_at",
      seconds: DEFAULT_FILE_TTL_SECONDS,
    });
  });

  it("retrieves and deletes canonical files", async () => {
    retrieveIds = [];
    deleteIds = [];
    const { files } = await import("../src/index.js");

    const stored = await files.retrieve("file_123");
    const deleted = await files.delete("file_123");

    expect(stored.filename).toBe("note.txt");
    expect(retrieveIds).toEqual(["file_123"]);
    expect(deleted).toEqual({
      id: "file_123",
      deleted: true,
      object: "file",
    });
    expect(deleteIds).toEqual(["file_123"]);
  });
});
