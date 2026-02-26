# @ljoukov/llm

[![npm version](https://img.shields.io/npm/v/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![npm downloads](https://img.shields.io/npm/dm/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![CI](https://github.com/ljoukov/llm/actions/workflows/ci.yml/badge.svg)](https://github.com/ljoukov/llm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ljoukov/llm.svg)](./LICENSE)

Unified TypeScript wrapper over:

- **OpenAI Responses API** (`openai`)
- **Google Gemini via Vertex AI** (`@google/genai`)
- **Fireworks chat-completions models** (`kimi-k2.5`, `glm-5`, `minimax-m2.1`, `gpt-oss-120b`)
- **ChatGPT subscription models** via `chatgpt-*` model ids (reuses Codex auth store, or a token provider)
- **Agentic orchestration with subagents** via `runAgentLoop()` + built-in delegation control tools

Designed around a single streaming API that yields:

- response text deltas
- thought (reasoning summary) deltas
- usage token counts + estimated USD cost

## Install

```bash
npm i @ljoukov/llm
```

## Environment variables

This package optionally loads a `.env.local` file from `process.cwd()` (Node.js) on first use (dotenv-style `KEY=value`
syntax) and does not override already-set `process.env` values. It always falls back to plain environment variables.

See Node.js docs on environment variables and dotenv files: https://nodejs.org/api/environment_variables.html#dotenv

### OpenAI

- `OPENAI_API_KEY`
- `OPENAI_RESPONSES_WEBSOCKET_MODE` (`auto` | `off` | `only`, default: `auto`)
- `OPENAI_BASE_URL` (optional; defaults to `https://api.openai.com/v1`)

### Gemini (Vertex AI)

- `GOOGLE_SERVICE_ACCOUNT_JSON` (the contents of a service account JSON key file, not a file path)

#### Get a service account key JSON

You need a **Google service account key JSON** for your Firebase / GCP project (this is what you put into
`GOOGLE_SERVICE_ACCOUNT_JSON`).

- **Firebase Console:** your project -> Project settings -> **Service accounts** -> **Generate new private key**
- **Google Cloud Console:** IAM & Admin -> **Service Accounts** -> select/create an account -> **Keys** -> **Add key** ->
  **Create new key** -> JSON

Either path is enough. Both produce the same kind of service account key `.json` file.

Official docs: https://docs.cloud.google.com/iam/docs/keys-create-delete

Store the JSON on one line (recommended):

```bash
jq -c . < path/to/service-account.json
```

Set it for local dev:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON="$(jq -c . < path/to/service-account.json)"
```

If deploying to Cloudflare Workers/Pages:

```bash
jq -c . < path/to/service-account.json | wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

### Fireworks

- `FIREWORKS_TOKEN` (or `FIREWORKS_API_KEY`)

### ChatGPT subscription models

By default, `chatgpt-*` models reuse the ChatGPT OAuth tokens stored by the Codex CLI:

- `${CODEX_HOME:-~/.codex}/auth.json`

If you deploy to multiple environments (Vercel, GCP, local dev, etc.), use a centralized HTTPS token provider that owns
refresh-token rotation and serves short-lived access tokens.

- `CHATGPT_AUTH_TOKEN_PROVIDER_URL` (example: `https://chatgpt-auth.<your-domain>`)
- `CHATGPT_AUTH_API_KEY` (shared secret; sent as `Authorization: Bearer ...` and `x-chatgpt-auth: ...`)
- `CHATGPT_AUTH_TOKEN_PROVIDER_STORE` (`kv` or `d1`, defaults to `kv`)
- `CHATGPT_RESPONSES_WEBSOCKET_MODE` (`auto` | `off` | `only`, default: `auto`)

This repo includes a Cloudflare Workers token provider implementation in `workers/chatgpt-auth/`.

If `CHATGPT_AUTH_TOKEN_PROVIDER_URL` + `CHATGPT_AUTH_API_KEY` are set, `chatgpt-*` models will fetch tokens from the
token provider and will not read the local Codex auth store.

### Responses transport

For OpenAI and `chatgpt-*` model paths, this library now tries **Responses WebSocket transport first** and falls back
to HTTP/SSE automatically when needed.

- `auto` (default): try WebSocket first, then fall back to SSE
- `off`: use SSE only
- `only`: require WebSocket (no fallback)

When fallback is triggered by an unsupported WebSocket upgrade response (for example `426`), the library keeps using
SSE for the rest of the process to avoid repeated failing upgrade attempts.

### Adaptive per-model concurrency

Provider calls use adaptive, overload-aware concurrency (with retry/backoff where supported). Configure hard caps in
code (clamped to `1..64`):

```ts
import { configureModelConcurrency } from "@ljoukov/llm";

configureModelConcurrency({
  globalCap: 8,
  providerCaps: {
    openai: 16,
    google: 3,
    fireworks: 8,
  },
  modelCaps: {
    "gpt-5.2": 24,
  },
  providerModelCaps: {
    google: {
      "gemini-3.1-pro-preview": 2,
    },
  },
});
```

Default caps (without configuration):

- OpenAI: `12`
- Google preview models (`*preview*`): `2`
- Other Google models: `4`
- Fireworks: `6`

## Usage

Use OpenAI-style request fields:

- `input`: string or message array
- `instructions`: optional top-level system instructions
- message roles: `developer`, `system`, `user`, `assistant`

### Basic (non-streaming)

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "gpt-5.2",
  input: "Write one sentence about TypeScript.",
});

console.log(result.text);
console.log(result.usage, result.costUsd);
```

### Streaming (response + thoughts + usage)

```ts
import { streamText } from "@ljoukov/llm";

const call = streamText({
  model: "gpt-5.2",
  input: "Explain what a hash function is in one paragraph.",
});

for await (const event of call.events) {
  if (event.type === "delta" && event.channel === "thought") {
    process.stderr.write(event.text);
  }
  if (event.type === "delta" && event.channel === "response") {
    process.stdout.write(event.text);
  }
  if (event.type === "usage") {
    console.log("\n\nusage:", event.usage, "costUsd:", event.costUsd);
  }
}

const result = await call.result;
console.log("\nmodelVersion:", result.modelVersion);
```

### Full conversation (multi-turn)

Pass a full message array via `input`.

```ts
import { generateText, type LlmInputMessage } from "@ljoukov/llm";

const input: LlmInputMessage[] = [
  {
    role: "system",
    content: "You are a concise assistant.",
  },
  {
    role: "user",
    content: "Summarize: Rust is a systems programming language.",
  },
  {
    role: "assistant",
    content: "Rust is a fast, memory-safe systems language.",
  },
  {
    role: "user",
    content: "Now rewrite it in 1 sentence.",
  },
];

const result = await generateText({ model: "gpt-5.2", input });
console.log(result.text);
```

### Attachments (files / images)

Use `inlineData` parts to attach base64-encoded bytes (intermixed with text). `inlineData.data` is base64 (not a data
URL).

Note: `inlineData` is mapped based on `mimeType`.

- `image/*` -> image input (`input_image`)
- otherwise -> file input (`input_file`, e.g. `application/pdf`)

```ts
import fs from "node:fs";
import { generateText, type LlmInputMessage } from "@ljoukov/llm";

const imageB64 = fs.readFileSync("image.png").toString("base64");

const input: LlmInputMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Describe this image in 1 paragraph." },
      { type: "inlineData", mimeType: "image/png", data: imageB64 },
    ],
  },
];

const result = await generateText({ model: "gpt-5.2", input });
console.log(result.text);
```

PDF attachment example:

```ts
import fs from "node:fs";
import { generateText, type LlmInputMessage } from "@ljoukov/llm";

const pdfB64 = fs.readFileSync("doc.pdf").toString("base64");

const input: LlmInputMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Summarize this PDF in 5 bullet points." },
      { type: "inlineData", mimeType: "application/pdf", data: pdfB64 },
    ],
  },
];

const result = await generateText({ model: "gpt-5.2", input });
console.log(result.text);
```

Intermixed text + multiple images (e.g. compare two images):

```ts
import fs from "node:fs";
import { generateText, type LlmInputMessage } from "@ljoukov/llm";

const a = fs.readFileSync("a.png").toString("base64");
const b = fs.readFileSync("b.png").toString("base64");

const input: LlmInputMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Compare the two images. List the important differences." },
      { type: "text", text: "Image A:" },
      { type: "inlineData", mimeType: "image/png", data: a },
      { type: "text", text: "Image B:" },
      { type: "inlineData", mimeType: "image/png", data: b },
    ],
  },
];

const result = await generateText({ model: "gpt-5.2", input });
console.log(result.text);
```

### Gemini

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "gemini-2.5-pro",
  input: "Return exactly: OK",
});

console.log(result.text);
```

### Fireworks

Use Fireworks model ids directly (for example `kimi-k2.5`, `glm-5`, `minimax-m2.1`, `gpt-oss-120b`):

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "kimi-k2.5",
  input: "Return exactly: OK",
});

console.log(result.text);
```

### ChatGPT subscription models

Use a `chatgpt-` prefix:

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "chatgpt-gpt-5.1-codex-mini",
  input: "Return exactly: OK",
});

console.log(result.text);
```

## JSON outputs

`generateJson()` validates the output with Zod and returns the parsed value.

- OpenAI API models use structured outputs (`json_schema`) when possible.
- Gemini uses `responseJsonSchema`.
- `chatgpt-*` models try to use structured outputs too; if the endpoint/account/model rejects `json_schema`, the call
  retries with best-effort JSON parsing.

```ts
import { generateJson } from "@ljoukov/llm";
import { z } from "zod";

const schema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

const { value } = await generateJson({
  model: "gpt-5.2",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
});

console.log(value.ok, value.message);
```

### Streaming JSON outputs

Use `streamJson()` to stream thought deltas and get best-effort partial JSON snapshots while the model is still
generating.

```ts
import { streamJson } from "@ljoukov/llm";
import { z } from "zod";

const schema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

const call = streamJson({
  model: "gpt-5.2",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
});

for await (const event of call.events) {
  if (event.type === "delta" && event.channel === "thought") {
    process.stdout.write(event.text);
  }
  if (event.type === "json" && event.stage === "partial") {
    console.log("partial:", event.value);
  }
}

const { value } = await call.result;
console.log("final:", value);
```

If you only want thought deltas (no partial JSON), set `streamMode: "final"`.

```ts
const call = streamJson({
  model: "gpt-5.2",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
  streamMode: "final",
});
```

If you want to keep `generateJson()` but still stream thoughts, pass an `onEvent` callback.

```ts
const { value } = await generateJson({
  model: "gpt-5.2",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
  onEvent: (event) => {
    if (event.type === "delta" && event.channel === "thought") {
      process.stdout.write(event.text);
    }
  },
});
```

## Tools

There are three tool-enabled call patterns:

1. `generateText()` for provider-native/server-side tools (for example web search).
2. `runToolLoop()` for your runtime JS/TS tools (function tools executed in your process).
3. `runAgentLoop()` for full agentic loops (a convenience wrapper around `runToolLoop()` with built-in subagent orchestration and optional filesystem tools).

Architecture note:

- Built-in filesystem tools are not a separate execution system.
- `runAgentLoop()` can construct a filesystem toolset, merges your optional custom tools, and calls the same `runToolLoop()` engine.
- This behavior is model-agnostic at API level; profile selection only adapts tool shape for model compatibility.

### Provider-Native Tools (`generateText()`)

Use this when the model provider executes the tool remotely (for example search/code-exec style tools).

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "gpt-5.2",
  input: "Find 3 relevant sources about X and summarize them.",
  tools: [{ type: "web-search", mode: "live" }, { type: "code-execution" }],
});

console.log(result.text);
```

### Runtime Tools (`runToolLoop()`)

Use this when the model should call your local runtime functions.

```ts
import { runToolLoop, tool } from "@ljoukov/llm";
import { z } from "zod";

const result = await runToolLoop({
  model: "gpt-5.2",
  input: "What is 12 * 9? Use the tool.",
  tools: {
    multiply: tool({
      description: "Multiply two integers.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => ({ value: a * b }),
    }),
  },
});

console.log(result.text);
```

Use `customTool()` only when you need freeform/non-JSON tool input grammar.

### Agentic Loop (`runAgentLoop()`)

`runAgentLoop()` is the high-level agentic API. It supports:

- optional filesystem workspace tools,
- built-in subagent orchestration (delegate work across spawned agents),
- your own custom runtime tools.

#### 1) Filesystem agent loop

For read/search/write tasks in a workspace, enable `filesystemTool`. The library auto-selects a tool profile by model
when `profile: "auto"`:

- Codex-like models: Codex-compatible filesystem tool shape.
- Gemini models: Gemini-compatible filesystem tool shape.
- Other models: model-agnostic profile (currently Gemini-style).

Confinement/policy is set through `filesystemTool.options`:

- `cwd`: workspace root for path resolution.
- `fs`: backend (`createNodeAgentFilesystem()` or `createInMemoryAgentFilesystem()`).
- `checkAccess`: hook for allow/deny policy + audit.
- `allowOutsideCwd`: opt-out confinement (default is false).

Detailed reference: `docs/agent-filesystem-tools.md`.

Filesystem-only example:

```ts
import { createInMemoryAgentFilesystem, runAgentLoop } from "@ljoukov/llm";

const fs = createInMemoryAgentFilesystem({
  "/repo/src/a.ts": "export const value = 1;\n",
});

const result = await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Change value from 1 to 2 using filesystem tools.",
  filesystemTool: {
    profile: "auto",
    options: {
      cwd: "/repo",
      fs,
    },
  },
});

console.log(result.text);
```

#### 2) Add subagent orchestration

Enable `subagentTool` to allow delegation via Codex-style control tools:

- `spawn_agent`, `send_input`, `resume_agent`, `wait`, `close_agent`
- optional limits: `maxAgents`, `maxDepth`, wait timeouts

```ts
import { runAgentLoop } from "@ljoukov/llm";

const result = await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Plan the work, delegate in parallel where useful, and return a final merged result.",
  subagentTool: {
    enabled: true,
    maxAgents: 4,
    maxDepth: 2,
  },
});

console.log(result.text);
```

#### 3) Combine filesystem + subagents

```ts
import { createInMemoryAgentFilesystem, runAgentLoop } from "@ljoukov/llm";

const fs = createInMemoryAgentFilesystem({
  "/repo/src/a.ts": "export const value = 1;\n",
});

const result = await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Change value from 1 to 2 using filesystem tools.",
  filesystemTool: {
    profile: "auto",
    options: {
      cwd: "/repo",
      fs,
    },
  },
  subagentTool: {
    enabled: true,
    maxAgents: 4,
    maxDepth: 2,
  },
});

console.log(result.text);
```

### Agent Telemetry (Pluggable Backends)

`runAgentLoop()` supports optional telemetry hooks that keep default behavior unchanged.
You can attach any backend by implementing a sink with `emit(event)` and optional `flush()`.

```ts
import { runAgentLoop } from "@ljoukov/llm";

const result = await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Summarize the report and update output JSON files.",
  filesystemTool: true,
  telemetry: {
    includeLlmStreamEvents: false, // enable only if you need token/delta event fan-out
    sink: {
      emit: (event) => {
        // Forward to your backend (Cloud Logging, OpenTelemetry, Datadog, etc.)
        // event.type: "agent.run.started" | "agent.run.stream" | "agent.run.completed"
        // event carries runId, parentRunId, depth, model, timestamp + payload
      },
      flush: async () => {
        // Optional: flush buffered telemetry on run completion.
      },
    },
  },
});
```

Telemetry emits parent/child run correlation (`runId` + `parentRunId`) for subagents.
See `docs/agent-telemetry.md` for event schema, design rationale, and backend adapter guidance.

If you need exact control over tool definitions, build the filesystem toolset yourself and call `runToolLoop()` directly.

```ts
import {
  createFilesystemToolSetForModel,
  createInMemoryAgentFilesystem,
  runToolLoop,
} from "@ljoukov/llm";

const fs = createInMemoryAgentFilesystem({ "/repo/a.ts": "export const n = 1;\n" });
const tools = createFilesystemToolSetForModel("chatgpt-gpt-5.3-codex", {
  cwd: "/repo",
  fs,
});

const result = await runToolLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Update n to 2.",
  tools,
});
```

## Agent benchmark (filesystem extraction)

For filesystem extraction/summarization evaluation across Codex, Fireworks, and Gemini models:

```bash
npm run bench:agent
```

Standard full refresh (all tasks, auto-write `LATEST_RESULTS.md`, refresh `traces/latest`, prune old traces):

```bash
npm run bench:agent:latest
```

Estimate-only:

```bash
npm run bench:agent:estimate
```

See `benchmarks/agent/README.md` for options and output format.

## License

MIT
