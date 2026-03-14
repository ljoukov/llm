import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer, File as NodeFile } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdir, mkdtemp, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { GoogleGenAI } from "@google/genai";
import { Storage } from "@google-cloud/storage";
import type OpenAI from "openai";
import mime from "mime";

import { getCurrentAgentLoggingSession } from "./agentLogging.js";
import { getGoogleServiceAccount } from "./google/auth.js";
import { getGeminiClient } from "./google/client.js";
import { getOpenAiClient } from "./openai/client.js";
import { getRuntimeSingleton } from "./utils/runtimeSingleton.js";

export const DEFAULT_FILE_TTL_SECONDS = 48 * 60 * 60;
const OPENAI_FILE_CREATE_MAX_BYTES = 512 * 1024 * 1024;
const OPENAI_UPLOAD_PART_MAX_BYTES = 64 * 1024 * 1024;
const GEMINI_FILE_POLL_INTERVAL_MS = 1_000;
const GEMINI_FILE_POLL_TIMEOUT_MS = 60_000;
const FILES_TEMP_ROOT = path.join(os.tmpdir(), "ljoukov-llm-files");

export type LlmFilePurpose = "user_data";

export type LlmStoredFile = {
  readonly id: string;
  readonly bytes: number;
  readonly created_at: number;
  readonly filename: string;
  readonly object: "file";
  readonly purpose: LlmFilePurpose;
  readonly status: "uploaded" | "processed" | "error";
  readonly expires_at?: number;
};

export type LlmFileDeleted = {
  readonly id: string;
  readonly deleted: boolean;
  readonly object: "file";
};

export type LlmFileUploadSource =
  | "files_api"
  | "prompt_inline_offload"
  | "tool_output_spill"
  | "provider_mirror";

export type LlmFileUploadBackend = "openai" | "gemini" | "vertex";

export type LlmFileUploadMode = "files.create" | "uploads" | "mirror";

export type LlmFileUploadEvent = {
  readonly timestamp: string;
  readonly source: LlmFileUploadSource;
  readonly backend: LlmFileUploadBackend;
  readonly mode: LlmFileUploadMode;
  readonly filename: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly mimeType?: string;
  readonly fileId?: string;
  readonly mirrorId?: string;
  readonly fileUri?: string;
};

export type LlmFileUploadMetrics = {
  readonly count: number;
  readonly totalBytes: number;
  readonly totalLatencyMs: number;
  readonly events: readonly LlmFileUploadEvent[];
};

export type LlmFileCreateParams =
  | {
      readonly path: string;
      readonly filename?: string;
      readonly mimeType?: string;
      readonly purpose?: LlmFilePurpose;
      readonly expiresAfterSeconds?: number;
    }
  | {
      readonly data: string | ArrayBuffer | ArrayBufferView;
      readonly filename: string;
      readonly mimeType?: string;
      readonly purpose?: LlmFilePurpose;
      readonly expiresAfterSeconds?: number;
    };

type CachedFileMetadata = {
  readonly file: LlmStoredFile;
  readonly filename: string;
  readonly bytes: number;
  readonly mimeType?: string;
  readonly sha256Hex?: string;
  readonly localPath?: string;
};

type CachedGeminiMirror = {
  readonly openAiFileId: string;
  readonly name: string;
  readonly uri: string;
  readonly mimeType: string;
  readonly displayName: string;
};

type CachedVertexMirror = {
  readonly openAiFileId: string;
  readonly bucket: string;
  readonly objectName: string;
  readonly fileUri: string;
  readonly mimeType: string;
};

type MaterializedOpenAiFile = {
  readonly file: LlmStoredFile;
  readonly filename: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sha256Hex: string;
  readonly localPath: string;
};

type FileUploadCollector = {
  readonly events: LlmFileUploadEvent[];
};

type FileUploadScope = {
  readonly collectors: readonly FileUploadCollector[];
  readonly source?: LlmFileUploadSource;
};

const filesState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.filesState"), () => ({
  metadataById: new Map<string, CachedFileMetadata>(),
  openAiUploadCacheByKey: new Map<string, CachedFileMetadata>(),
  materializedById: new Map<string, Promise<MaterializedOpenAiFile>>(),
  geminiMirrorById: new Map<string, CachedGeminiMirror>(),
  vertexMirrorById: new Map<string, CachedVertexMirror>(),
  storageClient: undefined as Storage | undefined,
  geminiClientPromise: undefined as Promise<GoogleGenAI> | undefined,
}));

const fileUploadScopeStorage = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.fileUploadScopeStorage"),
  () => new AsyncLocalStorage<FileUploadScope>(),
);

function summarizeUploadEvents(events: readonly LlmFileUploadEvent[]): LlmFileUploadMetrics {
  let totalBytes = 0;
  let totalLatencyMs = 0;
  for (const event of events) {
    totalBytes += Math.max(0, event.bytes);
    totalLatencyMs += Math.max(0, event.durationMs);
  }
  return {
    count: events.length,
    totalBytes,
    totalLatencyMs,
    events: Array.from(events),
  };
}

export function emptyFileUploadMetrics(): LlmFileUploadMetrics {
  return summarizeUploadEvents([]);
}

export function getCurrentFileUploadMetrics(): LlmFileUploadMetrics {
  const collector = fileUploadScopeStorage.getStore()?.collectors.at(-1);
  return summarizeUploadEvents(collector?.events ?? []);
}

export async function collectFileUploadMetrics<T>(fn: () => Promise<T>): Promise<{
  readonly result: T;
  readonly uploads: LlmFileUploadMetrics;
}> {
  const parent = fileUploadScopeStorage.getStore();
  const collector: FileUploadCollector = { events: [] };
  const scope: FileUploadScope = {
    collectors: [...(parent?.collectors ?? []), collector],
    source: parent?.source,
  };
  return await fileUploadScopeStorage.run(scope, async () => {
    const result = await fn();
    return {
      result,
      uploads: summarizeUploadEvents(collector.events),
    };
  });
}

export async function runWithFileUploadSource<T>(
  source: LlmFileUploadSource,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = fileUploadScopeStorage.getStore();
  const scope: FileUploadScope = {
    collectors: parent?.collectors ?? [],
    source,
  };
  return await fileUploadScopeStorage.run(scope, fn);
}

function formatUploadLogLine(event: LlmFileUploadEvent): string {
  const parts = [
    "[upload]",
    `source=${event.source}`,
    `backend=${event.backend}`,
    `mode=${event.mode}`,
    `filename=${JSON.stringify(event.filename)}`,
    `bytes=${event.bytes.toString()}`,
    `durationMs=${event.durationMs.toString()}`,
  ];
  if (event.mimeType) {
    parts.push(`mimeType=${event.mimeType}`);
  }
  if (event.fileId) {
    parts.push(`fileId=${event.fileId}`);
  }
  if (event.mirrorId) {
    parts.push(`mirrorId=${event.mirrorId}`);
  }
  if (event.fileUri) {
    parts.push(`fileUri=${JSON.stringify(event.fileUri)}`);
  }
  return parts.join(" ");
}

function recordUploadEvent(
  event: Omit<LlmFileUploadEvent, "timestamp" | "source"> & {
    readonly source?: LlmFileUploadSource;
  },
): void {
  const scope = fileUploadScopeStorage.getStore();
  const resolvedSource =
    event.source ?? scope?.source ?? (event.backend === "openai" ? "files_api" : "provider_mirror");
  const timestampedEvent: LlmFileUploadEvent = {
    ...event,
    source: resolvedSource,
    timestamp: new Date().toISOString(),
  };
  for (const collector of scope?.collectors ?? []) {
    collector.events.push(timestampedEvent);
  }
  getCurrentAgentLoggingSession()?.logLine(formatUploadLogLine(timestampedEvent));
}

function normaliseFilename(filename: string | undefined, fallback = "attachment.bin"): string {
  const trimmed = filename?.trim();
  if (!trimmed) {
    return fallback;
  }
  const basename = path.basename(trimmed);
  return basename.length > 0 ? basename : fallback;
}

function resolveMimeType(
  filename: string,
  explicitMimeType: string | undefined,
  fallback = "application/octet-stream",
): string {
  const trimmed = explicitMimeType?.trim();
  if (trimmed) {
    return trimmed;
  }
  const inferred = mime.getType(filename);
  return typeof inferred === "string" && inferred.length > 0 ? inferred : fallback;
}

function toBuffer(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

function computeSha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function computeFileSha256Hex(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function toStoredFile(file: OpenAI.Files.FileObject): LlmStoredFile {
  return {
    id: file.id,
    bytes: file.bytes,
    created_at: file.created_at,
    filename: file.filename,
    object: "file",
    purpose: file.purpose as LlmFilePurpose,
    status: file.status,
    expires_at: file.expires_at,
  };
}

function buildCacheKey(filename: string, mimeType: string, sha256Hex: string): string {
  return `${sha256Hex}\u0000${filename}\u0000${mimeType}`;
}

function isFresh(file: LlmStoredFile): boolean {
  if (!file.expires_at) {
    return true;
  }
  return file.expires_at * 1000 > Date.now() + 30_000;
}

function recordMetadata(metadata: CachedFileMetadata): CachedFileMetadata {
  filesState.metadataById.set(metadata.file.id, metadata);
  if (metadata.sha256Hex) {
    filesState.openAiUploadCacheByKey.set(
      buildCacheKey(
        metadata.filename,
        metadata.mimeType ?? "application/octet-stream",
        metadata.sha256Hex,
      ),
      metadata,
    );
  }
  return metadata;
}

async function uploadOpenAiFileFromBytes(params: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  purpose: LlmFilePurpose;
  expiresAfterSeconds: number;
  sha256Hex: string;
}): Promise<CachedFileMetadata> {
  const cacheKey = buildCacheKey(params.filename, params.mimeType, params.sha256Hex);
  const cached = filesState.openAiUploadCacheByKey.get(cacheKey);
  if (cached && isFresh(cached.file)) {
    return cached;
  }

  const client = getOpenAiClient();
  const startedAtMs = Date.now();
  let uploaded: OpenAI.Files.FileObject | undefined;
  let mode: LlmFileUploadMode;
  if (params.bytes.byteLength <= OPENAI_FILE_CREATE_MAX_BYTES) {
    mode = "files.create";
    uploaded = await client.files.create({
      file: new NodeFile([new Uint8Array(params.bytes)], params.filename, {
        type: params.mimeType,
      }),
      purpose: params.purpose,
      expires_after: {
        anchor: "created_at",
        seconds: params.expiresAfterSeconds,
      },
    });
  } else {
    mode = "uploads";
    const upload = await client.uploads.create({
      bytes: params.bytes.byteLength,
      filename: params.filename,
      mime_type: params.mimeType,
      purpose: params.purpose,
    });
    const partIds: string[] = [];
    for (let offset = 0; offset < params.bytes.byteLength; offset += OPENAI_UPLOAD_PART_MAX_BYTES) {
      const chunk = params.bytes.subarray(
        offset,
        Math.min(offset + OPENAI_UPLOAD_PART_MAX_BYTES, params.bytes.byteLength),
      );
      const uploadPart = await client.uploads.parts.create(upload.id, {
        data: new NodeFile([new Uint8Array(chunk)], `${params.sha256Hex}.part`, {
          type: params.mimeType,
        }),
      });
      partIds.push(uploadPart.id);
    }
    const completed = await client.uploads.complete(upload.id, { part_ids: partIds });
    const fileId = completed.file?.id;
    if (!fileId) {
      throw new Error("OpenAI upload completed without a file id.");
    }
    uploaded = await client.files.retrieve(fileId);
  }

  const file = toStoredFile(uploaded);
  const metadata = recordMetadata({
    file,
    filename: file.filename,
    bytes: file.bytes,
    mimeType: params.mimeType,
    sha256Hex: params.sha256Hex,
  });
  recordUploadEvent({
    backend: "openai",
    mode,
    filename: metadata.filename,
    bytes: metadata.bytes,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    mimeType: params.mimeType,
    fileId: metadata.file.id,
  });
  return metadata;
}

async function uploadOpenAiFileFromPath(params: {
  filePath: string;
  filename: string;
  mimeType: string;
  purpose: LlmFilePurpose;
  expiresAfterSeconds: number;
  sha256Hex: string;
  bytes: number;
}): Promise<CachedFileMetadata> {
  const cacheKey = buildCacheKey(params.filename, params.mimeType, params.sha256Hex);
  const cached = filesState.openAiUploadCacheByKey.get(cacheKey);
  if (cached && isFresh(cached.file)) {
    return cached;
  }

  const client = getOpenAiClient();
  const startedAtMs = Date.now();
  let uploaded: OpenAI.Files.FileObject | undefined;
  let mode: LlmFileUploadMode;
  if (params.bytes <= OPENAI_FILE_CREATE_MAX_BYTES) {
    mode = "files.create";
    const blob = await openAsBlob(params.filePath, { type: params.mimeType });
    uploaded = await client.files.create({
      file: new NodeFile([blob], params.filename, { type: params.mimeType }),
      purpose: params.purpose,
      expires_after: {
        anchor: "created_at",
        seconds: params.expiresAfterSeconds,
      },
    });
  } else {
    mode = "uploads";
    const upload = await client.uploads.create({
      bytes: params.bytes,
      filename: params.filename,
      mime_type: params.mimeType,
      purpose: params.purpose,
    });
    const partIds: string[] = [];
    const stream = createReadStream(params.filePath, {
      highWaterMark: OPENAI_UPLOAD_PART_MAX_BYTES,
    });
    let partIndex = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const uploadPart = await client.uploads.parts.create(upload.id, {
        data: new NodeFile(
          [new Uint8Array(buffer)],
          `${params.sha256Hex}.${partIndex.toString()}.part`,
          {
            type: params.mimeType,
          },
        ),
      });
      partIds.push(uploadPart.id);
      partIndex += 1;
    }
    const completed = await client.uploads.complete(upload.id, { part_ids: partIds });
    const fileId = completed.file?.id;
    if (!fileId) {
      throw new Error("OpenAI upload completed without a file id.");
    }
    uploaded = await client.files.retrieve(fileId);
  }

  const file = toStoredFile(uploaded);
  const metadata = recordMetadata({
    file,
    filename: file.filename,
    bytes: file.bytes,
    mimeType: params.mimeType,
    sha256Hex: params.sha256Hex,
  });
  recordUploadEvent({
    backend: "openai",
    mode,
    filename: metadata.filename,
    bytes: metadata.bytes,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    mimeType: params.mimeType,
    fileId: metadata.file.id,
  });
  return metadata;
}

async function retrieveOpenAiFile(fileId: string): Promise<CachedFileMetadata> {
  const cached = filesState.metadataById.get(fileId);
  if (cached && isFresh(cached.file)) {
    return cached;
  }
  const client = getOpenAiClient();
  const retrieved = await client.files.retrieve(fileId);
  const file = toStoredFile(retrieved);
  return recordMetadata({
    file,
    filename: file.filename,
    bytes: file.bytes,
    mimeType: cached?.mimeType ?? resolveMimeType(file.filename, undefined),
    sha256Hex: cached?.sha256Hex,
    localPath: cached?.localPath,
  });
}

function buildGeminiMirrorName(sha256Hex: string): string {
  return `files/${sha256Hex.slice(0, 40)}`;
}

async function waitForGeminiFileActive(client: GoogleGenAI, name: string): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const file = await client.files.get({ name });
    if (!file.state || file.state === "ACTIVE") {
      return;
    }
    if (file.state === "FAILED") {
      throw new Error(file.error?.message ?? `Gemini file ${name} failed processing.`);
    }
    if (Date.now() - startedAt >= GEMINI_FILE_POLL_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Gemini file ${name} to become active.`);
    }
    await new Promise((resolve) => setTimeout(resolve, GEMINI_FILE_POLL_INTERVAL_MS));
  }
}

function resolveVertexMirrorBucket(): string {
  const raw = process.env.VERTEX_GCS_BUCKET ?? process.env.LLM_VERTEX_GCS_BUCKET;
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(
      "VERTEX_GCS_BUCKET must be set to use OpenAI-backed file ids with Vertex Gemini models.",
    );
  }
  return trimmed.replace(/^gs:\/\//u, "").replace(/\/+$/u, "");
}

function resolveVertexMirrorPrefix(): string {
  const raw = process.env.VERTEX_GCS_PREFIX ?? process.env.LLM_VERTEX_GCS_PREFIX;
  const trimmed = raw?.trim().replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed ? `${trimmed}/` : "";
}

function getStorageClient(): Storage {
  if (filesState.storageClient) {
    return filesState.storageClient;
  }
  const serviceAccount = getGoogleServiceAccount();
  filesState.storageClient = new Storage({
    projectId: serviceAccount.projectId,
    credentials: {
      client_email: serviceAccount.clientEmail,
      private_key: serviceAccount.privateKey,
    },
  });
  return filesState.storageClient;
}

function getGeminiMirrorClient(): Promise<GoogleGenAI> {
  if (!filesState.geminiClientPromise) {
    filesState.geminiClientPromise = getGeminiClient();
  }
  return filesState.geminiClientPromise;
}

async function materializeOpenAiFile(fileId: string): Promise<MaterializedOpenAiFile> {
  const cachedPromise = filesState.materializedById.get(fileId);
  if (cachedPromise) {
    return await cachedPromise;
  }

  const promise = (async () => {
    const metadata = await retrieveOpenAiFile(fileId);
    if (metadata.localPath && metadata.sha256Hex && metadata.mimeType) {
      return {
        file: metadata.file,
        filename: metadata.filename,
        bytes: metadata.bytes,
        mimeType: metadata.mimeType,
        sha256Hex: metadata.sha256Hex,
        localPath: metadata.localPath,
      };
    }

    await mkdir(FILES_TEMP_ROOT, { recursive: true });
    const tempDir = await mkdtemp(
      path.join(FILES_TEMP_ROOT, `${fileId.replace(/[^a-z0-9_-]/giu, "")}-`),
    );
    const localPath = path.join(tempDir, normaliseFilename(metadata.filename, `${fileId}.bin`));
    const response = await getOpenAiClient().files.content(fileId);
    if (!response.ok) {
      throw new Error(
        `Failed to download OpenAI file ${fileId}: ${response.status} ${response.statusText}`,
      );
    }

    const responseMimeType = response.headers.get("content-type")?.trim() || undefined;
    const mimeType = resolveMimeType(metadata.filename, responseMimeType);
    const hash = createHash("sha256");
    let bytes = 0;
    if (response.body) {
      const source = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      const writable = createWriteStream(localPath, { flags: "wx" });
      source.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        bytes += buffer.byteLength;
      });
      await pipeline(source, writable);
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      hash.update(buffer);
      bytes = buffer.byteLength;
      await writeFile(localPath, buffer);
    }

    const sha256Hex = hash.digest("hex");
    const updated = recordMetadata({
      file: metadata.file,
      filename: metadata.filename,
      bytes: bytes || metadata.bytes,
      mimeType,
      sha256Hex,
      localPath,
    });
    return {
      file: updated.file,
      filename: updated.filename,
      bytes: updated.bytes,
      mimeType: updated.mimeType ?? mimeType,
      sha256Hex,
      localPath,
    };
  })();

  filesState.materializedById.set(fileId, promise);
  try {
    return await promise;
  } catch (error) {
    filesState.materializedById.delete(fileId);
    throw error;
  }
}

export async function ensureGeminiFileMirror(fileId: string): Promise<CachedGeminiMirror> {
  const cached = filesState.geminiMirrorById.get(fileId);
  if (cached) {
    return cached;
  }
  const materialized = await materializeOpenAiFile(fileId);
  const client = await getGeminiMirrorClient();
  const name = buildGeminiMirrorName(materialized.sha256Hex);
  try {
    const existing = await client.files.get({ name });
    if (existing.name && existing.uri && existing.mimeType) {
      const mirror: CachedGeminiMirror = {
        openAiFileId: fileId,
        name: existing.name,
        uri: existing.uri,
        mimeType: existing.mimeType,
        displayName: existing.displayName ?? materialized.filename,
      };
      filesState.geminiMirrorById.set(fileId, mirror);
      return mirror;
    }
  } catch {
    // Fall through to upload when the deterministic name does not exist yet.
  }

  const startedAtMs = Date.now();
  const uploaded = await client.files.upload({
    file: materialized.localPath,
    config: {
      name,
      mimeType: materialized.mimeType,
      displayName: materialized.filename,
    },
  });
  if (uploaded.name && uploaded.state && uploaded.state !== "ACTIVE") {
    await waitForGeminiFileActive(client, uploaded.name);
  }
  const resolved = await client.files.get({ name: uploaded.name ?? name });
  if (!resolved.name || !resolved.uri || !resolved.mimeType) {
    throw new Error("Gemini file upload completed without a usable URI.");
  }
  const mirror: CachedGeminiMirror = {
    openAiFileId: fileId,
    name: resolved.name,
    uri: resolved.uri,
    mimeType: resolved.mimeType,
    displayName: resolved.displayName ?? materialized.filename,
  };
  filesState.geminiMirrorById.set(fileId, mirror);
  recordUploadEvent({
    backend: "gemini",
    mode: "mirror",
    filename: materialized.filename,
    bytes: materialized.bytes,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    mimeType: materialized.mimeType,
    fileId,
    mirrorId: mirror.name,
    fileUri: mirror.uri,
  });
  return mirror;
}

export async function ensureVertexFileMirror(fileId: string): Promise<CachedVertexMirror> {
  const cached = filesState.vertexMirrorById.get(fileId);
  if (cached) {
    return cached;
  }
  const materialized = await materializeOpenAiFile(fileId);
  const bucketName = resolveVertexMirrorBucket();
  const prefix = resolveVertexMirrorPrefix();
  const extension =
    mime.getExtension(materialized.mimeType) ??
    path.extname(materialized.filename).replace(/^\./u, "") ??
    "bin";
  const objectName = `${prefix}${materialized.sha256Hex}.${extension}`;
  const file = getStorageClient().bucket(bucketName).file(objectName);
  let uploaded = false;
  const startedAtMs = Date.now();

  try {
    await file.getMetadata();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 404 && code !== "404") {
      throw error;
    }
    try {
      await pipeline(
        createReadStream(materialized.localPath),
        file.createWriteStream({
          resumable: materialized.bytes >= 10 * 1024 * 1024,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: materialized.mimeType,
            customTime: new Date().toISOString(),
            metadata: {
              filename: materialized.filename,
              sha256: materialized.sha256Hex,
              expiresAt: new Date(Date.now() + DEFAULT_FILE_TTL_SECONDS * 1000).toISOString(),
            },
          },
        }),
      );
      uploaded = true;
    } catch (uploadError) {
      const uploadCode = (uploadError as { code?: unknown }).code;
      if (uploadCode !== 412 && uploadCode !== "412") {
        throw uploadError;
      }
    }
  }

  const mirror: CachedVertexMirror = {
    openAiFileId: fileId,
    bucket: bucketName,
    objectName,
    fileUri: `gs://${bucketName}/${objectName}`,
    mimeType: materialized.mimeType,
  };
  filesState.vertexMirrorById.set(fileId, mirror);
  if (uploaded) {
    recordUploadEvent({
      backend: "vertex",
      mode: "mirror",
      filename: materialized.filename,
      bytes: materialized.bytes,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      mimeType: materialized.mimeType,
      fileId,
      mirrorId: mirror.objectName,
      fileUri: mirror.fileUri,
    });
  }
  return mirror;
}

export async function filesCreate(params: LlmFileCreateParams): Promise<LlmStoredFile> {
  const purpose = params.purpose ?? "user_data";
  const expiresAfterSeconds = params.expiresAfterSeconds ?? DEFAULT_FILE_TTL_SECONDS;
  if ("path" in params) {
    const filePath = path.resolve(params.path);
    const info = await stat(filePath);
    const filename = normaliseFilename(params.filename, path.basename(filePath));
    const mimeType = resolveMimeType(filename, params.mimeType);
    const sha256Hex = await computeFileSha256Hex(filePath);
    const uploaded = await uploadOpenAiFileFromPath({
      filePath,
      filename,
      mimeType,
      purpose,
      expiresAfterSeconds,
      sha256Hex,
      bytes: info.size,
    });
    return uploaded.file;
  }

  const filename = normaliseFilename(params.filename);
  const bytes = toBuffer(params.data);
  const mimeType = resolveMimeType(filename, params.mimeType, "text/plain");
  const sha256Hex = computeSha256Hex(bytes);
  const uploaded = await uploadOpenAiFileFromBytes({
    bytes,
    filename,
    mimeType,
    purpose,
    expiresAfterSeconds,
    sha256Hex,
  });
  return uploaded.file;
}

export async function filesRetrieve(fileId: string): Promise<LlmStoredFile> {
  return (await retrieveOpenAiFile(fileId)).file;
}

export async function filesDelete(fileId: string): Promise<LlmFileDeleted> {
  const cachedGemini = filesState.geminiMirrorById.get(fileId);
  if (cachedGemini) {
    try {
      const client = await getGeminiMirrorClient();
      await client.files.delete({ name: cachedGemini.name });
    } catch {
      // Mirror files are best-effort caches.
    }
    filesState.geminiMirrorById.delete(fileId);
  }

  const cachedVertex = filesState.vertexMirrorById.get(fileId);
  if (cachedVertex) {
    try {
      await getStorageClient()
        .bucket(cachedVertex.bucket)
        .file(cachedVertex.objectName)
        .delete({ ignoreNotFound: true });
    } catch {
      // Mirror files are best-effort caches.
    }
    filesState.vertexMirrorById.delete(fileId);
  }

  const cachedMaterialized = filesState.metadataById.get(fileId)?.localPath;
  if (cachedMaterialized) {
    try {
      await unlink(cachedMaterialized);
    } catch {
      // Ignore local cleanup failures.
    }
  }

  const response = await getOpenAiClient().files.delete(fileId);
  filesState.metadataById.delete(fileId);
  filesState.materializedById.delete(fileId);
  return {
    id: response.id,
    deleted: response.deleted,
    object: "file",
  };
}

export async function filesContent(fileId: string): Promise<Response> {
  return await getOpenAiClient().files.content(fileId);
}

export async function getCanonicalFileMetadata(
  fileId: string,
): Promise<CachedFileMetadata & { readonly mimeType: string }> {
  const metadata = await retrieveOpenAiFile(fileId);
  const mimeType = metadata.mimeType ?? resolveMimeType(metadata.filename, undefined);
  const updated =
    metadata.mimeType === mimeType
      ? metadata
      : recordMetadata({
          ...metadata,
          mimeType,
        });
  return {
    ...updated,
    mimeType,
  };
}

export const files = {
  create: filesCreate,
  retrieve: filesRetrieve,
  delete: filesDelete,
  content: filesContent,
} as const;
