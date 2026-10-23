import {
  isOpenAiModelId,
  isOpenAiImageModelId,
  isOpenAiSubscriptionModelId,
  type OpenAiModelId,
  type OpenAiImageModelId,
  type OpenAiSubscriptionModelId,
} from "./openai/models.js";
import { isAnthropicModelId, type AnthropicModelId } from "./anthropic/models.js";
import { isFireworksModelId, type FireworksModelId } from "./fireworks/models.js";
import {
  isGeminiTextModelId,
  isGeminiImageModelId,
  type GeminiTextModelId,
  type GeminiImageModelId,
} from "./google/client.js";
import { resolveOpenModelProvider, type KnownVercelModelId } from "./vercel/models.js";

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "fireworks",
  "vercel",
  "xai",
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type LlmAccess = "api" | "subscription";
export type QualifiedVercelModelId = `${string}/${string}`;
export type XaiModelSelectionId = `grok-${string}`;
export type KnownTextModelId =
  | OpenAiModelId
  | AnthropicModelId
  | FireworksModelId
  | GeminiTextModelId
  | XaiModelSelectionId;
export type KnownImageModelId = OpenAiImageModelId | GeminiImageModelId;
export type ModelSelectionId =
  | KnownTextModelId
  | OpenAiSubscriptionModelId
  | KnownImageModelId
  | QualifiedVercelModelId;
type ApiRef<P extends LlmProvider, M extends string> = {
  readonly provider: P;
  readonly model: M;
  readonly access?: "api";
};
type SubscriptionRef<P extends LlmProvider, M extends string> = {
  readonly provider: P;
  readonly model: M;
  readonly access: "subscription";
};

/** Explicit, reusable selection. Provider and access determine the accepted model IDs. */
export type LlmTextModelRef =
  | ApiRef<"openai", OpenAiModelId>
  | SubscriptionRef<"openai", OpenAiSubscriptionModelId>
  | ApiRef<"anthropic", AnthropicModelId>
  | SubscriptionRef<"anthropic", AnthropicModelId>
  | ApiRef<"google", GeminiTextModelId>
  | ApiRef<"fireworks", FireworksModelId>
  | ApiRef<"vercel", KnownVercelModelId | QualifiedVercelModelId>
  | ApiRef<"xai", XaiModelSelectionId>
  | SubscriptionRef<"xai", XaiModelSelectionId>;
export type LlmImageModelRef =
  | ApiRef<"openai", OpenAiImageModelId>
  | SubscriptionRef<"openai", OpenAiImageModelId>
  | ApiRef<"google", GeminiImageModelId>;
export type LlmModelRef = LlmTextModelRef | LlmImageModelRef;
export type ModelRef = LlmModelRef;
/** Omitted providers retain automatic routing for the known local catalogue only. */
export type LlmTextModelSelection =
  | LlmTextModelRef
  | { readonly provider?: undefined; readonly model: KnownTextModelId; readonly access?: "api" };
export type LlmModelSelection =
  | LlmModelRef
  | {
      readonly provider?: undefined;
      readonly model: KnownTextModelId | KnownImageModelId;
      readonly access?: "api";
    };
export type ResolvedModelRef = {
  readonly provider: LlmProvider;
  readonly access: LlmAccess;
  readonly model: ModelSelectionId;
};
export type ModelRefInput = {
  readonly model: string;
  readonly provider?: LlmProvider;
  readonly access?: LlmAccess;
};

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isQualifiedVercelModelId(model: string): model is QualifiedVercelModelId {
  return !hasControlCharacter(model) && /^[^\s/:]+\/[^\s/]+$/.test(model);
}

function isXaiModel(model: string): model is XaiModelSelectionId {
  return /^grok-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model);
}

/** Validate once and preserve this route throughout an agent run and its children. */
export function resolveModelRef(selection: ModelRefInput): ResolvedModelRef {
  const { model } = selection;
  if (
    typeof model !== "string" ||
    !model ||
    model.trim() !== model ||
    /\s/.test(model) ||
    hasControlCharacter(model)
  ) {
    throw new Error("model must be a non-empty model ID without whitespace.");
  }
  const access = selection.access ?? "api";
  if (access !== "api" && access !== "subscription")
    throw new Error(`Unsupported access: ${String(access)}.`);
  let provider = selection.provider;
  if (provider === undefined) {
    if (access !== "api") throw new Error("Subscription access requires an explicit provider.");
    if (isOpenAiModelId(model) || isOpenAiImageModelId(model)) provider = "openai";
    else if (isGeminiTextModelId(model) || isGeminiImageModelId(model)) provider = "google";
    else if (isAnthropicModelId(model)) provider = "anthropic";
    else if (isFireworksModelId(model)) provider = resolveOpenModelProvider();
    else if (isXaiModel(model)) provider = "xai";
    else
      throw new Error(`Unsupported model: ${model}. Namespaced models require provider: "vercel".`);
  }
  let valid = false;
  switch (provider) {
    case "openai":
      valid =
        access === "subscription"
          ? isOpenAiSubscriptionModelId(model) || isOpenAiImageModelId(model)
          : isOpenAiModelId(model) || isOpenAiImageModelId(model);
      break;
    case "anthropic":
      valid = isAnthropicModelId(model);
      break;
    case "google":
      valid = access === "api" && (isGeminiTextModelId(model) || isGeminiImageModelId(model));
      break;
    case "fireworks":
      valid = access === "api" && isFireworksModelId(model);
      break;
    case "vercel":
      valid = access === "api" && (isFireworksModelId(model) || isQualifiedVercelModelId(model));
      break;
    case "xai":
      valid = isXaiModel(model);
      break;
    default:
      throw new Error(`Unsupported provider: ${String(provider)}.`);
  }
  if (!valid)
    throw new Error(`Unsupported model/access combination: ${provider}:${access}:${model}.`);
  return { provider, access, model: model as ModelSelectionId };
}

/** Parse provider:access:model; only the first two colons delimit routing fields. */
export type ParsedModelRef<S extends string> = string extends S
  ? LlmModelRef
  : S extends `${infer P}:${infer A}:${infer M}`
    ? LlmModelRef & { readonly provider: P; readonly access: A; readonly model: M }
    : LlmModelRef;
export function parseModelRef<const S extends string>(slug: S): ParsedModelRef<S>;
export function parseModelRef(slug: string): LlmModelRef {
  const first = slug.indexOf(":");
  const second = slug.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1 || second === slug.length - 1) {
    throw new Error('Expected a model reference in "provider:access:model" format.');
  }
  const provider = slug.slice(0, first) as LlmProvider;
  const access = slug.slice(first + 1, second) as LlmAccess;
  return resolveModelRef({ provider, access, model: slug.slice(second + 1) }) as LlmModelRef;
}
