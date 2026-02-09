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

This package reads a `.env.local` file in `process.cwd()` (Node.js) using the same rules as Spark, and falls back to
plain environment variables.

### OpenAI

- `OPENAI_API_KEY`

### Gemini (Vertex AI)

- `GOOGLE_SERVICE_ACCOUNT_JSON` (the contents of a service account JSON key file, not a file path)

For local dev it is usually easiest to store the JSON on one line:

```bash
jq -c . < path/to/service-account.json
```

### ChatGPT subscription models

- `CHATGPT_AUTH_JSON_B64`

This is a base64url-encoded JSON blob containing the ChatGPT OAuth tokens + account id (Spark-compatible).

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
