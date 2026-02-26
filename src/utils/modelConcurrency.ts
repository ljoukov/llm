const MIN_MODEL_CONCURRENCY_CAP = 1;
export const MAX_MODEL_CONCURRENCY_CAP = 64;
export const DEFAULT_MODEL_CONCURRENCY_CAP = 3;
export const DEFAULT_OPENAI_MODEL_CONCURRENCY_CAP = 12;
export const DEFAULT_GOOGLE_MODEL_CONCURRENCY_CAP = 4;
export const DEFAULT_GOOGLE_PREVIEW_MODEL_CONCURRENCY_CAP = 2;
export const DEFAULT_FIREWORKS_MODEL_CONCURRENCY_CAP = 6;

export type ModelConcurrencyProvider = "openai" | "google" | "fireworks";

export type ModelConcurrencyConfig = {
  readonly globalCap?: number;
  readonly providerCaps?: Partial<Record<ModelConcurrencyProvider, number>>;
  readonly modelCaps?: Record<string, number>;
  readonly providerModelCaps?: Partial<Record<ModelConcurrencyProvider, Record<string, number>>>;
};

type NormalizedModelConcurrencyConfig = {
  readonly globalCap?: number;
  readonly providerCaps: Partial<Record<ModelConcurrencyProvider, number>>;
  readonly modelCaps: ReadonlyMap<string, number>;
  readonly providerModelCaps: Readonly<Record<ModelConcurrencyProvider, ReadonlyMap<string, number>>>;
};

const MODEL_CONCURRENCY_PROVIDERS: readonly ModelConcurrencyProvider[] = [
  "openai",
  "google",
  "fireworks",
];

let configuredModelConcurrency = normalizeModelConcurrencyConfig({});

export function clampModelConcurrencyCap(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MODEL_CONCURRENCY_CAP;
  }
  const rounded = Math.floor(value);
  if (rounded < MIN_MODEL_CONCURRENCY_CAP) {
    return MIN_MODEL_CONCURRENCY_CAP;
  }
  if (rounded > MAX_MODEL_CONCURRENCY_CAP) {
    return MAX_MODEL_CONCURRENCY_CAP;
  }
  return rounded;
}

export function normalizeModelIdForConfig(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function normalizeCap(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return clampModelConcurrencyCap(value);
}

function normalizeModelCapMap(
  caps: Record<string, number> | undefined,
): ReadonlyMap<string, number> {
  const normalized = new Map<string, number>();
  if (!caps) {
    return normalized;
  }
  for (const [modelId, cap] of Object.entries(caps)) {
    const modelKey = normalizeModelIdForConfig(modelId);
    if (!modelKey) {
      continue;
    }
    const normalizedCap = normalizeCap(cap);
    if (normalizedCap === undefined) {
      continue;
    }
    normalized.set(modelKey, normalizedCap);
  }
  return normalized;
}

function normalizeModelConcurrencyConfig(
  config: ModelConcurrencyConfig,
): NormalizedModelConcurrencyConfig {
  const providerCaps: Partial<Record<ModelConcurrencyProvider, number>> = {};
  const providerModelCaps = {
    openai: new Map<string, number>(),
    google: new Map<string, number>(),
    fireworks: new Map<string, number>(),
  };
  for (const provider of MODEL_CONCURRENCY_PROVIDERS) {
    const providerCap = normalizeCap(config.providerCaps?.[provider]);
    if (providerCap !== undefined) {
      providerCaps[provider] = providerCap;
    }
    providerModelCaps[provider] = new Map(
      normalizeModelCapMap(config.providerModelCaps?.[provider]),
    );
  }
  return {
    globalCap: normalizeCap(config.globalCap),
    providerCaps,
    modelCaps: normalizeModelCapMap(config.modelCaps),
    providerModelCaps,
  };
}

function resolveDefaultProviderCap(
  provider: ModelConcurrencyProvider,
  modelId: string | undefined,
): number {
  if (provider === "openai") {
    return DEFAULT_OPENAI_MODEL_CONCURRENCY_CAP;
  }
  if (provider === "google") {
    return modelId?.includes("preview")
      ? DEFAULT_GOOGLE_PREVIEW_MODEL_CONCURRENCY_CAP
      : DEFAULT_GOOGLE_MODEL_CONCURRENCY_CAP;
  }
  return DEFAULT_FIREWORKS_MODEL_CONCURRENCY_CAP;
}

export function configureModelConcurrency(config: ModelConcurrencyConfig = {}): void {
  configuredModelConcurrency = normalizeModelConcurrencyConfig(config);
}

export function resetModelConcurrencyConfig(): void {
  configuredModelConcurrency = normalizeModelConcurrencyConfig({});
}

type ResolveModelConcurrencyCapOptions = {
  readonly provider: ModelConcurrencyProvider;
  readonly modelId?: string | null;
  readonly defaultCap?: number;
  readonly config?: ModelConcurrencyConfig;
};

export function resolveModelConcurrencyCap(options: ResolveModelConcurrencyCapOptions): number {
  const modelId = options.modelId ? normalizeModelIdForConfig(options.modelId) : undefined;
  const config = options.config
    ? normalizeModelConcurrencyConfig(options.config)
    : configuredModelConcurrency;
  const providerModelCap = modelId
    ? config.providerModelCaps[options.provider].get(modelId)
    : undefined;
  if (providerModelCap !== undefined) {
    return providerModelCap;
  }
  const modelCap = modelId ? config.modelCaps.get(modelId) : undefined;
  if (modelCap !== undefined) {
    return modelCap;
  }
  const providerCap = config.providerCaps[options.provider];
  if (providerCap !== undefined) {
    return providerCap;
  }
  if (config.globalCap !== undefined) {
    return config.globalCap;
  }
  const defaultCap = normalizeCap(options.defaultCap);
  if (defaultCap !== undefined) {
    return defaultCap;
  }
  return resolveDefaultProviderCap(options.provider, modelId);
}
