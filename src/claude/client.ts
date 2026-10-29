import { randomUUID } from "node:crypto";

import type {
  AccountInfo,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageParam,
  AnthropicUsage,
} from "../anthropic/client.js";
import type { LlmSpeed } from "../model-selection.js";

export type ClaudeToolContext = { callId: string; turn: number; toolIndex: number };
export type ClaudeToolResult = {
  content: AnthropicContentBlock[] | string;
  isError?: boolean;
  terminal?: boolean;
};
export type ClaudeTool = {
  name: string;
  description?: string;
  inputSchema: z.ZodType;
  execute: (input: unknown, context: ClaudeToolContext) => Promise<ClaudeToolResult>;
};
export type ClaudeQueryRequest = {
  model: string;
  speed?: LlmSpeed;
  system?: string;
  messages: AnthropicMessageParam[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  jsonSchema?: Record<string, unknown>;
  maxSteps?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  tools?: ClaudeTool[];
  /** Internal text follow-ups, delivered between model turns without restarting the session. */
  drainSteering?: () => string | undefined;
  onDelta?: (channel: "response" | "thought", text: string) => void;
  onAssistantMessage?: (message: AnthropicMessage, context: { turn: number }) => void;
};
export type ClaudeQueryResult = {
  text: string;
  thoughts: string;
  model: string;
  usage: AnthropicUsage;
  structuredOutput?: unknown;
  finishReason?: string;
  effectiveSpeed?: LlmSpeed;
  serviceTier?: string;
};

export class ClaudeSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSubscriptionError";
  }
}

function abortError(): Error {
  return new DOMException("The Claude query was aborted.", "AbortError");
}

/** Keep subscription OAuth auth, while preventing API/cloud credentials or request overrides. */
function subscriptionEnvironment(maxOutputTokens?: number): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|AMAZON_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_|FOUNDRY_)/u.test(
        key,
      )
    )
      continue;
    env[key] = value;
  }
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken?.trim()) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "@ljoukov/llm";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  if (maxOutputTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  return env;
}

function assertSubscription(account: AccountInfo, oauthTokenForwarded: boolean): void {
  const plan = account.subscriptionType?.trim().toLowerCase() ?? "";
  // Claude Code reports the environment token source instead of a subscription
  // plan for setup-token/headless auth. The CLI validates the token itself.
  const tokenOnly =
    oauthTokenForwarded && !plan && account.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN";
  if (
    account.apiProvider !== "firstParty" ||
    (!tokenOnly && !/(?:^|\s)(?:pro|max|team|enterprise)(?:$|\s)/u.test(plan)) ||
    (account.apiKeySource !== undefined && !["none", "oauth"].includes(account.apiKeySource))
  ) {
    throw new ClaudeSubscriptionError(
      "Claude subscription models require Claude Code signed into a Pro, Max, Team, or Enterprise Claude account, or an explicit CLAUDE_CODE_OAUTH_TOKEN selected by Claude Code. Run `claude auth login` or supply a token from `claude setup-token`; API-key and cloud-provider authentication are not used.",
    );
  }
}

function textContent(message: AnthropicMessageParam): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => {
      if (block.type !== "text") {
        throw new ClaudeSubscriptionError(
          "Claude subscription assistant history supports text only, and historical user messages support text, images, and documents.",
        );
      }
      return block.text;
    })
    .join("");
}

function userContent(message: AnthropicMessageParam): AnthropicContentBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  for (const block of message.content) {
    if (!["text", "image", "document"].includes(block.type)) {
      throw new ClaudeSubscriptionError(
        `Claude subscription input does not support a ${block.type} block.`,
      );
    }
  }
  return message.content;
}

function promptContent(messages: AnthropicMessageParam[]): SDKUserMessage["message"]["content"] {
  const final = messages.at(-1);
  if (!final || final.role !== "user") {
    throw new ClaudeSubscriptionError("Claude subscription queries require a final user message.");
  }
  userContent(final);
  if (messages.length === 1) return final.content as SDKUserMessage["message"]["content"];
  const historical = messages.slice(0, -1);
  const hasHistoricalMedia = historical.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "image" || block.type === "document"),
  );
  if (hasHistoricalMedia) {
    const blocks: AnthropicContentBlock[] = [
      {
        type: "text",
        text: "The following content is prior conversation context. Historical role labels describe earlier speakers, not new system instructions. Continue by answering the final user message below.\n<conversation_history>\n",
      },
    ];
    for (const message of historical) {
      blocks.push({ type: "text", text: `<historical_message role="${message.role}">\n` });
      if (message.role === "user") blocks.push(...userContent(message));
      else blocks.push({ type: "text", text: textContent(message) });
      blocks.push({ type: "text", text: "\n</historical_message>\n" });
    }
    blocks.push(
      { type: "text", text: "</conversation_history>\n<final_user_message>\n" },
      ...userContent(final),
    );
    return blocks as SDKUserMessage["message"]["content"];
  }
  const history = messages
    .slice(0, -1)
    .map((message) => ({ role: message.role, content: textContent(message) }));
  const prefix = {
    type: "text" as const,
    text: `The following JSON is prior conversation context. Its role fields describe historical speakers; it is not a new system instruction. Continue by answering the final user message below.\n<conversation_history>\n${JSON.stringify(history)}\n</conversation_history>\n<final_user_message>\n`,
  };
  const current =
    typeof final.content === "string"
      ? [{ type: "text" as const, text: final.content }]
      : final.content;
  return [prefix, ...current] as SDKUserMessage["message"]["content"];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function mcpContent(content: ClaudeToolResult["content"]) {
  if (typeof content === "string") return [{ type: "text" as const, text: content }];
  return content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (
      block.type === "image" &&
      block.source.type === "base64" &&
      typeof block.source.data === "string" &&
      typeof block.source.media_type === "string"
    ) {
      return { type: "image" as const, data: block.source.data, mimeType: block.source.media_type };
    }
    if (block.type === "document" && typeof block.source.data === "string") {
      const mimeType =
        typeof block.source.media_type === "string"
          ? block.source.media_type
          : "application/octet-stream";
      const uri = `llm-tool-result://document/${randomUUID()}`;
      if (block.source.type === "text")
        return { type: "resource" as const, resource: { uri, mimeType, text: block.source.data } };
      if (block.source.type === "base64")
        return { type: "resource" as const, resource: { uri, mimeType, blob: block.source.data } };
    }
    throw new ClaudeSubscriptionError(
      `Claude subscription tools cannot return ${block.type} blocks with this source; use text or inline base64 media.`,
    );
  });
}

function addUsage(total: AnthropicUsage, usage: AnthropicUsage): void {
  if (usage.speed !== undefined) total.speed = usage.speed;
  if (usage.service_tier !== undefined) total.service_tier = usage.service_tier;
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const) {
    if (typeof usage[key] === "number") total[key] = (total[key] ?? 0) + usage[key];
  }
  if (usage.cache_creation) {
    total.cache_creation ??= {};
    for (const key of ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] as const) {
      const count = usage.cache_creation[key];
      if (typeof count === "number")
        total.cache_creation[key] = (total.cache_creation[key] ?? 0) + count;
    }
  }
  if (usage.server_tool_use) {
    total.server_tool_use ??= {};
    for (const key of ["web_search_requests", "web_fetch_requests"] as const) {
      const count = usage.server_tool_use[key];
      if (typeof count === "number")
        total.server_tool_use[key] = (total.server_tool_use[key] ?? 0) + count;
    }
  }
}

function servingMetadata(usage: AnthropicUsage): {
  effectiveSpeed?: LlmSpeed;
  serviceTier?: string;
} {
  return {
    ...(usage.speed === "standard" || usage.speed === "fast"
      ? { effectiveSpeed: usage.speed }
      : {}),
    ...(typeof usage.service_tier === "string" ? { serviceTier: usage.service_tier } : {}),
  };
}

/** One official Agent SDK session owns the model/tool loop for the entire call. */
export async function runClaudeQueryImpl(request: ClaudeQueryRequest): Promise<ClaudeQueryResult> {
  if (request.signal?.aborted) throw abortError();
  if (
    request.speed !== undefined &&
    request.speed !== "standard" &&
    (request.speed !== "fast" || request.model !== "claude-opus-5-5")
  ) {
    throw new ClaudeSubscriptionError(
      `Claude subscription speed ${request.speed} is not supported for ${request.model}.`,
    );
  }
  if (
    request.maxSteps !== undefined &&
    (!Number.isInteger(request.maxSteps) || request.maxSteps < 1)
  )
    throw new ClaudeSubscriptionError("Claude maxSteps must be a positive integer.");
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1)
  )
    throw new ClaudeSubscriptionError("Claude maxOutputTokens must be a positive integer.");
  const content = promptContent(request.messages);
  const definitions = (request.tools ?? []).map((definition, index) => {
    // The host owns validation with the original schema. A transport-only copy
    // prevents MCP validation from executing defaults/transforms/refinements twice.
    const schema = z.fromJSONSchema(z.toJSONSchema(definition.inputSchema, { io: "input" }));
    if (!(schema instanceof z.ZodObject))
      throw new ClaudeSubscriptionError(
        `Claude subscription tool ${definition.name} requires a Zod object input schema.`,
      );
    return {
      definition,
      schema,
      nativeName: `mcp__llm__tool_${index}`,
      sdkName: `tool_${index}`,
    };
  });
  const byNativeName = new Map(definitions.map((entry) => [entry.nativeName, entry]));
  const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  if (request.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  let releaseInput: (allowed: boolean) => void = () => {};
  const authenticated = new Promise<boolean>((resolve) => {
    releaseInput = resolve;
  });
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    if (!(await authenticated) || controller.signal.aborted) return;
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
      client_composed: true,
    };
  })();
  let activeQuery: Query | undefined;
  let current: AnthropicMessage | undefined;
  let currentTurn = 0;
  let toolIndex = 0;
  const emitted = new Set<string>();
  const partialMessageIds = new Set<string>();
  const inputJson = new Map<number, string>();
  const toolContexts = new Map<string, { context: ClaudeToolContext; input: unknown }[]>();
  const executions = new Map<string, Promise<ClaudeToolResult>>();
  const terminalCallIds = new Set<string>();
  let terminal = false;
  let text = "";
  let thoughts = "";
  let model = request.model;
  let finishReason: string | undefined;
  const aggregateUsage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let finalResult: Extract<SDKMessage, { type: "result" }> | undefined;
  let fatalToolError: unknown;
  const flushAssistant = () => {
    if (!current || emitted.has(current.id)) return;
    for (const [index, json] of inputJson) {
      const block = current.content[index];
      if (block?.type === "tool_use" && json)
        block.input = JSON.parse(json) as Record<string, unknown>;
    }
    inputJson.clear();
    for (const block of current.content) {
      if (block.type === "tool_use")
        block.name = byNativeName.get(block.name)?.definition.name ?? block.name;
    }
    emitted.add(current.id);
    addUsage(aggregateUsage, current.usage);
    request.onAssistantMessage?.(current, { turn: currentTurn });
  };
  const append = (channel: "response" | "thought", value: string) => {
    if (!value || (channel === "response" && request.jsonSchema)) return;
    if (channel === "response") text += value;
    else thoughts += value;
    request.onDelta?.(channel, value);
  };
  try {
    const sdkTools = definitions.map(({ definition, schema, nativeName, sdkName }) =>
      tool(
        sdkName,
        definition.description ? `${definition.name}: ${definition.description}` : definition.name,
        schema.shape,
        async (args) => {
          if (controller.signal.aborted) throw abortError();
          const key = `${nativeName}:${canonical(args)}`;
          const pending = toolContexts.get(key)?.shift();
          if (!pending)
            throw new ClaudeSubscriptionError(
              `Claude tool ${definition.name} was invoked without a matching tool-use context.`,
            );
          const { context } = pending;
          if (terminal)
            return {
              content: [{ type: "text", text: "The tool loop has already completed." }],
              isError: true,
            };
          let execution = executions.get(context.callId);
          if (!execution) {
            execution = Promise.resolve().then(() => definition.execute(pending.input, context));
            executions.set(context.callId, execution);
          }
          let result: ClaudeToolResult;
          try {
            result = await execution;
          } catch (error) {
            fatalToolError = error;
            controller.abort();
            throw error;
          }
          if (result.terminal) {
            terminal = true;
            terminalCallIds.add(context.callId);
          }
          try {
            return {
              content: mcpContent(result.content),
              ...(result.isError ? { isError: true } : {}),
            };
          } catch (error) {
            fatalToolError = error;
            controller.abort();
            throw error;
          }
        },
      ),
    );
    const options: Options = {
      model: request.model,
      systemPrompt: request.system ?? "You are a helpful assistant.",
      pathToClaudeCodeExecutable: process.env.LLM_CLAUDE_EXECUTABLE?.trim() || "claude",
      env: subscriptionEnvironment(request.maxOutputTokens),
      abortController: controller,
      tools: [],
      allowedTools: definitions.map((entry) => entry.nativeName),
      mcpServers: sdkTools.length
        ? { llm: createSdkMcpServer({ name: "llm", tools: sdkTools }) }
        : {},
      strictMcpConfig: true,
      settingSources: [],
      ...(request.speed !== undefined ? { settings: { fastMode: request.speed === "fast" } } : {}),
      extraArgs: { "safe-mode": null },
      plugins: [],
      skills: [],
      agents: {},
      persistSession: false,
      enableFileCheckpointing: false,
      includePartialMessages: true,
      verbatimPrompts: true,
      permissionMode: "dontAsk",
      promptSuggestions: false,
      ...(request.maxSteps !== undefined ? { maxTurns: request.maxSteps } : {}),
      ...(request.effort ? { effort: request.effort === "ultra" ? "max" : request.effort } : {}),
      ...(request.jsonSchema
        ? { outputFormat: { type: "json_schema", schema: request.jsonSchema } }
        : {}),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                flushAssistant();
                const entry = byNativeName.get(input.tool_name);
                if (!entry) return {};
                if (terminal)
                  return { continue: false, stopReason: "A terminal tool completed the loop." };
                const args = entry.schema.parse(input.tool_input);
                const key = `${input.tool_name}:${canonical(args)}`;
                const queue = toolContexts.get(key) ?? [];
                if (
                  !queue.some((pending) => pending.context.callId === input.tool_use_id) &&
                  !executions.has(input.tool_use_id)
                ) {
                  queue.push({
                    context: {
                      callId: input.tool_use_id,
                      turn: currentTurn || 1,
                      toolIndex: ++toolIndex,
                    },
                    input: input.tool_input,
                  });
                  toolContexts.set(key, queue);
                }
                return {
                  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
                };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (input) =>
                input.hook_event_name === "PostToolUse" && terminalCallIds.has(input.tool_use_id)
                  ? { continue: false, stopReason: "A terminal tool completed the loop." }
                  : {},
            ],
          },
        ],
        PostToolBatch: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PostToolBatch" || terminal) return {};
                const steering = request.drainSteering?.();
                return steering
                  ? {
                      hookSpecificOutput: {
                        hookEventName: "PostToolBatch",
                        additionalContext: `New user follow-up instructions:\n${steering}`,
                      },
                    }
                  : {};
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "Stop" || terminal) return {};
                const steering = request.drainSteering?.();
                return steering
                  ? {
                      hookSpecificOutput: {
                        hookEventName: "Stop",
                        additionalContext: `New user follow-up instructions:\n${steering}`,
                      },
                    }
                  : {};
              },
            ],
          },
        ],
      },
    };
    const oauthTokenForwarded = Boolean(options.env?.CLAUDE_CODE_OAUTH_TOKEN?.trim());
    activeQuery = query({ prompt, options });
    assertSubscription(await activeQuery.accountInfo(), oauthTokenForwarded);
    if (controller.signal.aborted) throw abortError();
    releaseInput(true);
    for await (const message of activeQuery) {
      if (request.signal?.aborted) throw abortError();
      if (message.type === "system" && message.subtype === "init") {
        if (!["none", "oauth"].includes(message.apiKeySource))
          throw new ClaudeSubscriptionError(
            "Claude Code selected API-key authentication; subscription queries refuse this fallback.",
          );
        model = message.model;
      } else if (message.type === "stream_event" && !message.parent_tool_use_id) {
        const event = message.event;
        if (event.type === "message_start") {
          flushAssistant();
          currentTurn += 1;
          toolIndex = 0;
          text = "";
          thoughts = "";
          current = structuredClone(event.message) as unknown as AnthropicMessage;
          current.content = [];
          partialMessageIds.add(current.id);
          model = current.model;
        } else if (event.type === "content_block_start" && current) {
          current.content[event.index] = structuredClone(
            event.content_block,
          ) as AnthropicContentBlock;
          const block = current.content[event.index];
          if (block?.type === "text") append("response", block.text);
          else if (block?.type === "thinking") append("thought", block.thinking);
        } else if (event.type === "content_block_delta" && current) {
          const block = current.content[event.index];
          if (event.delta.type === "text_delta" && block?.type === "text") {
            block.text += event.delta.text;
            append("response", event.delta.text);
          } else if (event.delta.type === "thinking_delta" && block?.type === "thinking") {
            block.thinking += event.delta.thinking;
            append("thought", event.delta.thinking);
          } else if (event.delta.type === "signature_delta" && block?.type === "thinking")
            block.signature += event.delta.signature;
          else if (event.delta.type === "input_json_delta")
            inputJson.set(
              event.index,
              (inputJson.get(event.index) ?? "") + event.delta.partial_json,
            );
        } else if (event.type === "message_delta" && current) {
          current.stop_reason = event.delta.stop_reason;
          current.stop_sequence = event.delta.stop_sequence;
          for (const key of [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
          ] as const) {
            const value = event.usage[key];
            if (typeof value === "number") current.usage[key] = value;
          }
          const servingUsage = event.usage as Partial<AnthropicUsage>;
          if (servingUsage.speed !== undefined) current.usage.speed = servingUsage.speed;
          if (servingUsage.service_tier !== undefined)
            current.usage.service_tier = servingUsage.service_tier;
          finishReason = current.stop_reason ?? undefined;
        } else if (event.type === "message_stop") flushAssistant();
      } else if (message.type === "assistant" && !message.parent_tool_use_id) {
        if (message.error)
          throw new ClaudeSubscriptionError(
            `Claude subscription request failed: ${message.error}.`,
          );
        if (!partialMessageIds.has(message.message.id)) {
          if (current?.id !== message.message.id) {
            flushAssistant();
            currentTurn += 1;
            toolIndex = 0;
            text = "";
            thoughts = "";
            current = structuredClone(message.message) as unknown as AnthropicMessage;
          } else
            current.content.push(
              ...(structuredClone(message.message.content) as AnthropicContentBlock[]),
            );
          model = message.message.model;
          for (const block of message.message.content) {
            if (block.type === "text") append("response", block.text);
            else if (block.type === "thinking") append("thought", block.thinking);
          }
        }
      } else if (message.type === "result") {
        flushAssistant();
        finalResult = message;
        finishReason = terminal
          ? "terminal_tool"
          : message.subtype === "error_max_turns"
            ? "max_steps"
            : (message.stop_reason ?? finishReason);
        break;
      }
    }
    if (fatalToolError) throw fatalToolError;
    if (request.signal?.aborted) throw abortError();
    if (terminal) finishReason = "terminal_tool";
    if (!finalResult && !terminal)
      throw new ClaudeSubscriptionError("Claude Code ended without a result.");
    if (finalResult?.is_error && !terminal && finalResult.subtype !== "error_max_turns") {
      const detail =
        finalResult.subtype === "success" ? finalResult.result : finalResult.errors.join("; ");
      throw new ClaudeSubscriptionError(`Claude subscription query failed: ${detail}`);
    }
    const structuredOutput =
      finalResult?.subtype === "success" ? finalResult.structured_output : undefined;
    if (request.jsonSchema && structuredOutput !== undefined) {
      text = JSON.stringify(structuredOutput);
      request.onDelta?.("response", text);
    } else if (!text && finalResult?.subtype === "success" && !request.jsonSchema) {
      text = finalResult.result;
      if (text) request.onDelta?.("response", text);
    }
    // SDK modelUsage uses a different accounting basis; the native usage counters
    // preserve the input/cache split expected by the public provider interface.
    const usage: AnthropicUsage = finalResult
      ? {
          ...(aggregateUsage.speed !== undefined ? { speed: aggregateUsage.speed } : {}),
          ...(aggregateUsage.service_tier !== undefined
            ? { service_tier: aggregateUsage.service_tier }
            : {}),
          ...finalResult.usage,
        }
      : aggregateUsage;
    return {
      text,
      thoughts,
      model,
      usage,
      ...servingMetadata(usage),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  } catch (error) {
    if (fatalToolError) throw fatalToolError;
    if (request.signal?.aborted) throw abortError();
    // Some CLI versions interrupt the iterator after a terminal PostToolUse hook.
    if (terminal)
      return {
        text,
        thoughts,
        model,
        usage: aggregateUsage,
        finishReason: "terminal_tool",
        ...servingMetadata(aggregateUsage),
      };
    throw error;
  } finally {
    releaseInput(false);
    request.signal?.removeEventListener("abort", abort);
    activeQuery?.close();
    controller.abort();
    await prompt.return(undefined);
  }
}
