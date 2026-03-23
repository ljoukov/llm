# @ljoukov/llm

[![npm version](https://img.shields.io/npm/v/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![npm downloads](https://img.shields.io/npm/dm/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![CI](https://github.com/ljoukov/llm/actions/workflows/ci.yml/badge.svg)](https://github.com/ljoukov/llm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ljoukov/llm.svg)](./LICENSE)

Unified TypeScript wrapper over:

- **OpenAI Responses API** (`openai`)
- **Google Gemini** via **Vertex AI** or the **Gemini Developer API** (`@google/genai`)
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

Requires Node.js 22 or newer.

## Environment variables

This package optionally loads a `.env.local` file from `process.cwd()` (Node.js) on first use (dotenv-style `KEY=value`
syntax) and does not override already-set `process.env` values. It always falls back to plain environment variables.

See Node.js docs on environment variables and dotenv files: https://nodejs.org/api/environment_variables.html#dotenv

### OpenAI

- `OPENAI_API_KEY`
- `OPENAI_RESPONSES_WEBSOCKET_MODE` (`auto` | `off` | `only`, default: `auto`)
- `OPENAI_BASE_URL` (optional; defaults to `https://api.openai.com/v1`)

### Gemini

Use one backend:

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` for the Gemini Developer API
- `GOOGLE_SERVICE_ACCOUNT_JSON` for Vertex AI (the contents of a service account JSON key file, not a file path)
- `LLM_FILES_GCS_BUCKET` for canonical file storage used by `files.create()` and automatic large-attachment offload
- `LLM_FILES_GCS_PREFIX` (optional object-name prefix inside `LLM_FILES_GCS_BUCKET`)
- `VERTEX_GCS_BUCKET` for Vertex-backed Gemini file attachments / `file_id` inputs
- `VERTEX_GCS_PREFIX` (optional object-name prefix inside `VERTEX_GCS_BUCKET`)

If a Gemini API key is present, the library uses the Gemini Developer API. Otherwise it falls back to Vertex AI.

Canonical files are stored in GCS with a default `48h` TTL. OpenAI and ChatGPT consume those files via signed HTTPS
URLs. Gemini still mirrors canonical files lazily into provider-native storage when needed:

- Gemini Developer API mirrors into Gemini Files
- Vertex-backed Gemini mirrors into `VERTEX_GCS_BUCKET` and uses `gs://...` URIs

Configure lifecycle rules on those buckets if you want hard 48-hour cleanup for mirrored objects.

#### Vertex AI service account setup

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
    "gpt-5.4-mini": 24,
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
  model: "gpt-5.4-mini",
  input: "Write one sentence about TypeScript.",
});

console.log(result.text);
console.log(result.usage, result.costUsd);
```

### Streaming (response + thoughts + usage)

```ts
import { streamText } from "@ljoukov/llm";

const call = streamText({
  model: "gpt-5.4-mini",
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

const result = await generateText({ model: "gpt-5.4-mini", input });
console.log(result.text);
```

### Files API

The library now exposes an OpenAI-like canonical files API:

```ts
import fs from "node:fs";
import { files, generateText, type LlmInputMessage } from "@ljoukov/llm";

const stored = await files.create({
  data: fs.readFileSync("report.pdf"),
  filename: "report.pdf",
  mimeType: "application/pdf",
});

const input: LlmInputMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Summarize the PDF in 5 bullets." },
      { type: "input_file", file_id: stored.id, filename: stored.filename },
    ],
  },
];

const result = await generateText({ model: "gpt-5.4-mini", input });
console.log(result.text);
```

Canonical storage now uses GCS-backed objects with a `48h` TTL.

- OpenAI and ChatGPT models resolve that `file_id` to a signed HTTPS URL.
- Gemini Developer API mirrors the file lazily into Gemini Files when needed.
- Vertex-backed Gemini mirrors the file lazily into `VERTEX_GCS_BUCKET` and uses `gs://...` URIs.

Available methods:

- `files.create({ path | data, filename?, mimeType? })`
- `files.retrieve(fileId)`
- `files.delete(fileId)`
- `files.content(fileId)`

### Attachments (files / images)

Use `inlineData` parts to attach base64-encoded bytes (intermixed with text). `inlineData.data` is base64 (not a data
URL).

Optional: set `filename` on `inlineData` to preserve the original file name when the provider supports it.

Note: `inlineData` is mapped based on `mimeType`.

- `image/*` -> image input (`input_image`)
- otherwise -> file input (`input_file`, e.g. `application/pdf`)

You can also pass OpenAI-style file/image parts directly:

- `input_file` with `file_id`
- `input_image` with `file_id`

When the combined inline attachment payload in a single request would exceed about `20 MiB` of base64/data-URL text,
the library automatically uploads those attachments to the canonical files store first and swaps the prompt to file
references:

- OpenAI / ChatGPT: use signed HTTPS URLs for canonical files
- Gemini Developer API: mirrors to Gemini Files and sends `fileData.fileUri`
- Vertex AI: mirrors to `VERTEX_GCS_BUCKET` and sends `gs://...` URIs

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

const result = await generateText({ model: "gpt-5.4-mini", input });
console.log(result.text);
```

You can mix direct `file_id` parts with `inlineData`. Small attachments stay inline; oversized turns are upgraded to
canonical files automatically. Tool loops do the same for large tool outputs, and they also re-check the combined size
after parallel tool calls so a batch of individually-small images/files still gets upgraded to canonical-file
references before the next model request if the aggregate payload is too large.

You can also control image analysis fidelity with request-level `mediaResolution`:

- `low`, `medium`, `high`, `original`, `auto`
- OpenAI / ChatGPT map this onto image `detail`
- Gemini maps this onto media resolution/tokenization settings

```ts
const result = await generateText({
  model: "gpt-5.4",
  mediaResolution: "original",
  input,
});
```

OpenAI-style direct file-id example:

```ts
import { files, generateText, type LlmInputMessage } from "@ljoukov/llm";

const stored = await files.create({
  path: "doc.pdf",
});

const input: LlmInputMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Summarize the attachment." },
      { type: "input_file", file_id: stored.id, filename: stored.filename },
    ],
  },
];

const result = await generateText({ model: "gemini-2.5-pro", input });
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

const result = await generateText({ model: "gpt-5.4-mini", input });
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

const result = await generateText({ model: "gpt-5.4-mini", input });
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
  model: "chatgpt-gpt-5.4",
  input: "Return exactly: OK",
});

console.log(result.text);
```

`chatgpt-gpt-5.4-fast` is also supported as a convenience alias for ChatGPT-authenticated `gpt-5.4` with priority processing enabled (`service_tier="priority"`), matching Codex `/fast` semantics.

Supported OpenAI text model ids are fixed literal unions in code, not arbitrary strings:

- OpenAI API: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`
- ChatGPT auth: `chatgpt-gpt-5.4`, `chatgpt-gpt-5.4-fast`, `chatgpt-gpt-5.4-mini`, `chatgpt-gpt-5.3-codex-spark`

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
  model: "gpt-5.4-mini",
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
  model: "gpt-5.4-mini",
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
  model: "gpt-5.4-mini",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
  streamMode: "final",
});
```

If you want to keep `generateJson()` but still stream thoughts, pass an `onEvent` callback.

```ts
const { value } = await generateJson({
  model: "gpt-5.4-mini",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
  onEvent: (event) => {
    if (event.type === "delta" && event.channel === "thought") {
      process.stdout.write(event.text);
    }
  },
});
```

## Telemetry

Telemetry is one shared API across the library:

- direct calls: `generateText()`, `streamText()`, `generateJson()`, `streamJson()`, `generateImages()`
- agent loops: `runAgentLoop()`, `streamAgentLoop()`

Configure it once for the process with `configureTelemetry()` and override or disable it per call with `telemetry`.

```ts
import { configureTelemetry, generateJson, runAgentLoop } from "@ljoukov/llm";
import { z } from "zod";

configureTelemetry({
  includeStreamEvents: false,
  sink: {
    emit: (event) => {
      // event.type:
      //   "llm.call.started" | "llm.call.stream" | "llm.call.completed" |
      //   "agent.run.started" | "agent.run.stream" | "agent.run.completed"
    },
    flush: async () => {},
  },
});

const { value } = await generateJson({
  model: "gpt-5.4-mini",
  input: "Return { ok: true }.",
  schema: z.object({ ok: z.boolean() }),
});

await runAgentLoop({
  model: "gpt-5.4-mini",
  input: "Inspect the repo and update the file.",
  filesystemTool: true,
});
```

Per-call opt-out:

```ts
await generateJson({
  model: "gpt-5.4-mini",
  input: "Return { ok: true }.",
  schema: z.object({ ok: z.boolean() }),
  telemetry: false,
});
```

See `docs/telemetry.md` for the event schema and adapter guidance.

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
  model: "gpt-5.4-mini",
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
  model: "gpt-5.4-mini",
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

### Mid-Run Steering (Queued Input)

You can queue user steering while a tool loop is already running. Steering is applied on the next model step (it does
not interrupt the current generation/tool execution).

```ts
import { streamToolLoop, tool } from "@ljoukov/llm";
import { z } from "zod";

const call = streamToolLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
  input: "Start implementing the feature.",
  tools: {
    echo: tool({
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => ({ text }),
    }),
  },
});

// Append steering while run is active.
call.append("Focus on tests first, then refactor.");

const result = await call.result;
console.log(result.text);
```

If you already manage your own run lifecycle, you can create and pass a steering channel directly:

```ts
import { createToolLoopSteeringChannel, runAgentLoop } from "@ljoukov/llm";

const steering = createToolLoopSteeringChannel();
const run = runAgentLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
  input: "Implement the task.",
  filesystemTool: true,
  steering,
});

steering.append("Do not interrupt; apply this guidance on the next turn.");
const result = await run;
```

### Agentic Loop (`runAgentLoop()`)

`runAgentLoop()` is the high-level agentic API. It supports:

- optional filesystem workspace tools,
- built-in subagent orchestration (delegate work across spawned agents),
- your own custom runtime tools.

Subagents always inherit the parent run model. The subagent control tools do not expose a model override.

For interactive runs where you want to stream events and inject steering mid-run, use `streamAgentLoop()`:

```ts
import { streamAgentLoop } from "@ljoukov/llm";

const call = streamAgentLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
  input: "Start implementation.",
  filesystemTool: true,
});

call.append("Prioritize a minimal diff and update tests.");
const result = await call.result;
console.log(result.text);
```

#### 1) Filesystem agent loop

For read/search/write tasks in a workspace, enable `filesystemTool`. The library auto-selects a tool profile by model
when `profile: "auto"`:

- Codex-like models (`gpt-5.4`, `chatgpt-gpt-5.4`, `chatgpt-gpt-5.4-fast`, and `chatgpt-gpt-5.3-codex-spark`): Codex-compatible filesystem tool shape.
- Gemini models: Gemini-compatible filesystem tool shape.
- Other models: model-agnostic profile (currently Gemini-style).

Confinement/policy is set through `filesystemTool.options`:

- `cwd`: workspace root for path resolution.
- `fs`: backend (`createNodeAgentFilesystem()` or `createInMemoryAgentFilesystem()`).
- `checkAccess`: hook for allow/deny policy + audit.
- `allowOutsideCwd`: opt-out confinement (default is false).
- `mediaResolution`: default image fidelity for built-in `view_image` outputs.

Detailed reference: `docs/agent-filesystem-tools.md`.

Filesystem-only example:

```ts
import { createInMemoryAgentFilesystem, runAgentLoop } from "@ljoukov/llm";

const fs = createInMemoryAgentFilesystem({
  "/repo/src/a.ts": "export const value = 1;\n",
});

const result = await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
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
- `spawn_agent.agent_type` supports built-ins aligned with codex-rs-style roles: `default`, `researcher`, `worker`, `reviewer`

```ts
import { runAgentLoop } from "@ljoukov/llm";

const result = await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
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
  model: "chatgpt-gpt-5.3-codex-spark",
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

### Agent Logging (Console + Files + Redirects)

`runAgentLoop()` enables logging by default. It writes:

- console lines,
- `<workspace>/agent.log`,
- per-call artifacts under `<workspace>/llm_calls/<timestamp>-<n>/<model-id>/` by default.

Each LLM call writes:

- `request.txt`, `request.metadata.json`, `tool_call_response.txt` plus `tool_call_response.json` (when the request includes tool outputs), and `input-<n>.<ext>` attachments immediately,
- streamed `thoughts.txt` deltas during generation,
- `response.txt` for assistant text responses, `tool_call.txt` plus `tool_call.json` when the model asks to call tools, `output-<n>.<ext>` for inline output media, and `response.metadata.json` at completion,
- `error.txt` plus `response.metadata.json` on failure.

`image_url` data URLs are redacted in text/metadata logs (`data:...,...`) so base64 payloads are not printed inline.
Every canonical upload or provider mirror is also appended to `agent.log` as a `[upload] ...` line with source,
backend, bytes, and latency. Direct `generateText()` / `streamText()` calls inherit the same upload logging when you run
them inside an agent logging session, and their `response.metadata.json` includes an `uploads` summary.

```ts
import path from "node:path";
import { runAgentLoop } from "@ljoukov/llm";

await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
  input: "Do the task",
  filesystemTool: true,
  logging: {
    workspaceDir: path.join(process.cwd(), "logs", "agent"), // optional; defaults to filesystem cwd or process.cwd()
    callLogsDir: "llm_calls", // optional; relative paths resolve from workspaceDir
    mirrorToConsole: false, // useful for CLI UIs that already render stream events
    sink: {
      append: (line) => {
        // Optional extra destination (file, socket, queue, etc.)
      },
      flush: async () => {},
    },
  },
});
```

Set `logging: false` to disable logger output for a run.

If you need exact control over tool definitions, build the filesystem toolset yourself and call `runToolLoop()` directly.

```ts
import {
  createFilesystemToolSetForModel,
  createInMemoryAgentFilesystem,
  runToolLoop,
} from "@ljoukov/llm";

const fs = createInMemoryAgentFilesystem({ "/repo/a.ts": "export const n = 1;\n" });
const tools = createFilesystemToolSetForModel("chatgpt-gpt-5.3-codex-spark", {
  cwd: "/repo",
  fs,
});

const result = await runToolLoop({
  model: "chatgpt-gpt-5.3-codex-spark",
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

## Examples

Interactive CLI chat with mid-run steering, thought streaming, filesystem tools rooted at
the current directory, subagents enabled, and `Esc` interrupt support:

```bash
npm run example:cli-chat
```

## Testing

Unit tests:

```bash
npm run test:unit
```

Standard integration suite:

```bash
npm run test:integration
```

Large-file live integration tests are opt-in because they upload multi-megabyte fixtures to real canonical/provider
file stores:

```bash
LLM_INTEGRATION_LARGE_FILES=1 npm run test:integration
```

Those tests generate valid PDFs programmatically so the canonical upload path, signed-URL reuse, and automatic large
attachment offload all exercise real provider APIs. The unit suite also covers direct-call upload logging plus
`runAgentLoop()` upload telemetry/logging for combined-image overflow, and the integration suite includes provider
format coverage for common document and image attachments.

## License

MIT
