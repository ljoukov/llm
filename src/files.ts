import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { GoogleGenAI } from "@google/genai";
import { Storage } from "@google-cloud/storage";
import mime from "mime";

import { getCurrentAgentLoggingSession } from "./agentLogging.js";
import { getGoogleServiceAccount } from "./google/auth.js";
import { getGeminiClient } from "./google/client.js";
import { getRuntimeSingleton } from "./utils/runtimeSingleton.js";

export const DEFAULT_FILE_TTL_SECONDS = 48 * 60 * 60;
const GEMINI_FILE_POLL_INTERVAL_MS = 1_000;
const GEMINI_FILE_POLL_TIMEOUT_MS = 60_000;
const FILES_TEMP_ROOT = path.join(os.tmpdir(), "ljoukov-llm-files");
const FILES_CACHE_ROOT = path.join(FILES_TEMP_ROOT, "cache");
const FILES_CACHE_CONTENT_ROOT = path.join(FILES_CACHE_ROOT, "content");
const FILES_CACHE_METADATA_ROOT = path.join(FILES_CACHE_ROOT, "metadata");

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

export type LlmFileUploadBackend = "gcs" | "gemini" | "vertex";

export type LlmFileUploadMode = "gcs" | "mirror";

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
  readonly bucketName?: string;
  readonly objectName?: string;
};

type CachedGeminiMirror = {
  readonly canonicalFileId: string;
  readonly name: string;
  readonly uri: string;
  readonly mimeType: string;
  readonly displayName: string;
};

type CachedVertexMirror = {
  readonly canonicalFileId: string;
  readonly bucket: string;
  readonly objectName: string;
  readonly fileUri: string;
  readonly mimeType: string;
};

type MaterializedCanonicalFile = {
  readonly file: LlmStoredFile;
  readonly filename: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sha256Hex: string;
  readonly localPath: string;
  readonly bucketName: string;
  readonly objectName: string;
};

type PersistedFileMetadata = {
  readonly file: LlmStoredFile;
  readonly filename: string;
  readonly bytes: number;
  readonly mimeType?: string;
  readonly sha256Hex?: string;
  readonly localPath?: string;
  readonly bucketName?: string;
  readonly objectName?: string;
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
  canonicalUploadCacheByKey: new Map<string, CachedFileMetadata>(),
  materializedById: new Map<string, Promise<MaterializedCanonicalFile>>(),
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
    event.source ?? scope?.source ?? (event.backend === "gcs" ? "files_api" : "provider_mirror");
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

function buildCanonicalFileId(filename: string, mimeType: string, sha256Hex: string): string {
  return `file_${createHash("sha256")
    .update(filename)
    .update("\u0000")
    .update(mimeType)
    .update("\u0000")
    .update(sha256Hex)
    .digest("hex")}`;
}

function resolveCanonicalFilesBucket(): string {
  const raw =
    process.env.LLM_FILES_GCS_BUCKET ??
    process.env.VERTEX_GCS_BUCKET ??
    process.env.LLM_VERTEX_GCS_BUCKET;
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(
      "LLM_FILES_GCS_BUCKET (or VERTEX_GCS_BUCKET) must be set to use the canonical files API.",
    );
  }
  return trimmed.replace(/^gs:\/\//u, "").replace(/\/+$/u, "");
}

function resolveCanonicalFilesPrefix(): string {
  const raw = process.env.LLM_FILES_GCS_PREFIX;
  const trimmed = raw?.trim().replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed ? `${trimmed}/` : "canonical-files/";
}

function isLatexLikeFile(filename: string, mimeType: string): boolean {
  const extension = path.extname(filename).trim().toLowerCase();
  const normalisedMimeType = mimeType.trim().toLowerCase();
  return (
    extension === ".tex" ||
    extension === ".ltx" ||
    extension === ".latex" ||
    normalisedMimeType === "application/x-tex" ||
    normalisedMimeType === "text/x-tex"
  );
}

function resolveCanonicalStorageContentType(filename: string, mimeType: string): string {
  if (isLatexLikeFile(filename, mimeType)) {
    return "text/plain";
  }
  return mimeType;
}

function resolveCanonicalObjectExtension(filename: string, mimeType: string): string {
  if (isLatexLikeFile(filename, mimeType)) {
    return "txt";
  }
  const fromFilename = path.extname(filename).replace(/^\./u, "").trim().toLowerCase();
  if (fromFilename) {
    return fromFilename;
  }
  const fromMimeType = mime.getExtension(mimeType)?.trim().toLowerCase();
  if (fromMimeType) {
    return fromMimeType;
  }
  return "bin";
}

function buildCanonicalObjectName(fileId: string, filename: string, mimeType: string): string {
  const extension = resolveCanonicalObjectExtension(filename, mimeType);
  return `${resolveCanonicalFilesPrefix()}${fileId}.${extension}`;
}

function toSafeStorageFilename(filename: string): string {
  const normalized = normaliseFilename(filename).replace(/[^\w.-]+/gu, "-");
  return normalized.length > 0 ? normalized : "attachment.bin";
}

function parseUnixSeconds(value: string | undefined, fallback?: string): number {
  if (value) {
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  if (fallback) {
    const millis = Date.parse(fallback);
    if (Number.isFinite(millis)) {
      return Math.floor(millis / 1000);
    }
  }
  return Math.floor(Date.now() / 1000);
}

function parseOptionalUnixSeconds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const millis = Date.parse(value);
  if (Number.isFinite(millis)) {
    return Math.floor(millis / 1000);
  }
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function toStoredFileFromCanonicalMetadata(options: {
  fileId: string;
  bucketName: string;
  objectName: string;
  objectMetadata: Record<string, any>;
  localPath?: string;
}): CachedFileMetadata {
  const metadata = options.objectMetadata.metadata as Record<string, unknown> | undefined;
  const filenameRaw =
    typeof metadata?.filename === "string" && metadata.filename.trim().length > 0
      ? metadata.filename.trim()
      : path.basename(options.objectName);
  const filename = normaliseFilename(filenameRaw);
  const bytesRaw = options.objectMetadata.size;
  const bytes =
    typeof bytesRaw === "string"
      ? Number.parseInt(bytesRaw, 10)
      : typeof bytesRaw === "number"
        ? bytesRaw
        : 0;
  const purpose =
    metadata?.purpose === "user_data" ? ("user_data" as const) : ("user_data" as const);
  const createdAt = parseUnixSeconds(
    typeof metadata?.createdAtUnix === "string" ? metadata.createdAtUnix : undefined,
    typeof options.objectMetadata.timeCreated === "string"
      ? options.objectMetadata.timeCreated
      : undefined,
  );
  const expiresAt = parseOptionalUnixSeconds(
    typeof metadata?.expiresAt === "string" ? metadata.expiresAt : undefined,
  );
  const mimeType =
    typeof metadata?.mimeType === "string" && metadata.mimeType.trim().length > 0
      ? metadata.mimeType.trim()
      : typeof options.objectMetadata.contentType === "string" &&
          options.objectMetadata.contentType.trim().length > 0
        ? options.objectMetadata.contentType.trim()
        : resolveMimeType(filename, undefined);
  const sha256Hex =
    typeof metadata?.sha256 === "string" && metadata.sha256.trim().length > 0
      ? metadata.sha256.trim()
      : undefined;
  return {
    file: {
      id: options.fileId,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      created_at: createdAt,
      filename,
      object: "file",
      purpose,
      status: "processed",
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    },
    filename,
    bytes: Number.isFinite(bytes) ? bytes : 0,
    mimeType,
    sha256Hex,
    localPath: options.localPath,
    bucketName: options.bucketName,
    objectName: options.objectName,
  };
}

function buildCacheKey(filename: string, mimeType: string, sha256Hex: string): string {
  return `${sha256Hex}\u0000${filename}\u0000${mimeType}`;
}

function buildCachedContentPath(sha256Hex: string): string {
  return path.join(FILES_CACHE_CONTENT_ROOT, sha256Hex);
}

function buildCachedMetadataPath(fileId: string): string {
  return path.join(FILES_CACHE_METADATA_ROOT, `${fileId}.json`);
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
    filesState.canonicalUploadCacheByKey.set(
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

async function ensureFilesCacheReady(): Promise<void> {
  await mkdir(FILES_CACHE_CONTENT_ROOT, { recursive: true });
  await mkdir(FILES_CACHE_METADATA_ROOT, { recursive: true });
}

async function cacheBufferLocally(bytes: Buffer, sha256Hex: string): Promise<string> {
  await ensureFilesCacheReady();
  const localPath = buildCachedContentPath(sha256Hex);
  try {
    await writeFile(localPath, bytes, { flag: "wx" });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }
  return localPath;
}

async function cacheFileLocally(filePath: string, sha256Hex: string): Promise<string> {
  await ensureFilesCacheReady();
  const localPath = buildCachedContentPath(sha256Hex);
  try {
    await copyFile(filePath, localPath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }
  return localPath;
}

async function persistMetadataToDisk(metadata: CachedFileMetadata): Promise<void> {
  await ensureFilesCacheReady();
  const payload: PersistedFileMetadata = {
    file: metadata.file,
    filename: metadata.filename,
    bytes: metadata.bytes,
    mimeType: metadata.mimeType,
    sha256Hex: metadata.sha256Hex,
    localPath: metadata.localPath,
    bucketName: metadata.bucketName,
    objectName: metadata.objectName,
  };
  await writeFile(
    buildCachedMetadataPath(metadata.file.id),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

async function loadPersistedMetadata(fileId: string): Promise<CachedFileMetadata | undefined> {
  try {
    const payload = JSON.parse(
      await readFile(buildCachedMetadataPath(fileId), "utf8"),
    ) as PersistedFileMetadata;
    if (!payload || typeof payload !== "object" || !payload.file) {
      return undefined;
    }
    if (payload.localPath) {
      try {
        const localStats = await stat(payload.localPath);
        if (!localStats.isFile()) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return recordMetadata({
      file: payload.file,
      filename: payload.filename,
      bytes: payload.bytes,
      mimeType: payload.mimeType,
      sha256Hex: payload.sha256Hex,
      localPath: payload.localPath,
      bucketName: payload.bucketName,
      objectName: payload.objectName,
    });
  } catch {
    return undefined;
  }
}

async function writeCanonicalFileFromPath(options: {
  filePath: string;
  bucketName: string;
  objectName: string;
  bytes: number;
  mimeType: string;
  metadata: Record<string, string>;
}): Promise<boolean> {
  const file = getStorageClient().bucket(options.bucketName).file(options.objectName);
  const storageContentType = resolveCanonicalStorageContentType(
    options.metadata.filename ?? "attachment.bin",
    options.mimeType,
  );
  try {
    await pipeline(
      createReadStream(options.filePath),
      file.createWriteStream({
        resumable: options.bytes >= 10 * 1024 * 1024,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: storageContentType,
          contentDisposition: `inline; filename="${toSafeStorageFilename(options.metadata.filename ?? "attachment.bin")}"`,
          metadata: options.metadata,
        },
      }),
    );
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 412 || code === "412") {
      return false;
    }
    throw error;
  }
}

async function writeCanonicalFileFromBytes(options: {
  bytes: Buffer;
  bucketName: string;
  objectName: string;
  mimeType: string;
  metadata: Record<string, string>;
}): Promise<boolean> {
  const file = getStorageClient().bucket(options.bucketName).file(options.objectName);
  const storageContentType = resolveCanonicalStorageContentType(
    options.metadata.filename ?? "attachment.bin",
    options.mimeType,
  );
  try {
    await file.save(options.bytes, {
      resumable: options.bytes.byteLength >= 10 * 1024 * 1024,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: storageContentType,
        contentDisposition: `inline; filename="${toSafeStorageFilename(options.metadata.filename ?? "attachment.bin")}"`,
        metadata: options.metadata,
      },
    });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 412 || code === "412") {
      return false;
    }
    throw error;
  }
}

async function refreshCanonicalObjectMetadata(options: {
  bucketName: string;
  objectName: string;
  mimeType: string;
  metadata: Record<string, string>;
}): Promise<void> {
  const storageContentType = resolveCanonicalStorageContentType(
    options.metadata.filename ?? "attachment.bin",
    options.mimeType,
  );
  await getStorageClient()
    .bucket(options.bucketName)
    .file(options.objectName)
    .setMetadata({
      contentType: storageContentType,
      contentDisposition: `inline; filename="${toSafeStorageFilename(options.metadata.filename ?? "attachment.bin")}"`,
      metadata: options.metadata,
    });
}

async function createCanonicalMetadata(options: {
  fileId: string;
  filename: string;
  mimeType: string;
  purpose: LlmFilePurpose;
  expiresAfterSeconds: number;
  sha256Hex: string;
  bytes: number;
  bucketName: string;
  objectName: string;
  localPath?: string;
}): Promise<CachedFileMetadata> {
  const createdAt = Math.floor(Date.now() / 1000);
  const expiresAt = createdAt + options.expiresAfterSeconds;
  const storedFile: LlmStoredFile = {
    id: options.fileId,
    bytes: options.bytes,
    created_at: createdAt,
    filename: options.filename,
    object: "file",
    purpose: options.purpose,
    status: "processed",
    expires_at: expiresAt,
  };
  const metadata = recordMetadata({
    file: storedFile,
    filename: options.filename,
    bytes: options.bytes,
    mimeType: options.mimeType,
    sha256Hex: options.sha256Hex,
    localPath: options.localPath,
    bucketName: options.bucketName,
    objectName: options.objectName,
  });
  await persistMetadataToDisk(metadata);
  return metadata;
}

async function uploadCanonicalFileFromBytes(params: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  purpose: LlmFilePurpose;
  expiresAfterSeconds: number;
  sha256Hex: string;
}): Promise<CachedFileMetadata> {
  const cacheKey = buildCacheKey(params.filename, params.mimeType, params.sha256Hex);
  const cached = filesState.canonicalUploadCacheByKey.get(cacheKey);
  if (cached && isFresh(cached.file)) {
    return cached;
  }

  const fileId = buildCanonicalFileId(params.filename, params.mimeType, params.sha256Hex);
  const bucketName = resolveCanonicalFilesBucket();
  const objectName = buildCanonicalObjectName(fileId, params.filename, params.mimeType);
  const metadataFields = {
    fileId,
    filename: params.filename,
    mimeType: params.mimeType,
    purpose: params.purpose,
    sha256: params.sha256Hex,
    createdAtUnix: Math.floor(Date.now() / 1000).toString(),
    expiresAt: new Date(Date.now() + params.expiresAfterSeconds * 1000).toISOString(),
  } satisfies Record<string, string>;
  const startedAtMs = Date.now();

  const uploaded = await writeCanonicalFileFromBytes({
    bytes: params.bytes,
    bucketName,
    objectName,
    mimeType: params.mimeType,
    metadata: metadataFields,
  });
  if (!uploaded) {
    await refreshCanonicalObjectMetadata({
      bucketName,
      objectName,
      mimeType: params.mimeType,
      metadata: metadataFields,
    });
  }

  const localPath = await cacheBufferLocally(params.bytes, params.sha256Hex);
  const canonical = await createCanonicalMetadata({
    fileId,
    filename: params.filename,
    mimeType: params.mimeType,
    purpose: params.purpose,
    expiresAfterSeconds: params.expiresAfterSeconds,
    sha256Hex: params.sha256Hex,
    bytes: params.bytes.byteLength,
    bucketName,
    objectName,
    localPath,
  });
  if (uploaded) {
    recordUploadEvent({
      backend: "gcs",
      mode: "gcs",
      filename: params.filename,
      bytes: params.bytes.byteLength,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      mimeType: params.mimeType,
      fileId,
      fileUri: `gs://${bucketName}/${objectName}`,
    });
  }
  return canonical;
}

async function uploadCanonicalFileFromPath(params: {
  filePath: string;
  filename: string;
  mimeType: string;
  purpose: LlmFilePurpose;
  expiresAfterSeconds: number;
  sha256Hex: string;
  bytes: number;
}): Promise<CachedFileMetadata> {
  const cacheKey = buildCacheKey(params.filename, params.mimeType, params.sha256Hex);
  const cached = filesState.canonicalUploadCacheByKey.get(cacheKey);
  if (cached && isFresh(cached.file)) {
    return cached;
  }

  const fileId = buildCanonicalFileId(params.filename, params.mimeType, params.sha256Hex);
  const bucketName = resolveCanonicalFilesBucket();
  const objectName = buildCanonicalObjectName(fileId, params.filename, params.mimeType);
  const metadataFields = {
    fileId,
    filename: params.filename,
    mimeType: params.mimeType,
    purpose: params.purpose,
    sha256: params.sha256Hex,
    createdAtUnix: Math.floor(Date.now() / 1000).toString(),
    expiresAt: new Date(Date.now() + params.expiresAfterSeconds * 1000).toISOString(),
  } satisfies Record<string, string>;
  const startedAtMs = Date.now();

  const uploaded = await writeCanonicalFileFromPath({
    filePath: params.filePath,
    bucketName,
    objectName,
    bytes: params.bytes,
    mimeType: params.mimeType,
    metadata: metadataFields,
  });
  if (!uploaded) {
    await refreshCanonicalObjectMetadata({
      bucketName,
      objectName,
      mimeType: params.mimeType,
      metadata: metadataFields,
    });
  }

  const localPath = await cacheFileLocally(params.filePath, params.sha256Hex);
  const canonical = await createCanonicalMetadata({
    fileId,
    filename: params.filename,
    mimeType: params.mimeType,
    purpose: params.purpose,
    expiresAfterSeconds: params.expiresAfterSeconds,
    sha256Hex: params.sha256Hex,
    bytes: params.bytes,
    bucketName,
    objectName,
    localPath,
  });
  if (uploaded) {
    recordUploadEvent({
      backend: "gcs",
      mode: "gcs",
      filename: params.filename,
      bytes: params.bytes,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      mimeType: params.mimeType,
      fileId,
      fileUri: `gs://${bucketName}/${objectName}`,
    });
  }
  return canonical;
}

async function resolveCanonicalStorageLocation(fileId: string): Promise<{
  readonly bucketName: string;
  readonly objectName: string;
}> {
  const cached = filesState.metadataById.get(fileId) ?? (await loadPersistedMetadata(fileId));
  if (cached?.bucketName && cached.objectName) {
    return {
      bucketName: cached.bucketName,
      objectName: cached.objectName,
    };
  }

  const bucketName = resolveCanonicalFilesBucket();
  const [files] = await getStorageClient()
    .bucket(bucketName)
    .getFiles({
      prefix: `${resolveCanonicalFilesPrefix()}${fileId}.`,
      maxResults: 1,
      autoPaginate: false,
    });
  const file = files[0];
  if (!file) {
    throw new Error(`Canonical file ${fileId} was not found in GCS.`);
  }
  return {
    bucketName,
    objectName: file.name,
  };
}

async function retrieveCanonicalFile(fileId: string): Promise<CachedFileMetadata> {
  const cached = filesState.metadataById.get(fileId);
  if (cached && isFresh(cached.file) && cached.bucketName && cached.objectName) {
    return cached;
  }

  const persisted = await loadPersistedMetadata(fileId);
  if (persisted && isFresh(persisted.file) && persisted.bucketName && persisted.objectName) {
    return persisted;
  }

  const existingLocalPath = cached?.localPath ?? persisted?.localPath;
  const { bucketName, objectName } = await resolveCanonicalStorageLocation(fileId);
  const [objectMetadata] = await getStorageClient()
    .bucket(bucketName)
    .file(objectName)
    .getMetadata();
  const metadata = recordMetadata(
    toStoredFileFromCanonicalMetadata({
      fileId,
      bucketName,
      objectName,
      objectMetadata,
      localPath: existingLocalPath,
    }),
  );
  await persistMetadataToDisk(metadata);
  return metadata;
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
      "VERTEX_GCS_BUCKET must be set to use canonical file ids with Vertex Gemini models.",
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

async function materializeCanonicalFile(fileId: string): Promise<MaterializedCanonicalFile> {
  const cachedPromise = filesState.materializedById.get(fileId);
  if (cachedPromise) {
    return await cachedPromise;
  }

  const promise = (async () => {
    const metadata = await retrieveCanonicalFile(fileId);
    if (
      metadata.localPath &&
      metadata.sha256Hex &&
      metadata.mimeType &&
      metadata.bucketName &&
      metadata.objectName
    ) {
      return {
        file: metadata.file,
        filename: metadata.filename,
        bytes: metadata.bytes,
        mimeType: metadata.mimeType,
        sha256Hex: metadata.sha256Hex,
        localPath: metadata.localPath,
        bucketName: metadata.bucketName,
        objectName: metadata.objectName,
      };
    }

    if (!metadata.bucketName || !metadata.objectName) {
      throw new Error(`Canonical file ${fileId} is missing GCS location metadata.`);
    }

    const [downloadedBytes] = await getStorageClient()
      .bucket(metadata.bucketName)
      .file(metadata.objectName)
      .download();

    const mimeType = metadata.mimeType ?? resolveMimeType(metadata.filename, undefined);
    const sha256Hex = metadata.sha256Hex ?? computeSha256Hex(downloadedBytes);
    const localPath = await cacheBufferLocally(downloadedBytes, sha256Hex);
    const updated = recordMetadata({
      file: metadata.file,
      filename: metadata.filename,
      bytes: downloadedBytes.byteLength || metadata.bytes,
      mimeType,
      sha256Hex,
      localPath,
      bucketName: metadata.bucketName,
      objectName: metadata.objectName,
    });
    await persistMetadataToDisk(updated);
    return {
      file: updated.file,
      filename: updated.filename,
      bytes: updated.bytes,
      mimeType: updated.mimeType ?? mimeType,
      sha256Hex,
      localPath,
      bucketName: metadata.bucketName,
      objectName: metadata.objectName,
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
  const materialized = await materializeCanonicalFile(fileId);
  const client = await getGeminiMirrorClient();
  const name = buildGeminiMirrorName(materialized.sha256Hex);
  try {
    const existing = await client.files.get({ name });
    if (existing.name && existing.uri && existing.mimeType) {
      const mirror: CachedGeminiMirror = {
        canonicalFileId: fileId,
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
    canonicalFileId: fileId,
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
  const materialized = await materializeCanonicalFile(fileId);
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
    canonicalFileId: fileId,
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
    const uploaded = await uploadCanonicalFileFromPath({
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
  const uploaded = await uploadCanonicalFileFromBytes({
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
  return (await retrieveCanonicalFile(fileId)).file;
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

  try {
    const { bucketName, objectName } = await resolveCanonicalStorageLocation(fileId);
    await getStorageClient().bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  } catch {
    // Ignore canonical object cleanup failures; delete remains best-effort.
  }
  filesState.metadataById.delete(fileId);
  filesState.canonicalUploadCacheByKey.forEach((value, key) => {
    if (value.file.id === fileId) {
      filesState.canonicalUploadCacheByKey.delete(key);
    }
  });
  filesState.materializedById.delete(fileId);
  try {
    await unlink(buildCachedMetadataPath(fileId));
  } catch {
    // Ignore cache metadata cleanup failures.
  }
  return {
    id: fileId,
    deleted: true,
    object: "file",
  };
}

export async function filesContent(fileId: string): Promise<Response> {
  const metadata = await retrieveCanonicalFile(fileId);
  if (!metadata.bucketName || !metadata.objectName) {
    throw new Error(`Canonical file ${fileId} is missing GCS location metadata.`);
  }
  const [bytes] = await getStorageClient()
    .bucket(metadata.bucketName)
    .file(metadata.objectName)
    .download();
  const headers = new Headers();
  headers.set("content-type", metadata.mimeType ?? resolveMimeType(metadata.filename, undefined));
  headers.set("content-length", bytes.byteLength.toString());
  headers.set(
    "content-disposition",
    `inline; filename="${toSafeStorageFilename(metadata.filename)}"`,
  );
  return new Response(bytes, {
    status: 200,
    headers,
  });
}

export async function getCanonicalFileMetadata(fileId: string): Promise<
  CachedFileMetadata & {
    readonly mimeType: string;
    readonly bucketName: string;
    readonly objectName: string;
  }
> {
  const metadata = await retrieveCanonicalFile(fileId);
  const mimeType = metadata.mimeType ?? resolveMimeType(metadata.filename, undefined);
  const updated =
    metadata.mimeType === mimeType
      ? metadata
      : recordMetadata({
          ...metadata,
          mimeType,
        });
  if (!updated.bucketName || !updated.objectName) {
    throw new Error(`Canonical file ${fileId} is missing GCS location metadata.`);
  }
  return {
    ...updated,
    mimeType,
    bucketName: updated.bucketName,
    objectName: updated.objectName,
  };
}

export async function getCanonicalFileSignedUrl(options: {
  fileId: string;
  expiresAfterSeconds?: number;
}): Promise<string> {
  const metadata = await getCanonicalFileMetadata(options.fileId);
  const [signedUrl] = await getStorageClient()
    .bucket(metadata.bucketName)
    .file(metadata.objectName)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + (options.expiresAfterSeconds ?? 15 * 60) * 1000,
      responseType: resolveCanonicalStorageContentType(metadata.filename, metadata.mimeType),
    });
  return signedUrl;
}

export const files = {
  create: filesCreate,
  retrieve: filesRetrieve,
  delete: filesDelete,
  content: filesContent,
} as const;
