# AGENTS.md

## npm release

- npm publish is handled by GitHub Actions via `.github/workflows/publish.yml`.
- Releases are triggered by Git tags (`v*`) or by manually running the `Publish` workflow with a `tag` input.
- GitHub labels do **not** trigger npm release in this repo.
- The tag must match `package.json` exactly (for example, `package.json` `3.0.2` requires tag `v3.0.2`).

### Standard release flow

1. Bump version in `package.json` and `package-lock.json`.
2. Commit and push to `main`.
3. Create and push tag `vX.Y.Z`.
4. GitHub Actions `Publish` workflow performs `npm publish`.

## Git Push Semantics

- In this repo, a user request to `push` means: integrate the current work onto local `main` first if needed, then push to `origin/main`.
- If local `main` has moved on, rebase or cherry-pick intelligently instead of pushing a side branch or overwriting `main`.
- Do not create or leave behind extra local or remote branches unless the user explicitly asks for one.

## OpenAI Model Policy

- Direct OpenAI API and subscription text and image model ids are closed literal allowlists. Do not add support for arbitrary strings on those routes. Vercel model ids may use validated `publisher/model` passthrough when `provider: "vercel"` is explicit.
- Supported OpenAI API model ids: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- Supported OpenAI image model ids: `gpt-image-2`.
- Supported OpenAI subscription text model ids (with `provider: "openai", access: "subscription"`): `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- Supported OpenAI subscription image model ids (with `provider: "openai", access: "subscription"`): `gpt-image-2`.
- Experimental ChatGPT-authenticated model ids may use the public `experimental-chatgpt-*` prefix so private/internal model suffixes do not need to be committed to this package.
- Model identity and processing speed are separate. Use `speed: "standard" | "fast" | "ultrafast"` only where the selected route supports it. Synthetic `-fast` IDs and legacy leading `chatgpt-` route aliases are rejected without compatibility shims.
- A qualified model string uses `provider:access:model`; normalize it centrally and reject conflicting explicit provider/access fields. Do not append speed as a colon component because native model IDs can contain colons.
- Document breaking model-selection changes in `CHANGELOG.md` and the README migration guide with replacement examples.
- Subagents must inherit the parent’s complete resolved provider, access mode, model, and speed. Do not add agent-facing model override fields for subagents or other model-invoked tools.

### Model Change Checks

- Do not run the full OpenAI integration matrix on every commit.
- Run `npm run test:integration:openai-models` when changing text model ids, OpenAI or ChatGPT request routing, pricing, auth, transport, tool-loop behavior, or any agent model-selection path.
- Run a targeted image-generation integration check when changing OpenAI image model ids or Image API request parameters.
- To run only authorized routes, set `LLM_INTEGRATION_MODELS` to a comma-separated list of canonical `openai:api:<model>` or `openai:subscription:<model>` references before `npm run test:integration:openai-models`; without it the full matrix runs.
- Keep the OpenAI integration matrix parallelized so all supported OpenAI and ChatGPT model ids are exercised in one targeted run.
