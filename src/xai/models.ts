/** Curated suggestions. Additional native Grok IDs are accepted without a package update. */
export const XAI_MODEL_IDS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-build-0.1",
  "grok-build",
] as const;

export type XaiModelId = (typeof XAI_MODEL_IDS)[number] | `grok-${string}`;
export type XaiAccess = "api" | "subscription";

/** Model IDs cannot contain route delimiters, whitespace, or URL path components. */
export function isXaiModelId(value: string): value is XaiModelId {
  return /^grok-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

export function resolveXaiModelId(value: string): XaiModelId | undefined {
  const id = value.trim();
  return isXaiModelId(id) ? id : undefined;
}
