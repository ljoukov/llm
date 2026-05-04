import { toFile } from "openai";

import { runOpenAiCall } from "./calls.js";

export type LlmOpenAiContainerNetworkPolicy =
  | { readonly type: "disabled" }
  | {
      readonly type: "allowlist";
      readonly allowedDomains: readonly string[];
      readonly domainSecrets?: readonly {
        readonly domain: string;
        readonly name: string;
        readonly value: string;
      }[];
    };

export type LlmOpenAiContainerCreateOptions = {
  readonly name: string;
  readonly fileIds?: readonly string[];
  readonly memoryLimit?: "1g" | "4g" | "16g" | "64g";
  readonly networkPolicy?: LlmOpenAiContainerNetworkPolicy;
  readonly expiresAfterMinutes?: number;
};

export type LlmOpenAiContainer = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt?: number;
  readonly lastActiveAt?: number;
  readonly memoryLimit?: "1g" | "4g" | "16g" | "64g";
};

export type LlmOpenAiContainerFile = {
  readonly id: string;
  readonly containerId: string;
  readonly path: string;
  readonly bytes?: number | null;
  readonly createdAt?: number;
  readonly source?: string;
};

export type LlmOpenAiContainerFileUpload = {
  readonly containerId: string;
  readonly filename: string;
  readonly data: ArrayBuffer | ArrayBufferView | Blob | Response | AsyncIterable<ArrayBufferView>;
  readonly mimeType?: string;
};

function toOpenAiContainerNetworkPolicy(
  policy: LlmOpenAiContainerNetworkPolicy | undefined,
): Record<string, unknown> | undefined {
  if (!policy) {
    return undefined;
  }
  if (policy.type === "disabled") {
    return { type: "disabled" };
  }
  return {
    type: "allowlist",
    allowed_domains: Array.from(policy.allowedDomains),
    ...(policy.domainSecrets
      ? {
          domain_secrets: policy.domainSecrets.map((secret) => ({
            domain: secret.domain,
            name: secret.name,
            value: secret.value,
          })),
        }
      : {}),
  };
}

function toContainer(container: Record<string, unknown>): LlmOpenAiContainer {
  return {
    id: String(container.id),
    name: typeof container.name === "string" ? container.name : "",
    status: typeof container.status === "string" ? container.status : "",
    ...(typeof container.created_at === "number" ? { createdAt: container.created_at } : {}),
    ...(typeof container.last_active_at === "number"
      ? { lastActiveAt: container.last_active_at }
      : {}),
    ...(typeof container.memory_limit === "string"
      ? { memoryLimit: container.memory_limit as LlmOpenAiContainer["memoryLimit"] }
      : {}),
  };
}

function toContainerFile(file: Record<string, unknown>): LlmOpenAiContainerFile {
  return {
    id: String(file.id),
    containerId: typeof file.container_id === "string" ? file.container_id : "",
    path: typeof file.path === "string" ? file.path : "",
    ...(typeof file.bytes === "number" || file.bytes === null ? { bytes: file.bytes } : {}),
    ...(typeof file.created_at === "number" ? { createdAt: file.created_at } : {}),
    ...(typeof file.source === "string" ? { source: file.source } : {}),
  };
}

export async function createOpenAiContainer(
  options: LlmOpenAiContainerCreateOptions,
): Promise<LlmOpenAiContainer> {
  const container = await runOpenAiCall(
    async (client) =>
      await client.containers.create({
        name: options.name,
        ...(options.fileIds ? { file_ids: Array.from(options.fileIds) } : {}),
        ...(options.memoryLimit ? { memory_limit: options.memoryLimit } : {}),
        ...(options.networkPolicy
          ? { network_policy: toOpenAiContainerNetworkPolicy(options.networkPolicy) as any }
          : {}),
        ...(options.expiresAfterMinutes
          ? {
              expires_after: {
                anchor: "last_active_at",
                minutes: options.expiresAfterMinutes,
              },
            }
          : {}),
      }),
    "openai-containers",
  );
  return toContainer(container as unknown as Record<string, unknown>);
}

export async function deleteOpenAiContainer(containerId: string): Promise<void> {
  await runOpenAiCall(
    async (client) => await client.containers.delete(containerId),
    "openai-containers",
  );
}

export async function listOpenAiContainerFiles(
  containerId: string,
): Promise<readonly LlmOpenAiContainerFile[]> {
  const files: LlmOpenAiContainerFile[] = [];
  await runOpenAiCall(async (client) => {
    for await (const file of client.containers.files.list(containerId)) {
      files.push(toContainerFile(file as unknown as Record<string, unknown>));
    }
  }, "openai-containers");
  return files;
}

export async function uploadOpenAiContainerFile(
  upload: LlmOpenAiContainerFileUpload,
): Promise<LlmOpenAiContainerFile> {
  const file = await toFile(upload.data as any, upload.filename, {
    ...(upload.mimeType ? { type: upload.mimeType } : {}),
  });
  const created = await runOpenAiCall(
    async (client) => await client.containers.files.create(upload.containerId, { file }),
    "openai-containers",
  );
  return toContainerFile(created as unknown as Record<string, unknown>);
}

export async function downloadOpenAiContainerFile(params: {
  readonly containerId: string;
  readonly fileId: string;
}): Promise<Uint8Array> {
  const response = await runOpenAiCall(
    async (client) =>
      await client.containers.files.content.retrieve(params.fileId, {
        container_id: params.containerId,
      }),
    "openai-containers",
  );
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadOpenAiContainerFileText(params: {
  readonly containerId: string;
  readonly fileId: string;
}): Promise<string> {
  const bytes = await downloadOpenAiContainerFile(params);
  return new TextDecoder().decode(bytes);
}
