import { resolveModelRef, type ModelRefInput } from "./model-selection.js";
import { isOpenAiModelId, isOpenAiSubscriptionModelId } from "./openai/models.js";
import { isAnthropicModelId } from "./anthropic/models.js";
import { getCachedVercelModelCatalog } from "./vercel/catalog.js";
import { resolveVercelModelId } from "./vercel/models.js";
import { getCachedXaiReasoning } from "./xai/discovery.js";
import type { ModelReasoningOption } from "./model-reasoning.js";

/** Portable effort intent; known model/route limits are applied locally unless policy is strict. */
export type LlmThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type LlmThinkingLevelPolicy = "clamp" | "strict";
type NativeLevel = Exclude<LlmThinkingLevel, "ultra">;

export type LlmThinkingResolution = {
  readonly requestedLevel: LlmThinkingLevel;
  /** Level passed to the provider adapter, not proof the provider honored it. Absent for fixed reasoning. */
  readonly effectiveLevel?: NativeLevel;
  readonly source: "catalog" | "model" | "passthrough";
};

const LEVELS: readonly NativeLevel[] = ["low", "medium", "high", "xhigh", "max"];

function effortValues(
  options: readonly ModelReasoningOption[] | undefined,
): readonly string[] | undefined {
  const effort = options?.find((option) => option.type === "effort");
  return effort?.values ?? (options?.length === 0 ? [] : undefined);
}

function knownModelLevels(provider: string, model: string): readonly NativeLevel[] | undefined {
  // Verified 2026-11-03: docs.x.ai/developers/model-capabilities/text/reasoning.
  // Only known native IDs are inferred; future models remain passthrough until discovered.
  const grok =
    provider === "xai"
      ? model
      : provider === "vercel" && /^(?:xai|spacexai)\//.test(model)
        ? model.slice(model.indexOf("/") + 1)
        : undefined;
  if (grok === "grok-4.6" || grok === "grok-4.7") return ["low", "medium", "high", "xhigh"];
  if (grok === "grok-4.5") return ["low", "medium", "high"];
  if (provider === "openai" && (isOpenAiModelId(model) || isOpenAiSubscriptionModelId(model)))
    return LEVELS;
  if (provider === "anthropic" && isAnthropicModelId(model)) return LEVELS;
  if (provider === "google") {
    if (model === "gemini-flash-lite-latest" || model.includes("image")) return [];
    return ["low", "medium", "high"];
  }
  return undefined;
}

/**
 * Resolve portable effort locally. No credentials, network requests, or model discovery.
 * Cached route metadata wins over known model mappings. Unknown models retain passthrough behavior.
 * clamp chooses the greatest supported level <= the request, or the minimum when none is lower.
 * ultra chooses the highest known supported level; it is never sent as a native effort.
 */
export function resolveThinkingLevel(
  selection: ModelRefInput & {
    readonly thinkingLevel?: LlmThinkingLevel;
    readonly thinkingLevelPolicy?: LlmThinkingLevelPolicy;
  },
): LlmThinkingResolution | undefined {
  const requestedLevel = selection.thinkingLevel;
  if (requestedLevel === undefined) return undefined;
  if (![...LEVELS, "ultra"].includes(requestedLevel))
    throw new Error(`Unsupported thinkingLevel: ${String(requestedLevel)}.`);
  const policy = selection.thinkingLevelPolicy ?? "clamp";
  if (policy !== "clamp" && policy !== "strict")
    throw new Error(`Unsupported thinkingLevelPolicy: ${String(policy)}.`);
  const route = resolveModelRef(selection);
  const options =
    route.provider === "vercel"
      ? getCachedVercelModelCatalog()?.find(
          (model) => model.id === resolveVercelModelId(route.model),
        )?.reasoningOptions
      : route.provider === "xai"
        ? getCachedXaiReasoning(route.access, route.model)
        : undefined;
  const catalogLevels = effortValues(options);
  const values = catalogLevels ?? knownModelLevels(route.provider, route.model);
  const requestedNative = requestedLevel === "ultra" ? "max" : requestedLevel;
  if (values === undefined)
    return { requestedLevel, effectiveLevel: requestedNative, source: "passthrough" };
  const supported = LEVELS.filter((level) => values.includes(level));
  if (policy === "strict" && requestedLevel !== "ultra" && !values.includes(requestedNative)) {
    throw new Error(
      `thinkingLevel "${requestedLevel}" is not supported by ${route.provider}:${route.access}:${route.model}. Supported levels: ${values.join(", ") || "none (fixed reasoning)"}. Use thinkingLevelPolicy: "clamp" to adapt automatically.`,
    );
  }
  const source = catalogLevels !== undefined ? "catalog" : "model";
  // Do not invent an ordering for future native effort names, or turn thinking off implicitly.
  if (values.length > 0 && supported.length === 0)
    return { requestedLevel, effectiveLevel: requestedNative, source: "passthrough" };
  const effectiveLevel =
    supported.filter((level) => LEVELS.indexOf(level) <= LEVELS.indexOf(requestedNative)).at(-1) ??
    supported[0];
  return { requestedLevel, effectiveLevel, source };
}
