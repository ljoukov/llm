# TODO

This file tracks follow-up work for `@ljoukov/llm`.

## Debug / Tracing

- Add an opt-in filesystem trace writer for model calls and tool loops.
- Persist input messages, provider request config, streamed deltas, final text/thoughts, usage tokens + cost, tool calls + outputs, and errors.
- Store attachments (`inlineData`) as separate files and reference them from the trace.
- Provide a stable directory layout keyed by `rootDir` + `stage` + `subStage` + `attempt` + unique `runId`.

## Progress / Telemetry

- Add a small adapter (or helper) to convert `LlmStreamEvent` streams into consumer-defined progress reporting (status lines, metrics aggregation, etc.).
- Expose per-step usage/cost/modelVersion events for `runToolLoop()` / `runAgentLoop()`.

## Testing Ergonomics

- Document recommended mocking patterns for unit tests (for example mocking `@google/genai` / `openai`) and bundler configuration when deps are pre-bundled.
