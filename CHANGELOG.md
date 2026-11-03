# Changelog

## 15.0.0 — 2026-11-03

### Breaking: Fireworks API key environment variable

- Remove `FIREWORKS_TOKEN` support completely. Set `FIREWORKS_API_KEY` for all Fireworks requests.
- Update credential errors, integration-test credential detection, and documentation to use `FIREWORKS_API_KEY`.

## 14.1.0 — 2026-11-03

### Reasoning discovery and guidance

- Treat `thinkingLevel` as portable effort by default: clamp to the nearest supported level at or below the request
  (or the minimum if necessary), and resolve `ultra` to the highest known level. Grok 4.6/4.7 now map `max`/`ultra`
  to `xhigh`, and Grok 4.5 maps them to `high`, without a discovery request before generation.
- Add `thinkingLevelPolicy: "strict"` to reject known unsupported explicit levels before inference. Preserve native
  passthrough for unknown models and existing defaults when no level is specified. Subagents inherit the policy.
- Add synchronous `resolveThinkingLevel()` and requested/effective `thinking` metadata on text results, stream
  model/usage events, and tool-loop steps. Resolve once per call/loop using cached route metadata before local mappings.
- Record provider/access, provider-returned model identity, and requested/effective thinking in native traces,
  per-call request/response metadata, step/run summaries, and completion telemetry. Label resolved effort as the
  configuration sent to the adapter rather than claiming the provider attested to an exact reasoning level.
- Expose optional native `reasoningOptions` through `listModels()`: effort values, token-budget bounds, and toggles
  from Vercel's dynamic catalogue; route-specific effort values and `defaultReasoningEffort` from xAI.
- Enrich sparse xAI model lists from the same authenticated route's `/language-models`, with a bounded, best-effort
  lookup. Missing metadata stays unknown; future native effort values are preserved without a package update.
- Document model/route differences, optional discovery, strict mode, and the changed Grok `max`/`ultra` behavior.

## 14.0.0

### Breaking: shared subscription authentication

- Replace ChatGPT-specific token-service settings with `LLM_AUTH_URL`, `LLM_AUTH_API_KEY`, and
  `LLM_AUTH_ADMIN_API_KEY`. Remove the old names, admin-key fallback for applications, and deprecated
  store selection. Rename optional proxy settings to `LLM_PROXY_URL` / `LLM_PROXY_API_KEY`.
- Use remote credentials before local Codex/Grok CLI stores; fail closed when the remote service is
  configured but incomplete or unavailable. Existing local subscription access remains available
  when remote configuration is absent.
- Rename service and relay sources to `workers/llm-auth` and `vercel/llm-proxy`. New deployments use
  isolated `llm_auth_*` tables and migration names; existing deployments can remain running.
- Add Grok subscription accounts, device approval, isolated CLI onboarding, server-owned OAuth refresh,
  provider-filtered account selection, and provider-specific API-key testing to the dashboard.
- Keep Grok inference direct to xAI. The optional relay continues to serve OpenAI subscriptions only.
- Add migration examples to the README. Provider API keys and native CLI environment names are unchanged.

### Subscription dashboard

- Add a web dashboard to the ChatGPT token provider for browser-assisted subscription login,
  auth-file import, named API keys, per-key subscription selections, key rotation/deletion, and
  grant statistics. Subscription usage windows can be checked separately from grant counts.
- Add secure admin sessions and one-time dashboard sign-in links via
  `npm run llm-auth -- dashboard`. The management CLI now reads `.env.local` and `.env`.
- Use SvelteKit and shadcn-svelte for responsive light/dark administration, with server-side Google
  OAuth, PKCE, verified email allowlisting, and private deployment configuration.
- Add an authenticated Vercel usage relay for subscription limits on networks that block Cloudflare,
  and recover subscription email, name, and plan from identity metadata.
- Add API key checks that verify authentication and scoped subscription token issuance, with
  clear failure reasons and no subscription-token disclosure. Fix profile email clipping and add
  shield favicons for browsers and iPhone home screens.
- Preserve existing callers' access to all enabled subscriptions; explicit empty key selections
  grant no subscription access. Apply Worker migrations 0002 through 0004 when upgrading.

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
