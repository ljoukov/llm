import type OpenAI from "openai";

type FireworksToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ReasoningDetail = {
  type: string;
  id?: string;
  format?: string;
  index?: number;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string;
};

export type FireworksChatCompletion = {
  model: string;
  service_tier?: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: ReasoningDetail[];
      provider_metadata?: Record<string, unknown>;
      tool_calls?: FireworksToolCall[];
    };
  }>;
  usage?: unknown;
  provider_metadata?: Record<string, unknown>;
};

type StreamChunk = {
  model?: string;
  service_tier?: string;
  usage?: unknown;
  provider_metadata?: Record<string, unknown>;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: ReasoningDetail[];
      provider_metadata?: Record<string, unknown>;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

type CompletionStream = AsyncIterable<StreamChunk> & { controller?: AbortController };

function mergeMetadata(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...current };
  for (const [key, value] of Object.entries(update)) {
    const previous = result[key];
    result[key] =
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
        ? mergeMetadata(previous as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return result;
}

/** Consume OpenAI-compatible SSE without releasing the caller's scheduler slot early. */
export async function streamFireworksChatCompletion(
  client: OpenAI,
  request: Record<string, unknown>,
  options: {
    readonly signal?: AbortSignal;
    readonly onDelta?: (channel: "thought" | "response", text: string) => void;
    readonly provider?: "fireworks" | "vercel" | "xai";
  } = {},
): Promise<FireworksChatCompletion> {
  const { signal, onDelta } = options;
  const providerName =
    options.provider === "vercel"
      ? "Vercel AI Gateway"
      : options.provider === "xai"
        ? "xAI"
        : "Fireworks";
  signal?.throwIfAborted();

  let stream: CompletionStream | undefined;
  let iterator: AsyncIterator<StreamChunk> | undefined;
  let completed = false;
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  // The signal can fire between reads, when no Promise.race is listening yet.
  void aborted.catch(() => undefined);
  const onAbort = (): void => {
    stream?.controller?.abort();
    rejectAborted?.(signal?.reason ?? new Error(`${providerName} request aborted.`));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let model = typeof request.model === "string" ? request.model : "";
  let serviceTier: string | undefined;
  let finishReason: string | null = null;
  let content = "";
  let reasoning = "";
  let sawReasoning = false;
  let gatewayReasoning = "";
  let sawGatewayReasoning = false;
  const reasoningDetails = new Map<string, ReasoningDetail>();
  let providerMetadata: Record<string, unknown> | undefined;
  let usage: unknown;
  const tools = new Map<number, FireworksToolCall>();

  try {
    stream = (await Promise.race([
      client.chat.completions.create(
        {
          ...request,
          stream: true,
          stream_options: {
            ...(request.stream_options && typeof request.stream_options === "object"
              ? request.stream_options
              : {}),
            include_usage: true,
          },
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal },
      ),
      aborted,
    ])) as CompletionStream;
    signal?.throwIfAborted();
    iterator = stream[Symbol.asyncIterator]();

    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      signal?.throwIfAborted();
      stream.controller?.signal.throwIfAborted();
      if (next.done) {
        if (!finishReason) {
          throw new Error(
            `${providerName} stream ended before the first choice supplied a finish reason.`,
          );
        }
        completed = true;
        break;
      }
      const chunk = next.value;
      if (typeof chunk.model === "string") model = chunk.model;
      if (typeof chunk.service_tier === "string") serviceTier = chunk.service_tier;
      if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage;
      if (chunk.provider_metadata) {
        providerMetadata = mergeMetadata(providerMetadata ?? {}, chunk.provider_metadata);
      }
      const choice = chunk.choices?.find((entry) => entry.index === 0) ?? chunk.choices?.[0];
      if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.provider_metadata) {
        providerMetadata = mergeMetadata(providerMetadata ?? {}, delta.provider_metadata);
      }
      if (typeof delta?.reasoning_content === "string") {
        sawReasoning = true;
        reasoning += delta.reasoning_content;
        if (typeof delta.reasoning !== "string" && delta.reasoning_content.length > 0) {
          onDelta?.("thought", delta.reasoning_content);
        }
      }
      if (typeof delta?.reasoning === "string") {
        sawGatewayReasoning = true;
        gatewayReasoning += delta.reasoning;
        if (delta.reasoning.length > 0) onDelta?.("thought", delta.reasoning);
      }
      for (const [position, fragment] of (delta?.reasoning_details ?? []).entries()) {
        const key = `${fragment.index ?? fragment.id ?? position}:${fragment.type}`;
        const existing = reasoningDetails.get(key);
        if (!existing) {
          reasoningDetails.set(key, { ...fragment });
          continue;
        }
        for (const field of ["text", "summary", "data", "signature"] as const) {
          if (typeof fragment[field] === "string") {
            existing[field] = (existing[field] ?? "") + fragment[field];
          }
        }
        if (fragment.id !== undefined) existing.id = fragment.id;
        if (fragment.format !== undefined) existing.format = fragment.format;
      }
      if (typeof delta?.content === "string") {
        content += delta.content;
        if (delta.content.length > 0) onDelta?.("response", delta.content);
      }
      for (const fragment of delta?.tool_calls ?? []) {
        let call = tools.get(fragment.index);
        if (!call) {
          call = { id: "", type: "function", function: { name: "", arguments: "" } };
          tools.set(fragment.index, call);
        }
        if (typeof fragment.id === "string") call.id += fragment.id;
        if (typeof fragment.function?.name === "string")
          call.function.name += fragment.function.name;
        if (typeof fragment.function?.arguments === "string") {
          call.function.arguments += fragment.function.arguments;
        }
      }
    }
    return {
      model,
      ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: content || null,
            ...(sawReasoning ? { reasoning_content: reasoning } : {}),
            ...(sawGatewayReasoning ? { reasoning: gatewayReasoning } : {}),
            ...(reasoningDetails.size > 0
              ? { reasoning_details: [...reasoningDetails.values()] }
              : {}),
            ...(providerMetadata ? { provider_metadata: providerMetadata } : {}),
            ...(tools.size > 0
              ? {
                  tool_calls: [...tools]
                    .sort(([left], [right]) => left - right)
                    .map(([, call]) => call),
                }
              : {}),
          },
        },
      ],
      ...(usage !== undefined ? { usage } : {}),
      ...(providerMetadata ? { provider_metadata: providerMetadata } : {}),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      stream?.controller?.abort();
      // Do not wait for a stalled next() after an abort. Aborting the transport
      // releases the reader, and return() closes cooperative iterators as well.
      try {
        void iterator?.return?.().catch(() => undefined);
      } catch {
        // Cleanup must preserve the original stream or callback failure.
      }
    }
  }
}
