# chatgpt-auth seed CLI

Browser-based OAuth seeding tool for the ChatGPT auth worker.

## What it does

1. Opens OpenAI OAuth login in your browser.
2. Captures the callback on `http://localhost:1455/auth/callback`.
3. Exchanges the code for access/refresh tokens.
4. Calls `POST /v1/seed` on your worker.
5. Resolves a smoke model from ChatGPT catalog (`/backend-api/codex/models`) and runs a smoke inference through the `llm` package.

## Usage

From repo root:

```bash
npm run chatgpt-auth:seed -- --worker-url https://chatgpt-auth.<your-domain>
```

It also reads env vars from `.env.local`:

- `CHATGPT_AUTH_TOKEN_PROVIDER_URL` (or `CHATGPT_AUTH_SERVER_URL`)
- `CHATGPT_AUTH_API_KEY` (or `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY`)

So this also works:

```bash
npm run chatgpt-auth:seed
```

## Options

- `--worker-url <url>`
- `--api-key <key>`
- `--redirect-uri <uri>` (default: `http://localhost:1455/auth/callback`)
- `--timeout-ms <ms>` (default: `300000`)
- `--no-open`
- `--skip-smoke-check`
- `--smoke-model <id>` (override auto-selected model)
- `--smoke-input <text>` (default: `"hi"`)
- `--help`
