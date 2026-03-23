import { Buffer } from "node:buffer";
import { Writable } from "node:stream";

type StoredObject = {
  bytes: Buffer;
  metadata: {
    contentType?: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
  };
  timeCreated: string;
};

type SaveCall = {
  bucketName: string;
  objectName: string;
  bytes: Buffer;
  options: Record<string, unknown>;
};

type SignedUrlCall = {
  bucketName: string;
  objectName: string;
  options: Record<string, unknown>;
  url: string;
};

type DeleteCall = {
  bucketName: string;
  objectName: string;
};

type MockStorageState = {
  buckets: Map<string, Map<string, StoredObject>>;
  saveCalls: SaveCall[];
  signedUrlCalls: SignedUrlCall[];
  deleteCalls: DeleteCall[];
};

const mockStorageStateKey = Symbol.for("@ljoukov/llm.test.mockStorageState");

type GlobalWithMockStorageState = typeof globalThis & {
  [mockStorageStateKey]?: MockStorageState;
};

function getMockStorageStateInternal(): MockStorageState {
  const globalObject = globalThis as GlobalWithMockStorageState;
  const existing = globalObject[mockStorageStateKey];
  if (existing) {
    return existing;
  }
  const created: MockStorageState = {
    buckets: new Map<string, Map<string, StoredObject>>(),
    saveCalls: [],
    signedUrlCalls: [],
    deleteCalls: [],
  };
  globalObject[mockStorageStateKey] = created;
  return created;
}

const storageState = getMockStorageStateInternal();

function createStorageError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function getBucketObjects(bucketName: string): Map<string, StoredObject> {
  let bucket = storageState.buckets.get(bucketName);
  if (!bucket) {
    bucket = new Map<string, StoredObject>();
    storageState.buckets.set(bucketName, bucket);
  }
  return bucket;
}

function normaliseStoredMetadata(
  metadata: Record<string, unknown> | undefined,
): StoredObject["metadata"] {
  return {
    contentType: typeof metadata?.contentType === "string" ? metadata.contentType : undefined,
    contentDisposition:
      typeof metadata?.contentDisposition === "string" ? metadata.contentDisposition : undefined,
    metadata:
      metadata?.metadata && typeof metadata.metadata === "object"
        ? { ...(metadata.metadata as Record<string, string>) }
        : undefined,
  };
}

function buildSignedUrl(bucketName: string, objectName: string): string {
  const encodedPath = objectName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://mock-gcs.local/${encodeURIComponent(bucketName)}/${encodedPath}?signed=1`;
}

class MockFile {
  readonly name: string;

  constructor(
    private readonly bucketName: string,
    objectName: string,
  ) {
    this.name = objectName;
  }

  async save(bytes: Buffer | Uint8Array, options: Record<string, unknown> = {}): Promise<void> {
    const bucket = getBucketObjects(this.bucketName);
    const ifGenerationMatch = (
      options.preconditionOpts as { ifGenerationMatch?: unknown } | undefined
    )?.ifGenerationMatch;
    if (ifGenerationMatch === 0 && bucket.has(this.name)) {
      throw createStorageError(412, "Precondition Failed");
    }
    const buffer = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
    bucket.set(this.name, {
      bytes: buffer,
      metadata: normaliseStoredMetadata(options.metadata as Record<string, unknown> | undefined),
      timeCreated: new Date().toISOString(),
    });
    storageState.saveCalls.push({
      bucketName: this.bucketName,
      objectName: this.name,
      bytes: buffer,
      options,
    });
  }

  createWriteStream(options: Record<string, unknown> = {}): Writable {
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        const bucket = getBucketObjects(this.bucketName);
        const ifGenerationMatch = (
          options.preconditionOpts as { ifGenerationMatch?: unknown } | undefined
        )?.ifGenerationMatch;
        if (ifGenerationMatch === 0 && bucket.has(this.name)) {
          callback(createStorageError(412, "Precondition Failed"));
          return;
        }
        const bytes = Buffer.concat(chunks);
        bucket.set(this.name, {
          bytes,
          metadata: normaliseStoredMetadata(
            options.metadata as Record<string, unknown> | undefined,
          ),
          timeCreated: new Date().toISOString(),
        });
        storageState.saveCalls.push({
          bucketName: this.bucketName,
          objectName: this.name,
          bytes,
          options,
        });
        callback();
      },
    });
  }

  async setMetadata(metadata: Record<string, unknown>): Promise<void> {
    const bucket = getBucketObjects(this.bucketName);
    const existing = bucket.get(this.name);
    if (!existing) {
      throw createStorageError(404, "Not Found");
    }
    bucket.set(this.name, {
      ...existing,
      metadata: normaliseStoredMetadata(metadata),
    });
  }

  async getMetadata(): Promise<[Record<string, unknown>]> {
    const bucket = getBucketObjects(this.bucketName);
    const existing = bucket.get(this.name);
    if (!existing) {
      throw createStorageError(404, "Not Found");
    }
    return [
      {
        size: existing.bytes.byteLength.toString(),
        timeCreated: existing.timeCreated,
        contentType: existing.metadata.contentType,
        contentDisposition: existing.metadata.contentDisposition,
        metadata: existing.metadata.metadata,
      },
    ];
  }

  async download(): Promise<[Buffer]> {
    const bucket = getBucketObjects(this.bucketName);
    const existing = bucket.get(this.name);
    if (!existing) {
      throw createStorageError(404, "Not Found");
    }
    return [Buffer.from(existing.bytes)];
  }

  async delete(options: { ignoreNotFound?: boolean } = {}): Promise<void> {
    const bucket = getBucketObjects(this.bucketName);
    if (!bucket.has(this.name)) {
      if (options.ignoreNotFound) {
        return;
      }
      throw createStorageError(404, "Not Found");
    }
    bucket.delete(this.name);
    storageState.deleteCalls.push({
      bucketName: this.bucketName,
      objectName: this.name,
    });
  }

  async getSignedUrl(options: Record<string, unknown>): Promise<[string]> {
    const url = buildSignedUrl(this.bucketName, this.name);
    storageState.signedUrlCalls.push({
      bucketName: this.bucketName,
      objectName: this.name,
      options,
      url,
    });
    return [url];
  }
}

class MockBucket {
  constructor(private readonly bucketName: string) {}

  file(objectName: string): MockFile {
    return new MockFile(this.bucketName, objectName);
  }

  async getFiles(options: { prefix?: string; maxResults?: number }): Promise<[MockFile[]]> {
    const objects = Array.from(getBucketObjects(this.bucketName).keys())
      .filter((name) => !options.prefix || name.startsWith(options.prefix))
      .slice(0, options.maxResults ?? Number.POSITIVE_INFINITY)
      .map((name) => new MockFile(this.bucketName, name));
    return [objects];
  }
}

export class Storage {
  bucket(bucketName: string): MockBucket {
    return new MockBucket(bucketName);
  }
}

export function resetMockStorageState(): void {
  storageState.buckets.clear();
  storageState.saveCalls = [];
  storageState.signedUrlCalls = [];
  storageState.deleteCalls = [];
}

export function getMockStorageState(): MockStorageState {
  return storageState;
}

export function installMockStorageEnv(): void {
  process.env.LLM_FILES_GCS_BUCKET = "llm-test-bucket";
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: "test-project",
    client_email: "test@example.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
  });
}
