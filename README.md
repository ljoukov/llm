# @ljoukov/llm

[![npm version](https://img.shields.io/npm/v/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![npm downloads](https://img.shields.io/npm/dm/@ljoukov/llm.svg)](https://www.npmjs.com/package/@ljoukov/llm)
[![CI](https://github.com/ljoukov/llm/actions/workflows/ci.yml/badge.svg)](https://github.com/ljoukov/llm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ljoukov/llm.svg)](./LICENSE)

Unified TypeScript wrapper over:

- **OpenAI Responses API** and **ChatGPT subscription access** (`provider: "openai"`)
- **Anthropic Claude API** and **Claude Code subscription access** (`provider: "anthropic"`)
- **Google Gemini** via **Vertex AI** or the **Gemini Developer API** (`provider: "google"`)
- **Vercel AI Gateway** with namespaced model passthrough (`provider: "vercel"`)
- **Fireworks** for DeepSeek V4.1 Flash, GLM-5.3, and Kimi K3 (`provider: "fireworks"`)
- **xAI Grok API** and **Grok CLI subscription access** (`provider: "xai"`)
- **Agentic orchestration with subagents** via `runAgentLoop()` + built-in delegation control tools

Designed around a single streaming API that yields:

- response text deltas
- thought (reasoning summary) deltas
- usage token counts + reported or estimated USD cost, with unknown prices represented explicitly

## Install

```bash
npm i @ljoukov/llm
```

Requires Node.js 22 or newer.

## Model selection

Use a typed provider, a model ID, and an optional access mode on every generation or agent request:

```ts
import { generateText, parseModelRef, type LlmModelRef } from "@ljoukov/llm";

const model = {
  provider: "vercel",
  model: "reflection/beam-free",
} satisfies LlmModelRef;

const result = await generateText({ ...model, input: "Return exactly: OK" });

const subscriptionResult = await generateText({
  provider: "openai",
  model: "gpt-6.1-sol-fast",
  access: "subscription",
  input: "Return exactly: OK",
});

// Configuration and CLI values can use an explicit provider:access:model slug.
const selection = parseModelRef("openai:subscription:gpt-6.1-sol-fast");
const configuredResult = await generateText({ ...selection, input: "Return exactly: OK" });
```

`access` is `"api"` by default. `"subscription"` selects the provider's locally authenticated subscription transport;
it never falls back to a paid API key. An explicit provider always takes precedence over environment-based selection.
The discriminated `LlmModelRef` type rejects unsupported provider/model/access combinations.

| Provider | Access | Models |
| --- | --- | --- |
| `openai` | API or subscription | Separate closed literal allowlists of native `gpt-*` IDs, including `-fast` variants |
| `anthropic` | API or subscription | Native `claude-*` IDs on either route |
| `google` | API | Supported Gemini IDs, authenticated with a Gemini key or Vertex service account |
| `fireworks` | API | The three listed short IDs below |
| `vercel` | API | Known short IDs or a namespaced `publisher/model` ID |
| `xai` | API or subscription | Grok models exposed by the respective route |

Vercel namespaced IDs use the template literal type `` `${string}/${string}` ``. The library accepts future catalog
entries without a package release and validates nonempty namespace/model segments and whitespace at runtime.
For example, all of these are valid Vercel selections:

```ts
const models = [
  { provider: "vercel", model: "reflection/beam-free" },
  { provider: "vercel", model: "nvidia/nemotron-3.5-lightning-free" },
  { provider: "vercel", model: "moonshotai/kimi-k3.1-pro" },
  { provider: "vercel", model: "minimax/minimax-m3" },
  { provider: "vercel", model: "zai/glm-5.3" },
] satisfies LlmModelRef[];
```

A namespaced ID requires an explicit Vercel provider. Accepting an ID passes the request through; the provider still
controls availability, credentials, limits, supported modalities, tools, structured outputs, and reasoning options.
OpenAI IDs remain closed allowlists; selecting another provider does not open the direct OpenAI route to arbitrary strings.

`parseModelRef()` requires all three fields: `"<provider>:<api|subscription>:<model>"`. It splits the first two colons and
preserves the remaining model ID, including any provider-native colons. Object selections are the canonical API.
For known short IDs, omitting `provider` retains model-based inference and Vercel/Fireworks preference. Prefer explicit
objects when storing or sharing model configurations.

### Migrating to version 12

Version 12 removes route-encoding aliases without compatibility fallbacks:

| Previous selection | Version 12 selection |
| --- | --- |
| `model: "chatgpt-gpt-6.1-sol"` | `provider: "openai", model: "gpt-6.1-sol", access: "subscription"` |
| `model: "chatgpt-gpt-6.1-sol-fast"` | `provider: "openai", model: "gpt-6.1-sol-fast", access: "subscription"` |
| `model: "sonnet-5-5"` | `provider: "anthropic", model: "claude-sonnet-5-5"` |
| `model: "claude-sonnet-5-5"` for a subscription | `provider: "anthropic", model: "claude-sonnet-5-5", access: "subscription"` |
| `model: "chatgpt-gpt-image-2"` | `provider: "openai", model: "gpt-image-2", access: "subscription"` |
| `provider: "claude"` or `provider: "chatgpt"` | `provider: "anthropic"` or `provider: "openai"`, with `access: "subscription"` |
| Subscription API-equivalent estimate in `costUsd` | `costUsd: null`, `costSource: "subscription"`, separate `apiEquivalentCostUsd` |
| Unknown model price represented as `0` | `costUsd: null`, `costSource: "unknown"` |

The `CHATGPT_*` environment variables still configure the OpenAI subscription transport and its token-provider/proxy
services; their names are independent of public model selection. `-fast` remains a typed variant that sends the base
OpenAI model with priority processing. Subagents inherit the complete resolved selection.

## Environment variables

This package optionally loads `.env.local`, then `.env`, from `process.cwd()` (Node.js) on first use using
dotenv-style `KEY=value` syntax. Existing `process.env` values take priority, followed by `.env.local`, then `.env`.

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

`GOOGLE_SERVICE_ACCOUNT_JSON` selects Vertex AI when set, including when an API key is also present. Otherwise,
`GEMINI_API_KEY` or `GOOGLE_API_KEY` selects the Gemini Developer API. Unset the service account variable to use an API key.

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

### Anthropic Claude API

- `ANTHROPIC_API_KEY`

Keep provider keys in server-side environment variables or a git-ignored `.env.local` file.

### Claude Code subscription models

Install Claude Code and sign in with your Claude subscription using `claude auth login`. Requests with
`provider: "anthropic", access: "subscription"` reuse that local login through the Claude Agent SDK, which launches
Claude Code as a subprocess. They require a local
Node.js environment where Claude Code can run; the subscription route is unsuitable for edge runtimes.
The executable defaults to `claude` on `PATH`; set `LLM_CLAUDE_EXECUTABLE` to use a specific installation.

The library keeps API-key authentication separate from this route so a parent process's `ANTHROPIC_API_KEY` cannot
silently turn a subscription call into an API-key call. It does not read or copy raw OAuth credentials into the library.
Claude subscription limits and any enabled Claude Code extra usage apply.

### Vercel AI Gateway and Fireworks

- `VERCEL_AI_GATEWAY_API_KEY` for Vercel AI Gateway
- `FIREWORKS_TOKEN` (or `FIREWORKS_API_KEY`)
- `LLM_PROVIDER` (optional: `vercel` or `fireworks`)

For `deepseek-v4.1-flash-1017`, `glm-5.3`, and `kimi-k3`, the library prefers Vercel AI Gateway when
`VERCEL_AI_GATEWAY_API_KEY` is present and otherwise uses Fireworks. Keep both keys to switch providers without changing
credentials. Set `LLM_PROVIDER` to choose a process-wide default, or pass `provider: "vercel"` or
`provider: "fireworks"` on a text-generation, tool-loop, or agent-loop request to override it for that request.
An explicitly selected provider requires its own key.

```ts
const result = await generateText({
  model: "kimi-k3",
  provider: "fireworks",
  input: "Return exactly: OK",
});
```

This automatic preference applies only to the three shared short IDs when `provider` is omitted. An explicit provider
always wins. Namespaced Vercel IDs require `provider: "vercel"`. Other providers require their own credentials; the
presence of a Vercel key does not redirect an explicit OpenAI, Anthropic, Google, Fireworks, or xAI request.

### ChatGPT subscription models

Requests with `provider: "openai", access: "subscription"` reuse the ChatGPT OAuth tokens stored by the Codex CLI:

- `${CODEX_HOME:-~/.codex}/auth.json`

If you deploy to multiple environments (Vercel, GCP, local dev, etc.), use a centralized HTTPS token provider that owns
refresh-token rotation and serves short-lived access tokens.

- `CHATGPT_AUTH_TOKEN_PROVIDER_URL` (example: `https://chatgpt-auth.<your-domain>`)
- `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY` (prefer a named caller token created by the provider CLI)
- `CHATGPT_AUTH_API_KEY` (backward-compatible fallback; the Worker uses this as its admin secret)
- `CHATGPT_AUTH_TOKEN_PROVIDER_STORE` (deprecated compatibility setting; the current Worker always uses D1)
- `CHATGPT_CODEX_PROXY_URL` (optional Vercel proxy endpoint; accepts either `https://<project>.vercel.app` or `https://<project>.vercel.app/api/codex/responses`)
- `CHATGPT_CODEX_PROXY_API_KEY` (bearer token for `CHATGPT_CODEX_PROXY_URL`)
- `CHATGPT_CODEX_ENDPOINT` (optional direct endpoint override; defaults to `https://chatgpt.com/backend-api/codex/responses`)
- `CHATGPT_CODEX_IMAGES_ENDPOINT` (optional direct Images endpoint override; generation/edit paths are derived from it)
- `CHATGPT_RESPONSES_WEBSOCKET_MODE` (`auto` | `off` | `only`, default: `auto`)

This repo includes a Cloudflare Workers token provider implementation in `workers/chatgpt-auth/`.
It also includes a minimal Vercel streaming proxy app in `vercel/codex-proxy/`.

If `CHATGPT_AUTH_TOKEN_PROVIDER_URL` plus `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY` (or the legacy
`CHATGPT_AUTH_API_KEY`) are set, OpenAI subscription requests fetch a newly selected account from the token provider for each
top-level request and do not read the local Codex auth store. The included Worker rotates atomically across enabled
subscription accounts and records which named caller received which account. See
`workers/chatgpt-auth/README.md` for browser-assisted account login and caller-management commands.

If `CHATGPT_CODEX_PROXY_URL` + `CHATGPT_CODEX_PROXY_API_KEY` are set, OpenAI subscription text and image requests are sent
through that proxy and the local process does not need access to the Codex auth store or token provider. The Vercel
proxy fetches short-lived ChatGPT access tokens from `workers/chatgpt-auth`; it streams Responses traffic and forwards
Images JSON. These proxy bearer tokens should be server-side environment variables; do not expose them in browser
bundles.

### xAI Grok

- `XAI_API_KEY` for API access
- `XAI_BASE_URL` (optional API endpoint override; defaults to `https://api.x.ai/v1`)
- `XAI_TIMEOUT_MS` (optional request timeout in milliseconds)

For subscription access, install the official Grok CLI and sign in:

```sh
npm i -g @xai-official/grok
grok login
# For a headless login, use: grok login --device-auth
```

The library reuses the Grok CLI login in `~/.grok/auth.json`; `GROK_HOME` or `GROK_AUTH_PATH` can select the CLI's
alternate auth location. The official CLI owns token refresh and refresh-token rotation, including its cross-process
lock. Expired or rejected credentials may invoke `grok --no-auto-update models` to refresh through that CLI.

Subscription inference goes directly to the official CLI chat proxy at `https://cli-chat-proxy.grok.com/v1`, using
its streaming chat-completions interface as documented in the
[Grok CLI README](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md#using-authjson-for-api-access). The package retains control of its own tool loop. Subscription traffic does
not use `XAI_BASE_URL` or fall back to `XAI_API_KEY`. A valid local login and its plan's model access are required;
authentication failures direct you back to `grok login`.

### Responses transport

For both OpenAI API and subscription requests, this library tries **Responses WebSocket transport first** and falls back
to HTTP/SSE automatically when needed.

- `auto` (default): try WebSocket first, then fall back to SSE
- `off`: use SSE only
- `only`: require WebSocket (no fallback)

When fallback is triggered by an unsupported WebSocket upgrade response (for example `426`), the library keeps using
SSE for the rest of the process to avoid repeated failing upgrade attempts.

### Adaptive per-model concurrency

Provider calls use adaptive, overload-aware per-model concurrency. Configure hard caps in code (clamped to `1..64`):

```ts
import { configureModelConcurrency } from "@ljoukov/llm";

configureModelConcurrency({
  globalCap: 16,
  providerCaps: {
    openai: 16,
    google: 3,
    vercel: 16,
    fireworks: 8,
    anthropic: 4,
    xai: 4,
  },
  modelCaps: {
    "gpt-6-luna": 24,
  },
  providerModelCaps: {
    google: {
      "gemini-3.1-pro-preview": 2,
    },
  },
});
```

`globalCap` supplies a per-model default, and `providerCaps` supplies a per-model default for each provider. Neither
is an aggregate process-wide limit. More specific settings take precedence: `providerModelCaps`, then `modelCaps`,
then `providerCaps`, then `globalCap`. For example, five Vercel models can each have 16 calls in flight; use an
application-level queue to cap the total across models. Bound memory-heavy tools separately from inference calls.

Vercel starts at its configured cap without an artificial delay between request starts. Exhausted overload retries
reduce its adaptive concurrency; successful requests gradually restore it. Changes to the configuration also apply
to subsequent calls for Vercel and Anthropic API models that have already been used.

Default caps (without configuration):

- OpenAI: `12`
- Google preview models (`*preview*`): `2`
- Other Google models: `4`
- Vercel AI Gateway: `16`
- Fireworks: `6`
- Anthropic: `4`
- Anthropic subscription access: `2`
- xAI API: `6`
- xAI subscription access: `2`

### Rate limits and retries

[Vercel documents](https://vercel.com/docs/ai-gateway/rate-limits) no Gateway rate limit on its paid tier. Free-tier
limits vary by model, and upstream providers can return `429` on either tier. A concurrency cap controls local
in-flight calls; it does not guarantee an upstream request or token rate.

Vercel, Fireworks, xAI, and native Anthropic API calls make at most four HTTP attempts for connection failures,
`408`, `409`, `429`, and `5xx` responses, unless the server sends `x-should-retry: false`. Retries honor valid
`Retry-After` seconds or HTTP dates and `retry-after-ms`, with exponential backoff and jitter as a minimum.
Rate-limit cooldowns are shared by concurrent calls to the same model in this process. Abort signals cancel queueing, backoff, and requests. Authentication,
permission, invalid-request, and budget errors such as `400`, `401`, `402`, and `403` are surfaced without retrying.

These HTTP retries stop once a successful response has been handed to the stream reader. A later stream failure
is surfaced instead of replaying a partially delivered answer or tool call. Google permits at most three attempts,
only before its first stream chunk. OpenAI retains its SDK's two retries and existing WebSocket-to-SSE fallback.
Provider timing metrics include retry attempts and backoff delays for the shared HTTP retry layer.

## Usage

Use OpenAI-style request fields:

- `input`: string or message array
- `instructions`: optional top-level system instructions
- message roles: `developer`, `system`, `user`, `assistant`

### Basic (non-streaming)

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  provider: "openai",
  model: "gpt-6-luna",
  input: "Write one sentence about TypeScript.",
});

console.log(result.text);
console.log(result.usage, result.costUsd, result.costSource);
```

### Image Generation

`generateImages()` is the low-level, direct image API. Set `provider: "openai"`, `model: "gpt-image-2"`, and the
credential route; no GPT text model is involved:

| Access | Authentication and billing | Endpoint |
| --- | --- | --- |
| `"api"` (default) | `OPENAI_API_KEY` / public API billing | OpenAI Images API `/v1/images/generations` or `/v1/images/edits` |
| `"subscription"` | ChatGPT/Codex login / subscription allowance | ChatGPT Codex `/backend-api/codex/images/generations` or `/backend-api/codex/images/edits` |

Providing `styleImages` selects the corresponding edit endpoint. Otherwise, the generation
endpoint is used. The subscription path calls GPT Image 2 directly; it does not send the prompt
through Responses or an orchestrating text model.

#### Direct public API

```ts
import {
  generateImages,
  type LlmOpenAiImageResolution,
  OPENAI_GPT_IMAGE_2_QUALITY_LEVELS,
  OPENAI_GPT_IMAGE_2_RESOLUTIONS,
  OPENAI_GPT_IMAGE_2_SEMANTIC_SIZE_RESOLUTIONS,
  OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS,
} from "@ljoukov/llm";

const customResolution = "1440x960" satisfies LlmOpenAiImageResolution;

const images = await generateImages({
  provider: "openai",
  model: "gpt-image-2",
  stylePrompt: "Warm amber desk light, deep blue night, cinematic laboratory mood.",
  imagePrompts: ["A compact lab bench still life with glassware and an open notebook"],
  imageSize: "landscape",
  imageQuality: "low",
  numImages: 1,
});

console.log(OPENAI_GPT_IMAGE_2_RESOLUTIONS, OPENAI_GPT_IMAGE_2_QUALITY_LEVELS);
console.log(OPENAI_GPT_IMAGE_2_SEMANTIC_SIZE_RESOLUTIONS);
console.log(OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS);
console.log(images[0]?.mimeType, images[0]?.data.byteLength);

// Use imageResolution instead when exact/custom dimensions are required.
const exactImages = await generateImages({
  provider: "openai",
  model: "gpt-image-2",
  stylePrompt: "Technical product illustration.",
  imagePrompts: ["An exploded view of a mechanical keyboard switch"],
  imageResolution: customResolution,
  imageQuality: "medium",
  outputFormat: "webp",
  outputCompression: 80,
});
```

GPT Image 2 has two mutually exclusive size controls:

- `imageSize`: `"square"` → `1024x1024`, `"landscape"` → `1536x1024`, `"portrait"` →
  `1024x1536`, or `"auto"`.
- `imageResolution`: `"auto"` or an exact `WIDTHxHEIGHT` string, including custom dimensions.

Do not pass both. `OPENAI_GPT_IMAGE_2_RESOLUTIONS` exposes the popular exact presets plus
`"auto"`. Custom resolutions must satisfy `OPENAI_GPT_IMAGE_2_SIZE_CONSTRAINTS`: each edge is at
most 3840px and a multiple of 16px, the aspect ratio is at most 3:1, and total pixels are between
655,360 and 8,294,400. Resolutions above 3,686,400 pixels are experimental. Gemini image requests
also use a property named `imageSize`, but their model-discriminated values are `"1K"`, `"2K"`,
or `"4K"`.

The direct public route supports `imageSize` or `imageResolution`, `imageQuality`, `numImages`,
`background`, `outputFormat`, `outputCompression`, and `moderation`. `stylePrompt`, `styleImages`,
and `imagePrompts` compose the generation/edit prompt. `imagePrompts` produces one request per
entry, while `numImages` controls `n` within each request. `partialImages` is reserved for a
streaming image API and is rejected by the non-streaming `generateImages()` call.

The official GPT Image 2 output estimates for one image, checked October 22, 2026, are:

| Quality | Square `1024x1024` | Portrait `1024x1536` | Landscape `1536x1024` |
| --- | ---: | ---: | ---: |
| `low` | $0.006 | $0.005 | $0.005 |
| `medium` | $0.053 | $0.041 | $0.041 |
| `high` | $0.211 | $0.165 | $0.165 |

When usage is reported, the library prices prompt text at $5, input images at $8, and image output
at $30 per million tokens. It uses reported output tokens for any generated resolution and avoids
adding the per-image estimate again. Direct Images API calls have no cached-input discount.
When output usage is missing, the table supplies an approximate output charge; custom resolutions
use the nearest listed orientation, and `auto` uses the medium square default. Known input tokens
are still added. Consult the current
[OpenAI image generation cost calculator](https://developers.openai.com/api/docs/guides/image-generation#calculating-costs)
before relying on a snapshot.

#### Direct ChatGPT subscription API

To use ChatGPT/Codex subscription-backed image generation, select `provider: "openai", access: "subscription"`
with the same `gpt-image-2` model ID:

```ts
const images = await generateImages({
  provider: "openai",
  access: "subscription",
  model: "gpt-image-2",
  stylePrompt: "Warm amber desk light, deep blue night, cinematic laboratory mood.",
  imagePrompts: [
    "Create a tall upright 2:3 portrait canvas showing a compact lab bench with glassware and an open notebook. The final image must be taller than it is wide.",
  ],
  background: "auto",
});
```

This route reuses the same ChatGPT auth setup as OpenAI subscription text requests. It supports
`background`; up to five `styleImages` can be supplied for an edit. It returns one image per
`imagePrompts` entry, so repeat or vary entries when multiple images are needed. The library always
sends `n: 1`, `size: "auto"`, and `quality: "auto"`, and therefore does not expose structured image
count, size, resolution, or quality properties on `LlmSubscriptionGenerateImagesRequest`. The current
subscription endpoint returns PNG and does not expose request controls for `outputFormat`,
`outputCompression`, `moderation`, or `action`. Telemetry sets `costUsd` to `null` and records an
`apiEquivalentCostUsd` estimate from returned usage, or the service's returned quality/size when usage is absent.
These estimates are for comparison; they are not subscription charges or remaining plan allowance.

Put the desired canvas orientation or aspect ratio directly in `imagePrompts`. In a live check on
July 13, 2026, prompt instructions selected all three canvas shapes while the request kept size,
quality, and background on `auto`:

| Prompt intent | Observed service quality | Observed PNG dimensions |
| --- | --- | --- |
| Very wide panoramic 3:1 landscape canvas | `medium` | `2172x724` |
| Tall upright 2:3 portrait canvas | `low` | `1024x1536` |
| Exact 1:1 square icon canvas | `low` | `1254x1254` |

Structured non-auto size requests were normalized by the private service and are intentionally not
part of the subscription API. Prompt-driven aspect ratios work, but exact pixel dimensions remain
service-selected. Use public `gpt-image-2` with `imageResolution` when pixel dimensions are a hard
requirement.

#### Image generation in agent loops

For the common agent case, enable `imageGenerationTool` on `runAgentLoop()`. The outer `model` is
always the text/reasoning model that decides whether to invoke image generation:

```ts
import { runAgentLoop } from "@ljoukov/llm";

const result = await runAgentLoop({
  provider: "openai",
  access: "subscription",
  model: "gpt-5.6-sol",
  input:
    "Create a very wide panoramic 3:1 landscape canvas illustrating a moonlit paper-cut forest. The final image must be much wider than it is tall.",
  imageGenerationTool: true,
});

console.log(result.steps.flatMap((step) => step.toolCalls));
```

By default, the convenience option follows the outer model's credential route:

- An OpenAI API text model such as `gpt-5.6` receives the provider-hosted Responses
  `image_generation` tool with nested `model: "gpt-image-2"`.
- A ChatGPT-authenticated text model receives a runtime `image_generation` function tool that
  directly calls the subscription Images endpoint with `model: "gpt-image-2"`.

Set `imageGenerationTool` to an explicit `{ provider: "openai", model: "gpt-image-2", access }` object to override that default.
Structured size and quality options require API access; subscription
tools derive aspect ratio from the prompt and let the service select quality automatically.

For advanced routing, wire the tool explicitly. This example deliberately uses a public OpenAI
text model for orchestration and the ChatGPT subscription for rendering:

```ts
import { createImageGenerationTool, runToolLoop } from "@ljoukov/llm";

const result = await runToolLoop({
  provider: "openai",
  model: "gpt-5.6",
  input:
    "Generate a tall upright 2:3 portrait poster canvas of a glass observatory above the clouds. The final image must be taller than it is wide.",
  tools: {
    image_generation: createImageGenerationTool({
      provider: "openai",
      access: "subscription",
      model: "gpt-image-2",
    }),
  },
});
```

To expose the public hosted Responses tool directly, use `modelTools`. Hosted image output is
returned as an `inlineData` part in `result.content`:

```ts
const result = await runToolLoop({
  provider: "openai",
  model: "gpt-5.6",
  input: "Generate a wide watercolor panorama of a coastal village.",
  tools: {},
  modelTools: [
    {
      type: "image-generation",
      model: "gpt-image-2",
      imageSize: "landscape",
      imageQuality: "high",
      outputFormat: "webp",
      background: "opaque",
    },
  ],
});

const generated = result.content?.parts.find((part) => part.type === "inlineData");
```

The hosted public tool additionally exposes `action`, `outputFormat`, `outputCompression`,
`moderation`, and `inputImageMask`. It is only available with OpenAI API text models. For a
ChatGPT-authenticated outer model, use `imageGenerationTool` or `createImageGenerationTool()` so
rendering happens through the direct subscription endpoint. GPT Image 2 always processes input
images at high fidelity, and this library does not expose paid partial-image streaming until it can
surface those intermediate images as events.

### Streaming (response + thoughts + usage)

```ts
import { streamText } from "@ljoukov/llm";

const call = streamText({
  provider: "openai",
  model: "gpt-6-luna",
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

const result = await generateText({ provider: "openai", model: "gpt-6-luna", input });
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

const result = await generateText({ provider: "openai", model: "gpt-6-luna", input });
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

const result = await generateText({ provider: "openai", model: "gpt-6-luna", input });
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
  provider: "openai",
  model: "gpt-6-sol",
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

const result = await generateText({ provider: "google", model: "gemini-2.5-pro", input });
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

const result = await generateText({ provider: "openai", model: "gpt-6-luna", input });
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

const result = await generateText({ provider: "openai", model: "gpt-6-luna", input });
console.log(result.text);
```

### Gemini

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  provider: "google",
  model: "gemini-4-argon",
  thinkingLevel: "low",
  input: "Return exactly: OK",
});

console.log(result.text);
```

The text allowlist includes `gemini-4-argon` and `gemini-3.8-flash`. Both support text streaming,
structured JSON, function tools, and `low`, `medium`, or `high` thinking (`xhigh`, `max`, and `ultra` map to `high`).

### Anthropic Claude API

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  thinkingLevel: "low",
  input: "Return exactly: OK",
});

console.log(result.provider, result.access); // "anthropic", "api"
console.log(result.text, result.usage, result.costUsd);
```

Supported native IDs are `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-fable-5-1`.
The API route uses the native Messages API with response/thought streaming, validated JSON outputs, and JSON function
tools. Tool loops accept `maxOutputTokens` (default `32_000`, maximum `128_000`), including reasoning. Unsupported
hosted tools and freeform tools return explicit errors.

### Claude Code subscription access

Select the same native model with `access: "subscription"`:

```ts
const result = await generateText({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  access: "subscription",
  thinkingLevel: "low",
  input: "Return exactly: OK",
});

console.log(result.provider, result.access); // "anthropic", "subscription"
```

Each call launches the Claude Code runtime through the Agent SDK and uses its existing local subscription login.
The subscription route supports text/thought streaming, schema-validated JSON, application function tools, terminal
tools, cancellation, steering, and inherited subagent models. Only the caller's tools are enabled; Claude Code's
built-in tools and local project customizations are disabled. Previous messages are supplied as a role-labeled
transcript because the Agent SDK accepts a user prompt rather than a Messages API history; user images and PDFs
remain native media blocks. Tool schemas must describe a Zod object. The Claude concurrency cap limits top-level
sessions; nested calls with the inherited selection share their ancestor's slot to avoid waiting on themselves.

Subscription results use `costUsd: null` and `costSource: "subscription"`. The separate `apiEquivalentCostUsd` field
provides a token-value estimate where pricing is known; it is not a subscription charge or remaining plan allowance.
To run integration tests against the local subscription, opt in explicitly:

```sh
LLM_INTEGRATION_CLAUDE_SUBSCRIPTION=1 npm run test:integration:claude-subscription
```

### Gemini and Claude token costs

Known models include input, output, cached-input, and supported cache-write rates. Subscription estimates use the
corresponding API rates where available. A model without known prices has an unknown cost; it is never reported as
free solely because the library has no pricing data.

Standard global API rates checked October 22, 2026 against the official
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) pages.
Prices below are USD per million tokens. Output rates include billed reasoning tokens.

| Model | Input | Cached input | Output | Cache writes (5m / 1h) |
| --- | ---: | ---: | ---: | ---: |
| `gemini-4-argon`, through Nov 30, 2026 | $2 | $0.10 | $10 | — |
| `gemini-4-argon`, from Dec 1, 2026 | $4 | $0.20 | $20 | — |
| `gemini-3.8-flash`, through Dec 31, 2026 | $0.75 | $0.075 | $3.75 | — |
| `gemini-3.8-flash`, from Jan 1, 2027 | $1.50 | $0.15 | $7.50 | — |
| `claude-haiku-5-5`, prompt ≤100,000 tokens | $0.10 | $0.01 | $0.50 | $0.125 / $0.20 |
| `claude-haiku-5-5`, prompt >100,000 tokens | $0.50 | $0.05 | $2.50 | $0.625 / $1 |
| `claude-sonnet-5-5` | $2 | $0.10 | $10 | $2.50 / $4 |
| `claude-opus-5-5` | $4 | $0.20 | $20 | $5 / $8 |
| `claude-fable-5-1` | $10 | $0.25 | $50 | $12.50 / $20 |

The estimator automatically switches Gemini rates at the published UTC dates. Gemini Argon supports implicit caching
only. Haiku's threshold includes uncached input, cache reads, and cache writes; the higher rates apply to the whole
request. Claude `usage.promptTokens` includes all three categories, while `usage.responseTokens` already includes
reasoning, so it is charged once. Cache-write usage is priced when reported; the library does not enable caching
implicitly. Estimates cover token inference; search/tool charges, cache storage, taxes, and account-specific discounts
are excluded.

Gemini `latest` aliases use the concrete response model version's rate when known, with the last
documented alias target as a fallback. Image estimates use reported image tokens when available
and published output-token counts by image size otherwise.

### Vercel AI Gateway and Fireworks

The three shared short model IDs work with either provider. Vercel also accepts namespaced IDs directly. Requests use the
[OpenAI-compatible AI Gateway API](https://vercel.com/docs/ai-gateway/openai-compat) at
`https://ai-gateway.vercel.sh/v1` with these model IDs:

| Library model ID | Vercel AI Gateway model ID |
| --- | --- |
| `deepseek-v4.1-flash-1017` | `deepseek/deepseek-v4.1-flash-1017` |
| `glm-5.3` | `zai/glm-5.3` |
| `kimi-k3` | `moonshotai/kimi-k3` |

Set `VERCEL_AI_GATEWAY_API_KEY` to prefer Vercel automatically, or choose either provider using `LLM_PROVIDER` or the
request's `provider` option. The resolved provider is reported as `"vercel"` or `"fireworks"` in results and events.
Vercel requests set `providerOptions.gateway.sort` to `"cost"` for cost-sorted upstream routing. Availability and
Gateway settings, including stored provider credentials (BYOK), can affect the selected upstream and its price.
`costUsd` uses the Gateway's reported charge when available. For BYOK requests, it also adds any separately
reported upstream inference cost; that upstream value is an estimate and can differ from your provider contract.
When reported cost is unavailable, the library uses the public Gateway catalog's default-route token rates,
which can differ from the selected upstream's rates. Catalog data is cached in RAM; see model discovery and costs below.

#### Fireworks pricing

Use the short library model IDs below; they resolve to the exact direct Fireworks model paths. These direct serverless models and pricing were checked on October 22, 2026 against the [Fireworks catalogue](https://app.fireworks.ai/models?type=llm&capability=serverless) and authenticated inference `/models` endpoint. Routers and embedding/reranking models are excluded.

| Library model ID | Fireworks model suffix | Input / cached / output USD per million tokens |
| --- | --- | --- |
| `deepseek-v4.1-flash-1017` | `deepseek-v4p1-flash-1017` | $0.3 / $0.006 / $1.2 |
| `glm-5.3` | `glm-5p3` | $1.4 / $0.26 / $4.4 |
| `kimi-k3` | `kimi-k3` | $3 / $0.3 / $15 |

The Fireworks allowlist is limited to these three models. Use Vercel's explicit namespaced route for other Gateway models.

#### Shared streaming and tool-loop behavior

For both providers, `thinkingLevel` is forwarded as `reasoning_effort` (`ultra` maps to `max`). When omitted, each model retains its native default. Reasoning in `reasoning_content` is included in `thoughts` and thought events, and is replayed unchanged across tool calls. The provider's reported reasoning-token counts are kept in `usage.thinkingTokens`. See [Fireworks reasoning](https://docs.fireworks.ai/guides/reasoning).

Vercel and Fireworks text generation and tool loops request streaming completions, including when you await `generateText()` or `runToolLoop()`. Thought and response deltas arrive while inference is running. Fragmented tool calls are assembled before execution, and usage is collected from the final stream chunk.


Vercel and Fireworks `runToolLoop()` and `streamToolLoop()` accept optional `maxOutputTokens`, forwarded as `max_tokens` for each completion and including reasoning tokens. Omission preserves the provider default. It must be a positive safe integer. xAI and Anthropic tool loops, including subscription access, also accept this option; Gemini tool loops also accept it as `config.maxOutputTokens`, defaulting to `32_000` when omitted. OpenAI tool loops reject it. This option is not available on text-generation requests. Gemini tool-loop steps, model events, and native response metadata retain the raw completion reason, including `MAX_TOKENS`, without automatically retrying a truncated response. Provider output limits may differ from the model vendor's own service and are not inferred from context size.

Vercel and Fireworks tool-loop steps and `model` events expose the raw optional `finishReason`. In particular, `"length"` indicates an output or context budget limit, including completions containing only reasoning and no final text. It must not be interpreted as a completed mathematical answer. `"stop"` and `"tool_calls"` retain their provider meanings; unknown reasons are preserved. The library does not automatically retry or add a continuation when a limit is reached. See [Fireworks completion limits](https://docs.fireworks.ai/api-reference/post-chatcompletions#body-max-tokens).

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  model: "kimi-k3",
  input: "Return exactly: OK",
});

console.log(result.text);
```

### xAI Grok API and subscription access

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  provider: "xai",
  model: "grok-4.7",
  access: "subscription",
  input: "Return exactly: OK",
});

console.log(result.text, result.usage);
```

Omit `access` or use `access: "api"` for API-key billing. Native `grok-*` IDs are accepted, with runtime validation of
the model name. API and subscription catalogs can expose different models; discover the selected route's available
models with `listModels({ provider: "xai", access: "subscription" })`. Passing an accepted model name does not grant
account access to that model. The same streaming and application function-tool loop are used on both routes.

This release uses Chat Completions for both xAI routes. Live subscription checks with `grok-4.7` passed text
streaming, validated JSON, and a two-turn function-tool round trip. xAI's
[best-practices guide](https://docs.x.ai/developers/model-capabilities/text/best-practices) recommends the Responses API
and replaying encrypted reasoning items across turns. This transport does not preserve those Responses encrypted
reasoning items, which can affect reasoning continuity in longer conversations and agent loops.

### OpenAI subscription access

Use the same native text model IDs with explicit subscription access. These calls reuse ChatGPT/Codex authentication:

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  provider: "openai",
  model: "gpt-6-astra",
  access: "subscription",
  thinkingLevel: "high",
  input: "Return exactly: OK",
});

console.log(result.text);
```

`gpt-6-astra` supports `low`, `medium` (default), `high`, `xhigh`, and `max`; `ultra` maps to `max`. `none` and
`minimal` are not accepted by the public `thinkingLevel` type. Both access routes use the Responses streaming, JSON,
and tool-loop transport. An OpenAI subscription selection never falls back to `OPENAI_API_KEY`.

For subscription calls, estimated costs describe equivalent API usage. They are not subscription charges.
[Astra API-equivalent rates](https://developers.openai.com/api/docs/models/gpt-6-astra) use $10 input, $1 cached input,
$12.50 cache writes, and $50 output per million tokens; requests above 272,000 input tokens apply 2× input/cache rates
and 1.5× output rates. `usage.cacheWriteTokens` is populated only when reported.

Every supported text variant has a `-fast` form that sends the same base model with priority processing enabled
(`service_tier="priority"`). Priority rates are twice standard rates.
[Official pricing](https://developers.openai.com/api/docs/pricing) includes cache writes and the long-input rates.

Supported OpenAI IDs are fixed literal unions in code:

- API text: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6` (Sol alias), `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, and a `-fast` form of each.
- Subscription text: the same named variants and `-fast` forms, except the generic `gpt-5.6` and `gpt-5.6-fast` aliases.
- Images: `gpt-image-2` on either route; select `access: "subscription"` explicitly for ChatGPT/Codex.

The explicit OpenAI subscription route also accepts the existing `experimental-chatgpt-*` prefix for private model
suffixes. This experimental exception does not enable arbitrary direct OpenAI API models. Experimental prices remain
unknown unless a supported `pricingModelId` is supplied to the estimator.

Standard API estimates per million tokens are $2 / $0.10 / $10 (input / cached input / output) for GPT-6.1 Sol and
$0.10 / $0.01 / $0.50 for GPT-6 Luna. The catalog and cost metadata distinguish reported charges, estimates, and unknown
prices.

## Model discovery and costs

```ts
import { listModels, generateText } from "@ljoukov/llm";

const models = await listModels({ provider: "vercel" });
const freshModels = await listModels({ provider: "vercel", refresh: true });
const subscriptionModels = await listModels({ provider: "xai", access: "subscription" });

for (const model of models) {
  console.log(model.model, model.contextWindow, model.pricing, model.pricingSource);
}

const result = await generateText({
  provider: "vercel",
  model: "reflection/beam-free",
  input: "Return exactly: OK",
});
console.log(result.costUsd, result.costSource);
```

`listModels()` returns model selections plus available names, descriptions, context/output limits, capabilities, and
pricing. Vercel reads its [public `/v1/models` API](https://ai-gateway.vercel.sh/v1/models); no credential is sent to that catalog. xAI queries the authenticated
API or subscription catalog. Other providers return the package's supported local allowlist. Discovery does not
expand OpenAI's closed model types.

Vercel catalog prices are cached in RAM for five minutes and shared across concurrent calls. `refresh: true` bypasses
the cached age. Catalog fetches have a 1.5-second timeout. Failed refreshes retain the last successful catalog and wait 30 seconds before retrying. A first-time
catalog failure makes `listModels()` reject; generation can still use static fallback prices for known models or
report an unknown cost. No browser scraping or disk price cache is involved.

Generation results and usage events distinguish cost provenance:

| `costSource` | Meaning of `costUsd` |
| --- | --- |
| `"reported"` | Charge reported by the provider, including a reported zero |
| `"catalog"` | Token estimate from the fetched Vercel catalog |
| `"estimate"` | Token estimate from the package's static price table |
| `"unknown"` | `null`; insufficient pricing or usage data |
| `"subscription"` | `null`; the call uses subscription access |

Subscription results may include `apiEquivalentCostUsd`, a separate comparison estimate rather than a billed charge.
Missing prices stay unknown. A zero is only reported when the available price or provider-reported charge establishes
zero; a model's `-free` name alone is insufficient.

Catalog `pricing` uses USD per token (`inputRate`, `outputRate`, optional `cachedRate` and `cacheWriteRate`), with
`pricingSource` set to `"catalog"` or `"estimate"`. Multiply by one million to display rates per million tokens.
Catalog estimates can differ from the selected upstream route or account-specific rate. Call results prefer reported
charges over estimates. Other providers retain static rates until a suitable pricing API is available.

For an explicit synchronous estimate, use `estimateCallCostUsd({ modelId, provider, tokens, responseImages: 0 })`.
It reads already-cached Vercel prices or static rates and returns `number | null`; it does not fetch. Use
`resolveCallCostUsd()` for the asynchronous route-aware resolver, including catalog refresh and subscription metadata.

## JSON outputs

`generateJson()` validates the output with Zod and returns the parsed value.

- OpenAI API models use structured outputs (`json_schema`) when possible.
- Gemini uses `responseJsonSchema`.
- The Anthropic API uses native JSON schema outputs; Claude Code subscription calls use the SDK's structured output.
  Both validate the result with Zod.
- OpenAI subscription requests try to use structured outputs too; if the endpoint/account/model rejects `json_schema`, the call
  retries with best-effort JSON parsing.

```ts
import { generateJson } from "@ljoukov/llm";
import { z } from "zod";

const schema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

const { value } = await generateJson({
  provider: "openai",
  model: "gpt-6-luna",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
});

console.log(value.ok, value.message);
```

For calls that should use a smaller reasoning budget, pass the cross-model `thinkingLevel` option:

```ts
const { value } = await generateJson({
  provider: "google",
  model: "gemini-flash-latest",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
  thinkingLevel: "low",
});
```

`thinkingLevel` accepts `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. In ordinary text and tool-loop calls, `ultra` sends the provider's highest supported reasoning level (`max` for GPT-6 and GPT-5.6). In `runAgentLoop()` and `streamAgentLoop()`, it additionally enables the built-in subagent tools and Codex-style proactive delegation prompt. Pass `subagentTool: false` to opt out of delegation while retaining maximum provider reasoning.

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
  provider: "openai",
  model: "gpt-6-luna",
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
  provider: "openai",
  model: "gpt-6-luna",
  input: "Return a JSON object with ok=true and message='hello'.",
  schema,
  streamMode: "final",
});
```

If you want to keep `generateJson()` but still stream thoughts, pass an `onEvent` callback.

```ts
const { value } = await generateJson({
  provider: "openai",
  model: "gpt-6-luna",
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
  provider: "openai",
  model: "gpt-6-luna",
  input: "Return { ok: true }.",
  schema: z.object({ ok: z.boolean() }),
});

await runAgentLoop({
  provider: "openai",
  model: "gpt-6-luna",
  input: "Inspect the repo and update the file.",
  filesystemTool: true,
});
```

Per-call opt-out:

```ts
await generateJson({
  provider: "openai",
  model: "gpt-6-luna",
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

Use this when the model provider executes the tool remotely (for example search/code-exec/shell style tools).

```ts
import { generateText } from "@ljoukov/llm";

const result = await generateText({
  provider: "openai",
  model: "gpt-5.6-sol",
  input: "Run python --version in a hosted shell and summarize the result.",
  tools: [{ type: "shell" }],
});

console.log(result.text);
```

`{ type: "shell" }` uses OpenAI hosted shell containers by default. It is only supported for OpenAI API models; ChatGPT-authenticated, Gemini, and Fireworks providers reject it.

When the shell writes artifacts under `/mnt/data`, `generateText()` returns the
OpenAI container reference and the library can retrieve the resulting files:

```ts
import { downloadOpenAiContainerFile, generateText, listOpenAiContainerFiles } from "@ljoukov/llm";

const result = await generateText({
  provider: "openai",
  model: "gpt-5.6-sol",
  input:
    "Use the shell to write /mnt/data/report.txt containing 'hello'. Reply only when done.",
  tools: [{ type: "shell" }],
});

const containerId = result.openAi?.containers.find((c) => c.toolType === "shell")?.containerId;
if (!containerId) throw new Error("The response did not include a hosted shell container.");

const files = await listOpenAiContainerFiles(containerId);
const report = files.find((file) => file.path === "/mnt/data/report.txt");
if (!report) throw new Error("The shell did not create report.txt.");

const bytes = await downloadOpenAiContainerFile({
  containerId,
  fileId: report.id,
});
```

For persistent multi-step shell work, create a container first, upload any input
assets, then pass it back as a `container-reference`:

```ts
import {
  createOpenAiContainer,
  generateText,
  uploadOpenAiContainerFile,
} from "@ljoukov/llm";

const container = await createOpenAiContainer({ name: "latex-build", memoryLimit: "1g" });
const cover = await uploadOpenAiContainerFile({
  containerId: container.id,
  filename: "cover.png",
  data: coverPngBytes,
  mimeType: "image/png",
});

await generateText({
  provider: "openai",
  model: "gpt-5.6-sol",
  input: `Use ${cover.path}, write LaTeX, run xelatex, and save /mnt/data/article.pdf.`,
  tools: [{ type: "shell", environment: { type: "container-reference", containerId: container.id } }],
});
```

### Runtime Tools (`runToolLoop()`)

Use this when the model should call your local runtime functions.

```ts
import { runToolLoop, tool } from "@ljoukov/llm";
import { z } from "zod";

const result = await runToolLoop({
  provider: "openai",
  model: "gpt-6-luna",
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
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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

Subagents inherit the parent run's resolved provider, model, and access mode. The subagent control tools do not expose a model override.

For interactive runs where you want to stream events and inject steering mid-run, use `streamAgentLoop()`:

```ts
import { streamAgentLoop } from "@ljoukov/llm";

const call = streamAgentLoop({
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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

- OpenAI text models, for either API or subscription access: Codex-compatible filesystem tool shape.
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
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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
- root and subagent tool loops default to 64 model steps when `maxSteps` is omitted
- `spawn_agent.agent_type` supports built-ins aligned with codex-rs-style roles: `default`, `researcher`, `worker`, `reviewer`
- delegation guidance keeps critical-path work local, favors independent sidecar tasks with disjoint write scopes, and waits only when an agent result blocks the next step

```ts
import { runAgentLoop } from "@ljoukov/llm";

const result = await runAgentLoop({
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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
- streamed `thoughts.txt` and `response.txt` deltas during generation, batched to disk every five seconds while data is pending,
- `tool_call.txt` plus `tool_call.json` when the model asks to call tools, `output-<n>.<ext>` for inline output media, and `response.metadata.json` at completion,
- `error.txt` plus `response.metadata.json` on failure.

Completion, failure, and an explicit logging-session `flush()` immediately drain pending file deltas. Thought lines in `agent.log` are also batched every five seconds and flushed before other events and at the end of a run. Stream events themselves remain immediate. Only reasoning that the provider sends can be logged; an already-running non-streaming request must finish or be restarted with the updated library to gain live traces.

`image_url` data URLs are redacted in text/metadata logs (`data:...,...`) so base64 payloads are not printed inline.

Native text logs, metadata, console mirrors and custom log sinks redact known credential values of at least eight characters from environment variables with names containing API key, token, password, secret, credential, private key, service account or cookie. Values are read when logging, so credentials loaded after SDK import are covered; JSON-escaped values are covered too. Possible credential prefixes are withheld across streamed thought/response flushes; terminal fragments of at least eight characters are redacted, while harmless shorter tails are released. Ordinary thought/response text remains available. This changes logging only: requests, returned responses/errors, stream events and binary attachments are unchanged. It does not detect arbitrary secrets absent from those environment variables or remove sensitive files already written by earlier versions.
Every canonical upload or provider mirror is also appended to `agent.log` as a `[upload] ...` line with source,
backend, bytes, and latency. Direct `generateText()` / `streamText()` calls inherit the same upload logging when you run
them inside an agent logging session, and their `response.metadata.json` includes an `uploads` summary.

```ts
import path from "node:path";
import { runAgentLoop } from "@ljoukov/llm";

await runAgentLoop({
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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
const tools = createFilesystemToolSetForModel("gpt-6-luna", {
  cwd: "/repo",
  fs,
});

const result = await runToolLoop({
  provider: "openai",
  access: "subscription",
  model: "gpt-6-luna",
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

Run only the six Gemini/Claude models added in 10.2 (streams, JSON schemas, and function-tool round trips):

```bash
npm run test:integration:new-models
```

`LLM_INTEGRATION_MODELS` can narrow a matrix to a comma-separated list of canonical `provider:access:model` selections:

```sh
LLM_INTEGRATION_MODELS=openai:subscription:gpt-6-luna,openai:subscription:gpt-6.1-sol-fast npm run test:integration:openai-models
```

The OpenAI matrix runs selected models in parallel. To test the Gemini Developer API
when a Vertex service account is configured in `.env.local`, use `GOOGLE_SERVICE_ACCOUNT_JSON= npm run test:integration:new-models`.

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
