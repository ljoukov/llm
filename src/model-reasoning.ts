/** Provider-reported controls, not a guarantee that every control is exposed by this library. */
export type ModelReasoningOption =
  | {
      readonly type: "effort";
      /** Native values, including future levels and values outside LlmThinkingLevel. */
      readonly values: readonly string[];
    }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number }
  | { readonly type: "toggle" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenBound(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

/** Missing/malformed/unknown controls stay unknown; an explicit empty array stays empty. */
export function parseModelReasoningOptions(
  value: unknown,
): readonly ModelReasoningOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: ModelReasoningOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (raw.type === "effort") {
      if (
        !Array.isArray(raw.values) ||
        !raw.values.every((level) => typeof level === "string" && level.trim().length > 0)
      )
        continue;
      options.push(
        Object.freeze({ type: "effort", values: Object.freeze([...new Set<string>(raw.values)]) }),
      );
    } else if (raw.type === "budget_tokens") {
      if (
        !isTokenBound(raw.min) ||
        !isTokenBound(raw.max) ||
        (raw.min !== undefined && raw.max !== undefined && raw.min > raw.max)
      )
        continue;
      options.push(Object.freeze({ type: "budget_tokens", min: raw.min, max: raw.max }));
    } else if (raw.type === "toggle") {
      options.push(Object.freeze({ type: "toggle" }));
    }
  }
  return options.length || value.length === 0 ? Object.freeze(options) : undefined;
}
