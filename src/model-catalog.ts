import { ANTHROPIC_MODEL_IDS } from "./anthropic/models.js";
import { getAnthropicPricing } from "./anthropic/pricing.js";
import { FIREWORKS_MODEL_IDS } from "./fireworks/models.js";
import { getFireworksPricing } from "./fireworks/pricing.js";
import { GEMINI_IMAGE_MODEL_IDS, GEMINI_TEXT_MODEL_IDS } from "./google/client.js";
import { getGeminiProPricing } from "./google/pricing.js";
import type { LlmAccess, LlmProvider } from "./model-selection.js";
import {
  OPENAI_IMAGE_MODEL_IDS,
  OPENAI_MODEL_IDS,
  OPENAI_SUBSCRIPTION_IMAGE_MODEL_IDS,
  OPENAI_SUBSCRIPTION_MODEL_IDS,
} from "./openai/models.js";
import { getOpenAiPricing } from "./openai/pricing.js";
import { getVercelModelCatalog, type VercelTokenPricing } from "./vercel/catalog.js";
import { discoverXaiModels } from "./xai/discovery.js";

/** All rates are USD per token. Missing fields indicate unknown prices. */
export type ModelTokenPricing = VercelTokenPricing;

export type LlmModelInfo = {
  readonly provider: LlmProvider;
  readonly access: LlmAccess;
  readonly model: string;
  readonly name?: string;
  readonly description?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly type?: string;
  readonly capabilities?: readonly string[];
  /** For subscriptions, these are API-equivalent rates rather than billed charges. */
  readonly pricing?: ModelTokenPricing;
  readonly pricingSource?: "catalog" | "estimate";
};

export type ListModelsOptions = {
  readonly provider: LlmProvider;
  readonly access?: LlmAccess;
  /** Bypass the Vercel RAM cache; concurrent refreshes still share one request. */
  readonly refresh?: boolean;
};

/** Discover dynamic Vercel/xAI catalogues, or the supported local provider allowlist. */
export async function listModels(options: ListModelsOptions): Promise<readonly LlmModelInfo[]> {
  const { provider } = options;
  const access = options.access ?? "api";
  if (access !== "api" && access !== "subscription") {
    throw new Error(`Unsupported access: ${String(access)}.`);
  }
  if (access === "subscription" && !["openai", "anthropic", "xai"].includes(provider)) {
    throw new Error(`${provider} does not support subscription access.`);
  }
  if (provider === "vercel") {
    return (await getVercelModelCatalog({ refresh: options.refresh })).map(({ id, ...model }) => ({
      provider,
      access,
      model: id,
      ...model,
      pricingSource: model.pricing ? "catalog" : undefined,
    }));
  }
  if (provider === "xai") {
    return (await discoverXaiModels(access)).map(({ id, ...model }) => ({
      provider,
      access,
      model: id,
      ...model,
      pricingSource: model.pricing ? "estimate" : undefined,
    }));
  }
  if (provider === "openai") {
    const ids = access === "subscription" ? OPENAI_SUBSCRIPTION_MODEL_IDS : OPENAI_MODEL_IDS;
    const imageIds =
      access === "subscription" ? OPENAI_SUBSCRIPTION_IMAGE_MODEL_IDS : OPENAI_IMAGE_MODEL_IDS;
    return [
      ...ids.map((model) => ({
        provider,
        access,
        model,
        type: "language",
        pricing: getOpenAiPricing(model),
        pricingSource: "estimate" as const,
      })),
      ...imageIds.map((model) => ({ provider, access, model, type: "image" })),
    ];
  }
  if (provider === "anthropic") {
    return ANTHROPIC_MODEL_IDS.map((model) => {
      const pricing = getAnthropicPricing(model);
      return {
        provider,
        access,
        model,
        type: "language",
        pricing: pricing
          ? {
              inputRate: pricing.inputRate,
              outputRate: pricing.outputRate,
              cachedRate: pricing.cachedRate,
              cacheWriteRate: pricing.cacheWrite5mRate,
            }
          : undefined,
        pricingSource: "estimate",
      };
    });
  }
  if (provider === "fireworks") {
    return FIREWORKS_MODEL_IDS.map((model) => ({
      provider,
      access,
      model,
      type: "language",
      pricing: getFireworksPricing(model),
      pricingSource: "estimate",
    }));
  }
  if (provider === "google") {
    return [
      ...GEMINI_TEXT_MODEL_IDS.map((model) => {
        const pricing = getGeminiProPricing(model);
        return {
          provider,
          access,
          model,
          type: "language",
          pricing: pricing
            ? {
                inputRate: pricing.inputRateLow,
                outputRate: pricing.outputRateLow,
                cachedRate: pricing.cachedRateLow,
              }
            : undefined,
          pricingSource: "estimate" as const,
        };
      }),
      ...GEMINI_IMAGE_MODEL_IDS.map((model) => ({ provider, access, model, type: "image" })),
    ];
  }
  throw new Error(`Unsupported provider: ${String(provider)}.`);
}
