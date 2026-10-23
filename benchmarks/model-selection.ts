import { isLlmTextModelId, parseModelRef, type LlmTextModelSelection } from "../src/index.js";

/** CLI labels preserve the route while reports remain readable strings. */
export function benchmarkModelSelection(label: string): LlmTextModelSelection {
  if (label.includes(":")) {
    const selection = parseModelRef(label);
    if (!isLlmTextModelId(selection.model)) {
      throw new Error(`Expected a text model: ${label}`);
    }
    return selection as LlmTextModelSelection;
  }
  if (!label.includes("/") && isLlmTextModelId(label)) {
    return { model: label } as LlmTextModelSelection;
  }
  throw new Error(
    `Unsupported model: ${label}. Use a known model ID or provider:access:model, for example vercel:api:reflection/beam-free.`,
  );
}

export function isBenchmarkModel(label: string): boolean {
  try {
    benchmarkModelSelection(label);
    return true;
  } catch {
    return false;
  }
}
