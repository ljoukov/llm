const MIN_MODEL_CONCURRENCY_CAP = 1;
export const MAX_MODEL_CONCURRENCY_CAP = 64;
export const DEFAULT_MODEL_CONCURRENCY_CAP = 3;

export type ModelConcurrencyProvider = "OPENAI" | "GOOGLE" | "FIREWORKS";

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/^-?\d+$/u.test(normalized)) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

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

export function normalizeModelIdForEnv(modelId: string): string {
  return modelId
    .trim()
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
}

type ResolveModelConcurrencyCapOptions = {
  readonly providerEnvPrefix: ModelConcurrencyProvider;
  readonly modelId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultCap?: number;
};

export function resolveModelConcurrencyCap(options: ResolveModelConcurrencyCapOptions): number {
  const env = options.env ?? process.env;
  const providerPrefix = options.providerEnvPrefix;
  const defaultCap = clampModelConcurrencyCap(options.defaultCap ?? DEFAULT_MODEL_CONCURRENCY_CAP);
  const normalizedModelId = options.modelId ? normalizeModelIdForEnv(options.modelId) : "";
  const candidateKeys = [
    ...(normalizedModelId
      ? [
          `${providerPrefix}_MAX_PARALLEL_REQUESTS_MODEL_${normalizedModelId}`,
          `LLM_MAX_PARALLEL_REQUESTS_MODEL_${normalizedModelId}`,
        ]
      : []),
    `${providerPrefix}_MAX_PARALLEL_REQUESTS_PER_MODEL`,
    "LLM_MAX_PARALLEL_REQUESTS_PER_MODEL",
  ];
  for (const key of candidateKeys) {
    const parsed = parsePositiveInteger(env[key]);
    if (parsed === undefined) {
      continue;
    }
    return clampModelConcurrencyCap(parsed);
  }
  return defaultCap;
}
