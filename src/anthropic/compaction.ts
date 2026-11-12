import type { AnthropicUsage } from "./client.js";
import { isAnthropicModelId } from "./models.js";

/** Every direct Anthropic model exposed by this package supports the on-demand beta. */
export function isAnthropicCompactionSupported(model: string): boolean {
  return isAnthropicModelId(model);
}

/**
 * Compaction usage is charged per iteration, rather than by the top-level counters.
 * Preserve the provider payload while producing totals for the library's usage adapter.
 * https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand#count-compaction-usage
 */
export function sumAnthropicUsageIterations(usage: AnthropicUsage): AnthropicUsage {
  if (!usage.iterations?.length) return usage;
  const total = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  };
  for (const iteration of usage.iterations) {
    total.input_tokens += iteration.input_tokens ?? 0;
    total.output_tokens += iteration.output_tokens ?? 0;
    total.cache_read_input_tokens += iteration.cache_read_input_tokens ?? 0;
    total.cache_creation_input_tokens += iteration.cache_creation_input_tokens ?? 0;
    total.cache_creation.ephemeral_5m_input_tokens +=
      iteration.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    total.cache_creation.ephemeral_1h_input_tokens +=
      iteration.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  }
  return { ...usage, ...total };
}
