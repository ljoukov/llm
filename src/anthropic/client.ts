import { loadLocalEnv } from "../utils/env.js";
import { createRetryingFetch } from "../utils/retryFetch.js";
import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const retryingFetches = getRuntimeSingleton(
  Symbol.for("@ljoukov/llm.anthropicRetryingFetches"),
  () => new WeakMap<typeof fetch, typeof fetch>(),
);

function getRetryingFetch(): typeof fetch {
  const fetchImpl = fetch;
  const existing = retryingFetches.get(fetchImpl);
  if (existing) {
    return existing;
  }
  const retryingFetch = createRetryingFetch(fetchImpl, { scope: "anthropic", maxAttempts: 4 });
  retryingFetches.set(fetchImpl, retryingFetch);
  return retryingFetch;
}

export type AnthropicTextBlock = {
  type: "text";
  text: string;
  citations?: Record<string, unknown>[];
  cache_control?: Record<string, unknown>;
};

export type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type AnthropicRedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
};

export type AnthropicImageBlock = {
  type: "image";
  source: Record<string, unknown>;
};

export type AnthropicDocumentBlock = {
  type: "document";
  source: Record<string, unknown>;
  title?: string;
  context?: string;
  citations?: { enabled: boolean };
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock;

export type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
};

export type AnthropicMessageRequest = {
  model: string;
  speed?: "standard" | "fast";
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?:
    | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
    | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budget_tokens: number; display?: "summarized" | "omitted" }
    | { type: "disabled" };
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    format?: Record<string, unknown>;
  };
  temperature?: number;
  stop_sequences?: string[];
};

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Inference speed actually used; independent of the capacity service tier. */
  speed?: "standard" | "fast";
  service_tier?: string;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
};

export type AnthropicMessage = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

export type AnthropicStreamOptions = {
  signal?: AbortSignal;
  onDelta?: (channel: "response" | "thought", text: string) => void;
};

export class AnthropicApiError extends Error {
  readonly status?: number;
  readonly headers?: Headers;

  constructor(message: string, status?: number, headers?: Headers) {
    super(message);
    this.name = "AnthropicApiError";
    this.status = status;
    this.headers = headers;
  }
}

function resolveApiKey(): string {
  loadLocalEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY must be provided to access Anthropic APIs.");
  }
  return apiKey;
}

function safeErrorMessage(message: unknown, apiKey: string): string {
  if (typeof message !== "string") {
    return "Unknown provider error";
  }
  return message
    .replaceAll(apiKey, "[redacted]")
    .replace(/sk-ant-[\w-]+/gu, "[redacted]")
    .slice(0, 1000);
}

function errorHeaders(response: Response, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (
      name === "retry-after" ||
      name === "retry-after-ms" ||
      name === "request-id" ||
      name === "x-request-id" ||
      name === "x-should-retry" ||
      name.startsWith("anthropic-ratelimit-")
    ) {
      headers.set(name, safeErrorMessage(value, apiKey));
    }
  }
  return headers;
}

function mergeUsage(current: AnthropicUsage, update: Partial<AnthropicUsage>): AnthropicUsage {
  return {
    ...current,
    ...update,
    ...(update.cache_creation
      ? { cache_creation: { ...current.cache_creation, ...update.cache_creation } }
      : {}),
    ...(update.server_tool_use
      ? { server_tool_use: { ...current.server_tool_use, ...update.server_tool_use } }
      : {}),
  };
}

/** Retries rejected HTTP requests before handing an accepted stream to its consumer. */
export class AnthropicClient {
  async streamMessage(
    request: AnthropicMessageRequest,
    options: AnthropicStreamOptions = {},
  ): Promise<AnthropicMessage> {
    const apiKey = resolveApiKey();
    const response = await getRetryingFetch()(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal: options.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = (await response.json()) as { error?: { message?: unknown } };
        if (typeof payload.error?.message === "string") {
          detail = `: ${safeErrorMessage(payload.error.message, apiKey)}`;
        }
      } catch {
        // Some gateways return non-JSON failures; the status is sufficient context.
      }
      throw new AnthropicApiError(
        `Anthropic API request failed (HTTP ${response.status})${detail}`,
        response.status,
        errorHeaders(response, apiKey),
      );
    }
    if (!response.body) {
      throw new AnthropicApiError("Anthropic API returned an empty streaming response.");
    }

    let message: AnthropicMessage | undefined;
    let stopped = false;
    let dataLines: string[] = [];
    let eventName = "";
    const partialInputs = new Map<number, string>();
    const openBlocks = new Set<number>();

    const finishBlock = (index: number): void => {
      const partialInput = partialInputs.get(index);
      const block = message?.content[index];
      if (partialInput && block?.type === "tool_use") {
        try {
          const input: unknown = JSON.parse(partialInput);
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new Error("Tool input must be an object");
          }
          block.input = input as Record<string, unknown>;
        } catch {
          throw new AnthropicApiError("Anthropic stream returned invalid tool input JSON.");
        }
      }
      partialInputs.delete(index);
      openBlocks.delete(index);
    };

    const dispatchEvent = (): void => {
      const data = dataLines.join("\n");
      dataLines = [];
      const fallbackType = eventName;
      eventName = "";
      if (!data) {
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          throw new Error("Invalid event object");
        }
      } catch {
        throw new AnthropicApiError("Anthropic stream returned invalid event JSON.");
      }
      const type = event.type ?? fallbackType;
      if (type === "error") {
        const error = event.error as { type?: string; message?: string } | undefined;
        throw new AnthropicApiError(
          `Anthropic stream error: ${safeErrorMessage(error?.message ?? error?.type, apiKey)}`,
        );
      }
      if (type === "message_start") {
        if (message) {
          throw new AnthropicApiError("Anthropic stream returned multiple message_start events.");
        }
        const initial = event.message as AnthropicMessage | undefined;
        if (!initial || !Array.isArray(initial.content)) {
          throw new AnthropicApiError("Anthropic stream returned an invalid message_start event.");
        }
        message = {
          ...initial,
          content: initial.content.map((block) => ({ ...block })),
          usage: mergeUsage({ input_tokens: 0, output_tokens: 0 }, initial.usage ?? {}),
        };
        return;
      }
      if (
        type !== "content_block_start" &&
        type !== "content_block_delta" &&
        type !== "content_block_stop" &&
        type !== "message_delta" &&
        type !== "message_stop"
      ) {
        // Anthropic may add new event types; ping and unknown events carry no message state.
        return;
      }
      if (!message || stopped) {
        throw new AnthropicApiError("Anthropic stream returned events outside an active message.");
      }
      if (type === "content_block_start") {
        const index = event.index as number;
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          !event.content_block ||
          message.content[index]
        ) {
          throw new AnthropicApiError("Anthropic stream returned an invalid content block.");
        }
        const block = { ...(event.content_block as AnthropicContentBlock) };
        message.content[index] = block;
        openBlocks.add(index);
        if (block.type === "text" && block.text) {
          options.onDelta?.("response", block.text);
        } else if (block.type === "thinking" && block.thinking) {
          options.onDelta?.("thought", block.thinking);
        }
        return;
      }
      if (type === "content_block_delta" || type === "content_block_stop") {
        const index = event.index as number;
        const block = message.content[index];
        if (!Number.isInteger(index) || !block || !openBlocks.has(index)) {
          throw new AnthropicApiError("Anthropic stream returned a delta for an inactive block.");
        }
        if (type === "content_block_stop") {
          finishBlock(index);
          return;
        }
        const delta = event.delta as Record<string, unknown> | undefined;
        if (
          delta?.type === "text_delta" &&
          block.type === "text" &&
          typeof delta.text === "string"
        ) {
          block.text += delta.text;
          options.onDelta?.("response", delta.text);
        } else if (
          delta?.type === "thinking_delta" &&
          block.type === "thinking" &&
          typeof delta.thinking === "string"
        ) {
          block.thinking += delta.thinking;
          options.onDelta?.("thought", delta.thinking);
        } else if (
          delta?.type === "signature_delta" &&
          block.type === "thinking" &&
          typeof delta.signature === "string"
        ) {
          block.signature += delta.signature;
        } else if (
          delta?.type === "input_json_delta" &&
          block.type === "tool_use" &&
          typeof delta.partial_json === "string"
        ) {
          partialInputs.set(index, (partialInputs.get(index) ?? "") + delta.partial_json);
        } else if (delta?.type === "citations_delta" && block.type === "text" && delta.citation) {
          block.citations = [...(block.citations ?? []), delta.citation as Record<string, unknown>];
        }
        return;
      }
      if (type === "message_delta") {
        const delta = event.delta as Partial<AnthropicMessage> | undefined;
        if (delta?.stop_reason !== undefined) {
          message.stop_reason = delta.stop_reason;
        }
        if (delta?.stop_sequence !== undefined) {
          message.stop_sequence = delta.stop_sequence;
        }
        message.usage = mergeUsage(message.usage, (event.usage as Partial<AnthropicUsage>) ?? {});
        return;
      }
      if (openBlocks.size > 0) {
        throw new AnthropicApiError("Anthropic stream ended with unfinished content blocks.");
      }
      stopped = true;
    };

    const consumeLine = (line: string): void => {
      if (line === "") {
        dispatchEvent();
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const rawValue = colon < 0 ? "" : line.slice(colon + 1);
        const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
        if (field === "data") {
          dataLines.push(value);
        } else if (field === "event") {
          eventName = value;
        }
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consumeBuffer = (final: boolean): void => {
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (char !== "\n" && char !== "\r") {
          continue;
        }
        if (char === "\r" && index === buffer.length - 1 && !final) {
          break;
        }
        consumeLine(buffer.slice(start, index));
        if (char === "\r" && buffer[index + 1] === "\n") {
          index += 1;
        }
        start = index + 1;
      }
      buffer = buffer.slice(start);
      if (final && buffer) {
        consumeLine(buffer);
        buffer = "";
      }
    };

    try {
      while (!stopped) {
        options.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          consumeBuffer(true);
          dispatchEvent();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        consumeBuffer(false);
      }
      if (!message || !stopped) {
        throw new AnthropicApiError("Anthropic stream ended before message_stop.");
      }
      return message;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Preserve the provider, parsing, callback, or abort error.
      }
      reader.releaseLock();
    }
  }
}

export function getAnthropicClient(): AnthropicClient {
  return getRuntimeSingleton(
    Symbol.for("@ljoukov/llm.anthropicClient"),
    () => new AnthropicClient(),
  );
}
