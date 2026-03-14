# Telemetry

This library exposes one telemetry API for both standalone direct calls and agent loops.

Covered operations:

- `llm.call.*` for `generateText()`, `streamText()`, `generateJson()`, `streamJson()`, `generateImages()`
- `agent.run.*` for `runAgentLoop()` and `streamAgentLoop()`

## API

Global configuration:

- `configureTelemetry(telemetry)`
- `resetTelemetry()`

Per-call override:

- `telemetry?: false | TelemetryConfig`

Use `telemetry: false` to disable even a globally configured sink for one call.

Types:

- `TelemetrySink`: `{ emit(event), flush?() }`
- `TelemetryConfig`: `{ sink, includeStreamEvents? }`
- `TelemetrySelection`: `false | TelemetryConfig`

`includeStreamEvents` defaults to `false`.

## Events

`TelemetryEvent` is a union of:

- `llm.call.started`
- `llm.call.stream`
- `llm.call.completed`
- `agent.run.started`
- `agent.run.stream`
- `agent.run.completed`

### LLM call fields

All `llm.call.*` events include:

- `timestamp`
- `callId`
- `operation`
- `provider`
- `model`

`operation` is one of:

- `generateText`
- `streamText`
- `generateJson`
- `streamJson`
- `generateImages`

`llm.call.completed` may also include:

- `modelVersion`
- `blocked`
- `usage`
- `costUsd`
- `outputTextChars`
- `thoughtChars`
- `responseImages`
- `rawTextChars`
- `imageCount`
- `attempts`
- `uploadCount`
- `uploadBytes`
- `uploadLatencyMs`
- `error`

### Agent run fields

All `agent.run.*` events include:

- `timestamp`
- `runId`
- `parentRunId`
- `depth`
- `model`

`agent.run.completed` may also include:

- `stepCount`
- `toolCallCount`
- `totalCostUsd`
- `usage`
- `uploadCount`
- `uploadBytes`
- `uploadLatencyMs`
- `error`

## Behavior

- Telemetry is optional.
- Telemetry failures never fail library execution.
- Async `emit()` work is drained before `flush()`.
- Wrapper APIs emit wrapper-level telemetry only.
  - `generateJson()` / `streamJson()` emit JSON wrapper events, not nested `streamText()` events.
  - `generateImages()` emits one aggregate image-generation event and rolls up grading usage/cost.
- Global configuration uses runtime singletons, so one configured sink applies across direct calls and agent loops in the same process.

## Example

```ts
import {
  configureTelemetry,
  generateImages,
  runAgentLoop,
  type TelemetrySink,
} from "@ljoukov/llm";

const sink: TelemetrySink = {
  emit: (event) => {
    console.log(event.type);
  },
  flush: async () => {},
};

configureTelemetry({
  sink,
  includeStreamEvents: false,
});

await generateImages({
  model: "gemini-3-pro-image-preview",
  stylePrompt: "Painterly storyboard frames.",
  imagePrompts: ["A lighthouse in a storm at dusk."],
  imageGradingPrompt: "Check whether the image matches the prompt.",
});

await runAgentLoop({
  model: "gpt-5.2",
  input: "Inspect the repo and update files.",
  filesystemTool: true,
});
```
