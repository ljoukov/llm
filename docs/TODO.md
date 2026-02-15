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

- Document recommended mocking patterns for unit tests:
- Consumer/app tests: mock `@ljoukov/llm` exports (`streamText`, `generateText`, `generateJson`, `runToolLoop`, `runAgentLoop`).
- Library/internal tests that must validate provider request shaping: mock provider SDK modules (`@google/genai`, `openai`) to capture/inspect outbound calls. Mocking `streamText()` would bypass the logic under test.
- Add Vitest/Vite notes: when deps are pre-bundled, `vi.mock()` may not intercept unless the deps are inlined (for example `test.server.deps.inline`).
