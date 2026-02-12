import os from "node:os";
import { TextDecoder } from "node:util";

import { getChatGptAuthProfile } from "./chatgpt-auth.js";

const CHATGPT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export type ChatGptInputTextPart = {
  type: "input_text";
  text: string;
};

export type ChatGptOutputTextPart = {
  type: "output_text";
  text: string;
};

export type ChatGptInputImagePart = {
  type: "input_image";
  image_url: string | { url: string };
  detail?: "auto";
};

export type ChatGptInputFilePart = {
  type: "input_file";
  file_data?: string | null;
  file_id?: string | null;
  file_url?: string | null;
  filename?: string | null;
};

export type ChatGptInputMessagePart =
  | ChatGptInputTextPart
  | ChatGptOutputTextPart
  | ChatGptInputImagePart
  | ChatGptInputFilePart;

export type ChatGptInputMessage = {
  role: "user" | "assistant";
  content: string | ChatGptInputMessagePart[];
  type?: "message";
  status?: "completed";
};

export type ChatGptFunctionCall = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: "completed";
};

export type ChatGptCustomToolCall = {
  type: "custom_tool_call";
  id: string;
  call_id: string;
  name: string;
  input: string;
  status?: "completed";
};

export type ChatGptFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type ChatGptCustomToolCallOutput = {
  type: "custom_tool_call_output";
  call_id: string;
  output: string;
};

export type ChatGptInputItem =
  | ChatGptInputMessage
  | ChatGptFunctionCall
  | ChatGptCustomToolCall
  | ChatGptFunctionCallOutput
  | ChatGptCustomToolCallOutput;

export type ChatGptCodexRequest = {
  model: string;
  store: boolean;
  stream: boolean;
  instructions?: string;
  input: ChatGptInputItem[];
  text?: { verbosity?: string; format?: unknown };
  include?: string[];
  prompt_cache_key?: string;
  tool_choice?: "auto" | "required" | "none";
  parallel_tool_calls?: boolean;
  temperature?: number;
  tools?: unknown[];
  reasoning?: { effort: string; summary: string };
};

export type ChatGptCodexStreamEvent = {
  type?: string;
  [key: string]: unknown;
};

export type ChatGptCodexUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
};

export type ChatGptCodexToolCall =
  | {
      kind: "function";
      id: string;
      callId: string;
      name: string;
      arguments: string;
    }
  | {
      kind: "custom";
      id: string;
      callId: string;
      name: string;
      input: string;
    };

export type ChatGptCodexWebSearchAction = {
  type: string;
  query?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
  sources?: Array<{ url: string }>;
};

export type ChatGptCodexWebSearchCall = {
  id: string;
  status?: string;
  action?: ChatGptCodexWebSearchAction;
};

export type ChatGptCodexCollectedResponse = {
  text: string;
  reasoningText: string;
  reasoningSummaryText: string;
  toolCalls: ChatGptCodexToolCall[];
  webSearchCalls: ChatGptCodexWebSearchCall[];
  usage?: ChatGptCodexUsage;
  id?: string;
  model?: string;
  status?: string;
  blocked: boolean;
};

export type ChatGptCodexDelta = {
  textDelta?: string;
  thoughtDelta?: string;
};

export async function streamChatGptCodexResponse(options: {
  request: ChatGptCodexRequest;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AsyncIterable<ChatGptCodexStreamEvent>> {
  const { access, accountId } = await getChatGptAuthProfile();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "llm",
    "User-Agent": buildUserAgent(),
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (options.sessionId) {
    headers.session_id = options.sessionId;
  }
  const response = await fetch(CHATGPT_CODEX_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(options.request),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ChatGPT Codex request failed (${response.status}): ${body}`);
  }
  const body = response.body;
  if (!body) {
    throw new Error("ChatGPT Codex response body was empty.");
  }
  return parseEventStream(body);
}

export async function collectChatGptCodexResponse(options: {
  request: ChatGptCodexRequest;
  sessionId?: string;
  signal?: AbortSignal;
  onDelta?: (delta: ChatGptCodexDelta) => void;
}): Promise<ChatGptCodexCollectedResponse> {
  const stream = await streamChatGptCodexResponse(options);
  const toolCalls = new Map<string, ChatGptCodexToolCall>();
  const toolCallOrder: string[] = [];
  const webSearchCalls = new Map<string, ChatGptCodexWebSearchCall>();
  const webSearchCallOrder: string[] = [];
  let text = "";
  const reasoningText = "";
  let reasoningSummaryText = "";
  let usage: ChatGptCodexUsage | undefined;
  let responseId: string | undefined;
  let model: string | undefined;
  let status: string | undefined;
  let blocked = false;
  for await (const event of stream) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta.length > 0) {
        text += delta;
        options.onDelta?.({ textDelta: delta });
      }
      continue;
    }
    if (type === "response.reasoning_summary_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta.length > 0) {
        reasoningSummaryText += delta;
        options.onDelta?.({ thoughtDelta: delta });
      }
      continue;
    }
    if (type === "response.reasoning_text.delta") {
      // Avoid collecting chain-of-thought; summaries are handled separately above.
      continue;
    }
    if (type === "response.refusal.delta") {
      blocked = true;
      continue;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item) {
        if (item.type === "function_call") {
          const id = typeof item.id === "string" ? item.id : "";
          const callId = typeof item.call_id === "string" ? item.call_id : id;
          const name = typeof item.name === "string" ? item.name : "";
          const args = typeof item.arguments === "string" ? item.arguments : "";
          if (callId) {
            if (!toolCalls.has(callId)) {
              toolCallOrder.push(callId);
            }
            toolCalls.set(callId, { kind: "function", id, callId, name, arguments: args });
          }
        } else if (item.type === "custom_tool_call") {
          const id = typeof item.id === "string" ? item.id : "";
          const callId = typeof item.call_id === "string" ? item.call_id : id;
          const name = typeof item.name === "string" ? item.name : "";
          const input = typeof item.input === "string" ? item.input : "";
          if (callId) {
            if (!toolCalls.has(callId)) {
              toolCallOrder.push(callId);
            }
            toolCalls.set(callId, { kind: "custom", id, callId, name, input });
          }
        } else if (item.type === "web_search_call") {
          const id = typeof item.id === "string" ? item.id : "";
          if (id) {
            if (!webSearchCalls.has(id)) {
              webSearchCallOrder.push(id);
            }
            webSearchCalls.set(id, {
              id,
              status: typeof item.status === "string" ? item.status : undefined,
              action:
                item.action && typeof item.action === "object"
                  ? (item.action as ChatGptCodexWebSearchAction)
                  : undefined,
            });
          }
        }
      }
      continue;
    }
    if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      if (response) {
        usage = response.usage as ChatGptCodexUsage | undefined;
        responseId = typeof response.id === "string" ? response.id : responseId;
        model = typeof response.model === "string" ? response.model : undefined;
        status = typeof response.status === "string" ? response.status : undefined;
      }
      continue;
    }
    if (type === "response.failed") {
      const response = event.response as Record<string, unknown> | undefined;
      if (response) {
        usage = response.usage as ChatGptCodexUsage | undefined;
        responseId = typeof response.id === "string" ? response.id : responseId;
        model = typeof response.model === "string" ? response.model : undefined;
        status = typeof response.status === "string" ? response.status : undefined;
      }
      continue;
    }
    if (type === "response.in_progress") {
      const response = event.response as Record<string, unknown> | undefined;
      if (response) {
        usage = response.usage as ChatGptCodexUsage | undefined;
        responseId = typeof response.id === "string" ? response.id : responseId;
        model = typeof response.model === "string" ? response.model : undefined;
        status = typeof response.status === "string" ? response.status : undefined;
      }
    }
  }

  // Fallback: if we never received the summary delta, preserve reasoningText.
  if (!reasoningSummaryText && reasoningText) {
    reasoningSummaryText = reasoningText;
  }

  const orderedToolCalls = toolCallOrder
    .map((id) => toolCalls.get(id))
    .filter((call): call is ChatGptCodexToolCall => call !== undefined);
  const orderedWebSearchCalls = webSearchCallOrder
    .map((id) => webSearchCalls.get(id))
    .filter((call): call is ChatGptCodexWebSearchCall => call !== undefined);

  return {
    text,
    reasoningText,
    reasoningSummaryText,
    toolCalls: orderedToolCalls,
    webSearchCalls: orderedWebSearchCalls,
    usage,
    id: responseId,
    model,
    status,
    blocked,
  };
}

function buildUserAgent(): string {
  const node = process.version;
  const platform = os.platform();
  const release = os.release();
  return `@ljoukov/llm (node ${node}; ${platform} ${release})`;
}

async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ChatGptCodexStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let sepIndex = buffer.indexOf("\n\n");
    while (sepIndex !== -1) {
      const raw = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const event = parseEventBlock(raw);
      if (event) {
        yield event;
      }
      sepIndex = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim().length > 0) {
    const event = parseEventBlock(buffer);
    if (event) {
      yield event;
    }
  }
}

function parseEventBlock(raw: string): ChatGptCodexStreamEvent | null {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) {
    return null;
  }
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(payload) as ChatGptCodexStreamEvent;
  } catch {
    return null;
  }
}
