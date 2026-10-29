import {
  isLlmTextModelId,
  resolveModelRef,
  type LlmSpeed,
  type LlmTextModelSelection,
} from "../src/index.js";

/** CLI labels preserve the route while reports remain readable strings. */
export function benchmarkModelSelection(label: string, speed?: LlmSpeed): LlmTextModelSelection {
  const selection = resolveModelRef({ model: label, speed });
  if (isLlmTextModelId(selection.model)) {
    return selection as LlmTextModelSelection;
  }
  throw new Error(
    `Expected a text model: ${label}. Use a known model ID or provider:access:model, for example vercel:api:reflection/beam-free.`,
  );
}

export function isBenchmarkModel(label: string, speed?: LlmSpeed): boolean {
  try {
    benchmarkModelSelection(label, speed);
    return true;
  } catch {
    return false;
  }
}
