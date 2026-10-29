# Changelog

## 13.0.0 — 2026-10-29

### Claude subscription tokens in headless environments

- Forward `CLAUDE_CODE_OAUTH_TOKEN` to Claude Code while continuing to exclude API keys, cloud-provider credentials,
  and ambient request overrides from subscription sessions.
- Accept Claude Code's explicit OAuth-token authentication when its account metadata omits the subscription plan.
  Claude Code validates the token; API-key and cloud-provider fallbacks remain rejected.
- Document runtime token configuration and a targeted Claude subscription integration check for cloud environments.

### Breaking: model identity, route, and speed are independent

Synthetic `-fast` model IDs are removed completely. Leading `chatgpt-` model aliases are rejected. There are no
compatibility shims, automatic suffix stripping, or automatic prefix rewrites. Saved agent configurations and scripts
must migrate to native model IDs and explicit routing/speed before using version 13.

```ts
import { generateText } from "@ljoukov/llm";

// Version 13: structured selection.
const result = await generateText({
  provider: "openai",
  access: "subscription",
  model: "gpt-6.1-sol",
  speed: "fast",
  input: "Hello",
});

// Equivalent qualified-string selection, accepted directly by generation and agent requests.
const configuredResult = await generateText({
  model: "openai:subscription:gpt-6.1-sol",
  speed: "fast",
  input: "Hello",
});
```

Migration rules for agents and application maintainers:

1. Replace `gpt-6.1-sol-fast` with `gpt-6.1-sol` plus `speed: "fast"`; apply the same change to every former synthetic
   OpenAI fast ID, including Terra, Astra, Luna, and GPT-5.6 variants.
2. Replace `chatgpt-gpt-6.1-sol` with either `{ provider: "openai", access: "subscription", model: "gpt-6.1-sol" }`
   or `{ model: "openai:subscription:gpt-6.1-sol" }`.
3. Replace `chatgpt-gpt-6.1-sol-fast` with `{ model: "openai:subscription:gpt-6.1-sol", speed: "fast" }`.
4. Replace `chatgpt-gpt-image-2` with `{ model: "openai:subscription:gpt-image-2" }`; image routes do not accept speed.
5. Replace CLI `--model openai:subscription:gpt-6.1-sol-fast` with
   `--model openai:subscription:gpt-6.1-sol --speed fast`. Benchmarks accept a separate `--grader-speed` when relevant.
6. Pass `speed` explicitly to cost estimators. Removed model IDs have no compatibility pricing lookup.

### Model references

- `model` accepts a native model ID in the existing structured route or a direct `provider:access:model` reference.
- `parseModelRef("openai:subscription:gpt-6.1-sol")` still returns a reusable structured selection.
- Qualified strings and structured selections share one resolver. Conflicting explicit provider/access fields fail
  validation. Bare subscription-only IDs require an explicit subscription route.
- Only the first two colons delimit route fields. Provider-native colons remain part of the model ID. Speed is never a
  fourth colon component or query parameter.
- Direct OpenAI routes retain closed literal model allowlists. Qualified strings do not enable arbitrary OpenAI IDs.
- The distinct subscription-only `experimental-chatgpt-*` namespace for private model suffixes remains available; it
  does not restore leading `chatgpt-` route aliases. Subscription access never falls back to an API key.

### Speed and serving metadata

- `speed` accepts `"standard"`, `"fast"`, or `"ultrafast"` where the selected provider, access mode, and model support
  that choice. Unsupported combinations fail validation. Omission preserves the provider default; explicit
  `"standard"` requests standard processing.
- OpenAI maps speed to its service tier; Anthropic uses its distinct speed setting. Vercel maps the request to its
  supported fast-routing/service-tier controls. Reasoning effort remains controlled independently by `thinkingLevel`.
- Vercel fast speed is supported for known OpenAI base-model text slugs and `anthropic/claude-opus-5-5`. Known Gateway
  fast-serving aliases are rejected and filtered from discovery; use a base model plus `speed: "fast"`. Unrelated
  provider-native model names ending in `-fast` remain opaque catalog IDs rather than being stripped or rewritten.
- Each base model appears once in `listModels()`, with supported speeds described separately.
- Native `modelVersion` values remain model identities. Requested speed, effective speed, and reported service tier
  appear separately when available. Cost estimates use the served speed when the provider reports it.
- Agents and their subagents inherit provider, access, model, and speed together. Model-invoked tools expose no model
  or speed override fields.
- Benchmark speed selection reaches generation and estimate-only cost projections; a grader's speed is configured
  separately rather than inheriting a generator speed accidentally.
