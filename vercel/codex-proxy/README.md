# Vercel Codex Proxy

Small Vercel app that proxies `chatgpt-*` Codex Responses requests through Vercel while using the
Cloudflare `workers/chatgpt-auth` app as the token store.

It exposes:

- `POST /api/codex/responses`
- `POST /api/codex/images/generations`
- `POST /api/codex/images/edits`
- `GET /api/health`

All endpoints require the Vercel proxy bearer token:

```bash
Authorization: Bearer $CODEX_PROXY_API_KEY
```

`x-codex-proxy-auth: $CODEX_PROXY_API_KEY` is accepted as a fallback for environments that strip
`Authorization`.

For upstream requests, the proxy exchanges its token-provider credentials for a ChatGPT access
token and account ID. It replaces the client-facing proxy authorization with the ChatGPT bearer
token and `chatgpt-account-id` header.

## Environment

Set these on the Vercel project:

- `CODEX_PROXY_API_KEY`: client-facing bearer token for this Vercel proxy
- `CHATGPT_AUTH_TOKEN_PROVIDER_URL`: Cloudflare `workers/chatgpt-auth` deployment URL
- `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY`: named caller token for this Vercel deployment, created with
  `npm run chatgpt-auth -- client create "Vercel production"`

Optional:

- `CHATGPT_AUTH_API_KEY`: fallback if `CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY` is not set
- `CHATGPT_AUTH_TOKEN_PROVIDER_STORE`: deprecated compatibility setting; the current Worker always uses D1
- `CHATGPT_CODEX_UPSTREAM_URL`: defaults to `https://chatgpt.com/backend-api/codex/responses`
- `CHATGPT_CODEX_IMAGES_UPSTREAM_URL`: image endpoint override, defaults to
  `https://chatgpt.com/backend-api/codex/images/generations`. The proxy replaces a trailing
  `/responses`, `/images/generations`, or `/images/edits` with the resource requested by the
  client. When this variable is unset and `CHATGPT_CODEX_UPSTREAM_URL` is set, image endpoint URLs
  are derived from `CHATGPT_CODEX_UPSTREAM_URL`.

## Use from `@ljoukov/llm`

Point the library at this deployment:

```bash
export CHATGPT_CODEX_PROXY_URL="https://<your-vercel-project>.vercel.app"
export CHATGPT_CODEX_PROXY_API_KEY="<same value as CODEX_PROXY_API_KEY>"
```

`CHATGPT_CODEX_PROXY_URL` may be the root deployment URL or the full `/api/codex/responses`
endpoint. The library derives the corresponding `/api/codex/images/generations` and
`/api/codex/images/edits` routes from that URL.

In proxy mode, the library sends normal Codex request bodies to Vercel. Responses requests stream
the upstream ChatGPT Codex SSE response body back to the caller. Image generation and edit
requests are forwarded without rewriting their JSON bodies, default `Accept` and `Content-Type` to
`application/json`, and return the upstream JSON response. The Responses-only `openai-beta` header
is not added to image requests.

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
