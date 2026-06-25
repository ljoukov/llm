# Vercel Codex Proxy

Small Vercel app that proxies `chatgpt-*` Codex Responses requests through Vercel while using the
Cloudflare `workers/chatgpt-auth` app as the token store.

It exposes:

- `POST /api/codex/responses`
- `GET /api/health`

Both endpoints require the Vercel proxy bearer token:

```bash
Authorization: Bearer $CODEX_PROXY_API_KEY
```

`x-codex-proxy-auth: $CODEX_PROXY_API_KEY` is accepted as a fallback for environments that strip
`Authorization`.

## Environment

Set these on the Vercel project:

- `CODEX_PROXY_API_KEY`: client-facing bearer token for this Vercel proxy
- `CHATGPT_AUTH_TOKEN_PROVIDER_URL`: Cloudflare `workers/chatgpt-auth` deployment URL
- `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY`: bearer token for the Cloudflare token provider

Optional:

- `CHATGPT_AUTH_API_KEY`: fallback if `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY` is not set
- `CHATGPT_AUTH_TOKEN_PROVIDER_STORE`: `kv` or `d1`, defaults to `kv`
- `CHATGPT_CODEX_UPSTREAM_URL`: defaults to `https://chatgpt.com/backend-api/codex/responses`

## Use from `@ljoukov/llm`

Point the library at this deployment:

```bash
export CHATGPT_CODEX_PROXY_URL="https://<your-vercel-project>.vercel.app"
export CHATGPT_CODEX_PROXY_API_KEY="<same value as CODEX_PROXY_API_KEY>"
```

`CHATGPT_CODEX_PROXY_URL` may be the root deployment URL or the full `/api/codex/responses`
endpoint.

In proxy mode, the library sends the normal Codex request body to Vercel and the Vercel function
streams the upstream ChatGPT Codex SSE response body back to the caller.

## Deploy

```bash
cd vercel/codex-proxy
vercel link
vercel env add CODEX_PROXY_API_KEY production
vercel env add CHATGPT_AUTH_TOKEN_PROVIDER_URL production
vercel env add CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY production
vercel deploy --prod
```

For local development:

```bash
CODEX_PROXY_API_KEY=local-proxy-key \
CHATGPT_AUTH_TOKEN_PROVIDER_URL=https://example.invalid \
CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY=local-worker-key \
npm run local
```
