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

- OpenAI text model ids are a closed literal allowlist. Do not add support for arbitrary strings.
- Supported OpenAI API model ids: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`.
- Supported ChatGPT-authenticated model ids: `chatgpt-gpt-5.4`, `chatgpt-gpt-5.4-fast`, `chatgpt-gpt-5.4-mini`, `chatgpt-gpt-5.3-codex-spark`.
- Remove old aliases instead of keeping backward-compatibility shims.
- Subagents must inherit the parent model. Do not add agent-facing model override fields for subagents or other model-invoked tools.

### Model Change Checks

- Do not run the full OpenAI integration matrix on every commit.
- Run `npm run test:integration:openai-models` when changing model ids, OpenAI or ChatGPT request routing, pricing, auth, transport, tool-loop behavior, or any agent model-selection path.
- Keep the OpenAI integration matrix parallelized so all supported OpenAI and ChatGPT model ids are exercised in one targeted run.
