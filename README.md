# @ljoukov/llm

[![npm version](https://img.shields.io/npm/v/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![npm downloads](https://img.shields.io/npm/dm/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![CI](https://github.com/ljoukov/llm/actions/workflows/ci.yml/badge.svg)](https://github.com/ljoukov/llm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ljoukov/llm.svg)](./LICENSE)

Unified TypeScript wrapper over:

- **OpenAI Responses API** (`openai`)
- **Google Gemini via Vertex AI** (`@google/genai`)
- **ChatGPT subscription models** via `chatgpt-*` model ids (requires `CHATGPT_AUTH_JSON_B64`)

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

### ChatGPT subscription models

- `CHATGPT_AUTH_JSON_B64`

This is a base64url-encoded JSON blob containing the ChatGPT OAuth tokens + account id (RFC 4648):
https://www.rfc-editor.org/rfc/rfc4648

## Usage

### Basic (non-streaming)

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "gpt-5.2",
  prompt: "Write one sentence about TypeScript.",
});

console.log(result.text);
console.log(result.usage, result.costUsd);
```

### Streaming (response + thoughts + usage)

```ts
import { streamText } from "@ljoukov/llm";

const call = streamText({
  model: "gpt-5.2",
  prompt: "Explain what a hash function is in one paragraph.",
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

If you want to pass the full conversation (multiple user/assistant turns), use `contents` instead of `prompt`.

Note: assistant messages use `role: "model"`.

```ts
import { generateText, type LlmContent } from "@ljoukov/llm";

const contents: LlmContent[] = [
  {
    role: "system",
    parts: [{ type: "text", text: "You are a concise assistant." }],
  },
  {
    role: "user",
    parts: [{ type: "text", text: "Summarize: Rust is a systems programming language." }],
  },
  {
    role: "model",
    parts: [{ type: "text", text: "Rust is a fast, memory-safe systems language." }],
  },
  {
    role: "user",
    parts: [{ type: "text", text: "Now rewrite it in 1 sentence." }],
  },
];

const result = await generateText({ model: "gpt-5.2", contents });
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
import { generateText, type LlmContent } from "@ljoukov/llm";

const imageB64 = fs.readFileSync("image.png").toString("base64");

const contents: LlmContent[] = [
  {
    role: "user",
    parts: [
      { type: "text", text: "Describe this image in 1 paragraph." },
      { type: "inlineData", mimeType: "image/png", data: imageB64 },
    ],
  },
];

const result = await generateText({ model: "gpt-5.2", contents });
console.log(result.text);
```

PDF attachment example:

```ts
import fs from "node:fs";
import { generateText, type LlmContent } from "@ljoukov/llm";

const pdfB64 = fs.readFileSync("doc.pdf").toString("base64");

const contents: LlmContent[] = [
  {
    role: "user",
    parts: [
      { type: "text", text: "Summarize this PDF in 5 bullet points." },
      { type: "inlineData", mimeType: "application/pdf", data: pdfB64 },
    ],
  },
];

const result = await generateText({ model: "gpt-5.2", contents });
console.log(result.text);
```

Intermixed text + multiple images (e.g. compare two images):

```ts
import fs from "node:fs";
import { generateText, type LlmContent } from "@ljoukov/llm";

const a = fs.readFileSync("a.png").toString("base64");
const b = fs.readFileSync("b.png").toString("base64");

const contents: LlmContent[] = [
  {
    role: "user",
    parts: [
      { type: "text", text: "Compare the two images. List the important differences." },
      { type: "text", text: "Image A:" },
      { type: "inlineData", mimeType: "image/png", data: a },
      { type: "text", text: "Image B:" },
      { type: "inlineData", mimeType: "image/png", data: b },
    ],
  },
];

const result = await generateText({ model: "gpt-5.2", contents });
console.log(result.text);
```

### Gemini

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "gemini-2.5-pro",
  prompt: "Return exactly: OK",
});

console.log(result.text);
```

### ChatGPT subscription models

Use a `chatgpt-` prefix:

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "chatgpt-gpt-5.1-codex-mini",
  prompt: "Return exactly: OK",
});

console.log(result.text);
```

## JSON outputs

`generateJson()` validates the output with Zod and returns the parsed value.

- OpenAI API models use structured outputs (`json_schema`) when possible.
- Gemini uses `responseJsonSchema`.
- `chatgpt-*` models fall back to best-effort JSON parsing (no strict schema mode).

```ts
import { generateJson } from "@ljoukov/llm";
import { z } from "zod";

const schema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

const { value } = await generateJson({
  model: "gpt-5.2",
  prompt: "Return a JSON object with ok=true and message='hello'.",
  schema,
});

console.log(value.ok, value.message);
```

## Tools

This library supports two kinds of tools:

- Model tools (server-side): `web-search` and `code-execution`
- Your tools (JS/TS code): use `runToolLoop()` and `tool()`

### Model tools (web search / code execution)

These tools run on the provider side.

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "gpt-5.2",
  prompt: "Find 3 relevant sources about X and summarize them.",
  tools: [{ type: "web-search", mode: "live" }, { type: "code-execution" }],
});

console.log(result.text);
```

### Your tools (function calling)

`runToolLoop()` runs a simple function-calling loop until the model returns a final answer or the step limit is hit.

```ts
import { runToolLoop, tool } from "@ljoukov/llm";
import { z } from "zod";

const result = await runToolLoop({
  model: "gpt-5.2",
  prompt: "What is 12 * 9? Use the tool.",
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

## License

MIT
