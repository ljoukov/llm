import {
  isOpenAiModelId,
  isOpenAiImageModelId,
  isOpenAiSubscriptionModelId,
  OPENAI_SUBSCRIPTION_MODEL_IDS,
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
export const LLM_SPEEDS = ["standard", "fast", "ultrafast"] as const;
export type LlmSpeed = (typeof LLM_SPEEDS)[number];
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
  readonly speed?: LlmSpeed;
};
type SubscriptionRef<P extends LlmProvider, M extends string> = {
  readonly provider: P;
  readonly model: M;
  readonly access: "subscription";
  readonly speed?: LlmSpeed;
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
export type LlmImageModelRef = (
  | ApiRef<"openai", OpenAiImageModelId>
  | SubscriptionRef<"openai", OpenAiImageModelId>
  | ApiRef<"google", GeminiImageModelId>
) & { readonly speed?: never };
export type LlmModelRef = LlmTextModelRef | LlmImageModelRef;
export type ModelRef = LlmModelRef;

type QualifiedSelection<R extends LlmModelRef> = R extends LlmModelRef
  ? {
      readonly provider?: R["provider"];
      readonly access?: R extends { readonly access: "subscription" } ? "subscription" : "api";
      readonly model: `${R["provider"]}:${R extends { readonly access: "subscription" } ? "subscription" : "api"}:${R["model"]}`;
      readonly speed?: R["speed"];
    }
  : never;

export type QualifiedTextModelSelection = QualifiedSelection<LlmTextModelRef>;
export type QualifiedImageModelSelection = QualifiedSelection<LlmImageModelRef>;
export type QualifiedModelSelection = QualifiedTextModelSelection | QualifiedImageModelSelection;
export type QualifiedModelString = QualifiedModelSelection["model"];
type QualifiedTextModelShorthand = {
  readonly provider?: undefined;
  readonly access?: undefined;
  readonly model: QualifiedTextModelSelection["model"];
  readonly speed?: LlmSpeed;
};
type QualifiedImageModelShorthand = {
  readonly provider?: undefined;
  readonly access?: undefined;
  readonly model: QualifiedImageModelSelection["model"];
  readonly speed?: never;
};
/** Omitted providers retain automatic routing for the known local catalogue only. */
export type LlmTextModelSelection =
  | LlmTextModelRef
  | QualifiedTextModelSelection
  | QualifiedTextModelShorthand
  | {
      readonly provider?: undefined;
      readonly model: KnownTextModelId;
      readonly access?: "api";
      readonly speed?: LlmSpeed;
    };
export type LlmModelSelection =
  | LlmModelRef
  | QualifiedModelSelection
  | QualifiedTextModelShorthand
  | QualifiedImageModelShorthand
  | {
      readonly provider?: undefined;
      readonly model: KnownTextModelId | KnownImageModelId;
      readonly access?: "api";
      readonly speed?: LlmSpeed;
    };
export type ResolvedModelRef = {
  readonly provider: LlmProvider;
  readonly access: LlmAccess;
  readonly model: ModelSelectionId;
  readonly speed?: LlmSpeed;
};
export type ModelRefInput = {
  readonly model: string;
  readonly provider?: LlmProvider;
  readonly access?: LlmAccess;
  readonly speed?: LlmSpeed;
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

/** Removed serving aliases are rejected rather than rewritten, including their known Gateway forms. */
export function isRemovedServingAlias(modelId: string): boolean {
  if (modelId.startsWith("chatgpt-") || /^gpt-.+-fast$/u.test(modelId)) return true;
  if (modelId.startsWith("openai/")) {
    const nativeId = modelId.slice("openai/".length);
    if (nativeId.startsWith("chatgpt-")) return true;
    if (!nativeId.endsWith("-fast")) return false;
    const baseId = nativeId.slice(0, -"-fast".length);
    return (
      isOpenAiModelId(baseId) ||
      (OPENAI_SUBSCRIPTION_MODEL_IDS as readonly string[]).includes(baseId)
    );
  }
  if (modelId.startsWith("anthropic/") && modelId.endsWith("-fast")) {
    const baseId = modelId.slice("anthropic/".length, -"-fast".length);
    return isAnthropicModelId(baseId) || baseId === "claude-opus-5";
  }
  return false;
}

/** Supported serving speeds; pass a normalized native model and route. Images have no speed modifier. */
export function getSupportedModelSpeeds(
  selection: Pick<ModelRefInput, "model" | "access"> & { readonly provider: LlmProvider },
): readonly LlmSpeed[] {
  const { provider, model } = selection;
  if (isRemovedServingAlias(model)) return [];
  if (isOpenAiImageModelId(model) || isGeminiImageModelId(model)) return [];
  if (provider === "openai") {
    const listed =
      selection.access === "subscription"
        ? isOpenAiSubscriptionModelId(model)
        : isOpenAiModelId(model);
    if (!listed) return [];
    if (model === "gpt-6-astra" || model === "gpt-6.1-sol") return LLM_SPEEDS;
    return model.startsWith("experimental-chatgpt-") ? ["standard"] : ["standard", "fast"];
  }
  if (provider === "anthropic") {
    return model === "claude-opus-5-5" ? ["standard", "fast"] : ["standard"];
  }
  if (provider === "vercel") {
    if (
      (model.startsWith("openai/") && isOpenAiImageModelId(model.slice("openai/".length))) ||
      (model.startsWith("google/") && isGeminiImageModelId(model.slice("google/".length)))
    ) {
      return [];
    }
    const supportsFast =
      (model.startsWith("openai/") && isOpenAiModelId(model.slice("openai/".length))) ||
      model === "anthropic/claude-opus-5-5";
    return supportsFast ? ["standard", "fast"] : ["standard"];
  }
  return ["standard"];
}

function splitQualifiedModel(model: string):
  | {
      provider: LlmProvider;
      access: LlmAccess;
      model: string;
    }
  | undefined {
  const first = model.indexOf(":");
  if (first < 0 || !(LLM_PROVIDERS as readonly string[]).includes(model.slice(0, first))) {
    return undefined;
  }
  const second = model.indexOf(":", first + 1);
  if (second < 0) return undefined;
  const access = model.slice(first + 1, second);
  if (access !== "api" && access !== "subscription") {
    throw new Error(`Unsupported access in model reference: ${access}.`);
  }
  return {
    provider: model.slice(0, first) as LlmProvider,
    access,
    model: model.slice(second + 1),
  };
}

/** Validate once and preserve this route throughout an agent run and its children. */
export function resolveModelRef(selection: ModelRefInput): ResolvedModelRef {
  let { model } = selection;
  if (
    typeof model !== "string" ||
    !model ||
    model.trim() !== model ||
    /\s/.test(model) ||
    hasControlCharacter(model)
  ) {
    throw new Error("model must be a non-empty model ID without whitespace.");
  }
  const qualified = splitQualifiedModel(model);
  if (qualified) {
    if (selection.provider !== undefined && selection.provider !== qualified.provider) {
      throw new Error(`Conflicting provider: ${selection.provider} and ${qualified.provider}.`);
    }
    if (selection.access !== undefined && selection.access !== qualified.access) {
      throw new Error(`Conflicting access: ${selection.access} and ${qualified.access}.`);
    }
    model = qualified.model;
    if (!model) throw new Error("A model reference must include a native model ID.");
  }
  if (isRemovedServingAlias(model)) {
    throw new Error(`Removed model alias: ${model}. Use the native model ID and a speed modifier.`);
  }
  const access = qualified?.access ?? selection.access ?? "api";
  if (access !== "api" && access !== "subscription")
    throw new Error(`Unsupported access: ${String(access)}.`);
  let provider = qualified?.provider ?? selection.provider;
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
  const { speed } = selection;
  if (speed !== undefined) {
    if (!(LLM_SPEEDS as readonly string[]).includes(speed)) {
      throw new Error(`Unsupported speed: ${String(speed)}.`);
    }
    if (!getSupportedModelSpeeds({ provider, access, model }).includes(speed)) {
      throw new Error(
        `Unsupported speed for model route: ${provider}:${access}:${model} (${speed}).`,
      );
    }
  }
  return {
    provider,
    access,
    model: model as ModelSelectionId,
    ...(speed === undefined ? {} : { speed }),
  };
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
