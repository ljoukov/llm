# Agent Telemetry Extension Points

This library now supports optional, pluggable telemetry in `runAgentLoop()` without changing default behavior.

## Goals

- Keep existing API ergonomics and behavior unchanged by default.
- Let library users integrate any backend (OpenTelemetry, Google Cloud telemetry, Datadog, custom pipelines).
- Keep implementation lightweight and efficient for a library context.
- Preserve subagent causality (`runId`/`parentRunId`) for hierarchical analysis.

## API Surface

`runAgentLoop()` accepts an optional `telemetry` field:

- `telemetry: AgentTelemetrySink`
- `telemetry: AgentTelemetryConfig`

Types:

- `AgentTelemetrySink`: `{ emit(event), flush?() }`
- `AgentTelemetryConfig`: `{ sink, includeLlmStreamEvents? }`
- `AgentTelemetryEvent` union:
  - `agent.run.started`
  - `agent.run.stream` (optional fan-out of `LlmStreamEvent`)
  - `agent.run.completed`

Each event includes:

- `timestamp`
- `runId`
- `parentRunId` (for subagents)
- `depth`
- `model`

## Architectural Approaches Evaluated

### 1) Direct OpenTelemetry Dependency in Core API

- Shape: expose OTEL spans/attributes directly in `runAgentLoop`.
- Pros:
  - Rich semantics for OTEL-native users.
  - Standardized exporters already available.
- Cons:
  - Forces dependency and concepts on all users.
  - Harder to keep API simple for non-OTEL users.
  - Coupling to one telemetry model in a general-purpose library.

### 2) Callback-Only Hook (`onTelemetryEvent(event)`)

- Shape: add one callback function, no sink object.
- Pros:
  - Very simple.
  - Minimal code overhead.
- Cons:
  - No standard place to flush buffered exporters.
  - Harder to encapsulate backend adapters cleanly.
  - Async callback completion semantics become unclear.

### 3) Sink-Based Adapter (`emit` + optional `flush`) with Typed Events (Chosen)

- Shape: optional `telemetry` object with `sink.emit(event)` and optional `sink.flush()`.
- Pros:
  - Backend-agnostic and easy to plug into any collection system.
  - Explicit flush extension point for buffered exporters.
  - Typed event model with stable core fields.
  - Keeps default behavior unchanged when telemetry is omitted.
- Cons:
  - Slightly more surface area than a single callback.
  - Users who want OTEL spans still need a thin adapter layer.

### Why #3 Was Chosen

It provides the best balance for a library:

- simple default usage,
- clear extension points,
- no backend lock-in,
- low runtime overhead,
- strong causal context for parent/subagent runs.

## Behavior and Performance Notes

- Telemetry is fully optional.
- If telemetry is omitted, there is no API/behavior change.
- `emit(event)` is called in a failure-safe wrapper (telemetry errors never fail agent runs).
- Async `emit()` promises are tracked and drained before `flush()`.
- `includeLlmStreamEvents` defaults to `false` to avoid high-volume event fan-out unless explicitly requested.

## Example: Google Cloud Telemetry Adapter

```ts
import { runAgentLoop, type AgentTelemetrySink } from "@ljoukov/llm";
import { Logging } from "@google-cloud/logging";

const logging = new Logging();
const log = logging.log("llm-agent");
const bufferedWrites: Promise<unknown>[] = [];

const sink: AgentTelemetrySink = {
  emit: (event) => {
    const entry = log.entry(
      { resource: { type: "global" } },
      {
        source: "@ljoukov/llm",
        event,
      },
    );
    bufferedWrites.push(log.write(entry));
  },
  flush: async () => {
    await Promise.allSettled(bufferedWrites);
    bufferedWrites.length = 0;
  },
};

await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Analyze report and update output files.",
  filesystemTool: true,
  telemetry: {
    sink,
    includeLlmStreamEvents: false,
  },
});
```

## Backward Compatibility

- Existing `runAgentLoop()` calls remain valid.
- Existing exports and behavior are unchanged unless `telemetry` is provided.
- Subagent delegation behavior is unchanged; telemetry adds observability context only.
