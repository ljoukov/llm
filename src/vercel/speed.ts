import type { LlmSpeed } from "../model-selection.js";
import { supportsOpenAiUltrafast } from "../openai/models.js";

type VercelSpeedOptions = {
  gateway: {
    sort: "cost";
    speed?: "fast";
    allowFallbackFromFast?: false;
    serviceTier?: "default" | "priority";
  };
  anthropic?: { speed: "standard" };
};

type VercelSpeedRequest = {
  providerOptions: VercelSpeedOptions;
  service_tier?: "fast" | "ultrafast";
};

/** Keep model identity unchanged while choosing the Gateway's serving controls. */
export function resolveVercelSpeedOptions(model: string, speed?: LlmSpeed): VercelSpeedRequest {
  if (
    (speed === "fast" || speed === "ultrafast") &&
    model.startsWith("openai/") &&
    supportsOpenAiUltrafast(model.slice("openai/".length))
  ) {
    return { providerOptions: { gateway: { sort: "cost" } }, service_tier: speed };
  }
  if (speed === "ultrafast") {
    throw new Error(`Ultrafast speed is not supported for ${model} on the Vercel route.`);
  }
  if (speed === "fast") {
    return {
      providerOptions: model.startsWith("openai/")
        ? { gateway: { sort: "cost", serviceTier: "priority" } }
        : { gateway: { sort: "cost", speed: "fast", allowFallbackFromFast: false } },
    };
  }
  if (speed === "standard") {
    return {
      providerOptions: {
        gateway: { sort: "cost", serviceTier: "default" },
        ...(model.startsWith("anthropic/") ? { anthropic: { speed: "standard" as const } } : {}),
      },
    };
  }
  return { providerOptions: { gateway: { sort: "cost" } } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Gateway metadata reports the tier actually served, including standard fallbacks. */
export function extractVercelServingMetadata(response: unknown): {
  effectiveSpeed?: LlmSpeed;
  serviceTier?: string;
} {
  const payload = record(response);
  const metadata = record(payload?.provider_metadata);
  const gateway = record(metadata?.gateway);
  const routing = record(gateway?.routing);
  const nativeTier = gateway?.serviceTier ?? payload?.service_tier;
  const serviceTier = typeof nativeTier === "string" ? nativeTier : undefined;
  const speed = routing?.speed;
  const effectiveSpeed =
    speed === "standard" || speed === "fast" || speed === "ultrafast"
      ? speed
      : serviceTier === "ultrafast"
        ? "ultrafast"
        : serviceTier === "priority" || serviceTier === "fast"
          ? "fast"
          : serviceTier === "default" || serviceTier === "standard"
            ? "standard"
            : undefined;
  return {
    ...(effectiveSpeed !== undefined ? { effectiveSpeed } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  };
}
