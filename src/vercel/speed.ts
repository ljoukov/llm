import type { LlmSpeed } from "../model-selection.js";

type VercelSpeedOptions = {
  gateway: {
    sort: "cost";
    speed?: "fast";
    allowFallbackFromFast?: false;
    serviceTier?: "default" | "priority";
  };
  anthropic?: { speed: "standard" };
};

/** Keep model identity unchanged while choosing the Gateway's serving controls. */
export function resolveVercelSpeedOptions(model: string, speed?: LlmSpeed): VercelSpeedOptions {
  if (speed === "ultrafast") {
    throw new Error("Ultrafast speed is not supported by the Vercel route.");
  }
  if (speed === "fast") {
    return model.startsWith("openai/")
      ? { gateway: { sort: "cost", serviceTier: "priority" } }
      : { gateway: { sort: "cost", speed: "fast", allowFallbackFromFast: false } };
  }
  if (speed === "standard") {
    return {
      gateway: { sort: "cost", serviceTier: "default" },
      ...(model.startsWith("anthropic/") ? { anthropic: { speed: "standard" as const } } : {}),
    };
  }
  return { gateway: { sort: "cost" } };
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
