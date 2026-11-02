# Vercel LLM Proxy

Small Vercel app that proxies OpenAI subscription Codex Responses requests through Vercel while using the
Cloudflare `workers/llm-auth` app as the token store.

It exposes:

- `POST /api/codex/responses`
- `POST /api/codex/images/generations`
- `POST /api/codex/images/edits`
- `GET /api/health`

All endpoints require the Vercel proxy bearer token:

```bash
Authorization: Bearer $LLM_PROXY_API_KEY
```

`x-llm-proxy-auth: $LLM_PROXY_API_KEY` is accepted as a fallback for environments that strip
`Authorization`.

For upstream requests, the proxy exchanges its token-provider credentials for a ChatGPT access
token and account ID. It replaces the client-facing proxy authorization with the ChatGPT bearer
token and `chatgpt-account-id` header.

## Environment

Set these on the Vercel project:

- `LLM_PROXY_API_KEY`: client-facing bearer token for this Vercel proxy
- `LLM_AUTH_URL`: Cloudflare `workers/llm-auth` deployment URL
- `LLM_AUTH_API_KEY`: named caller token for this Vercel deployment, created with
  `npm run llm-auth -- client create "Vercel production"`

Optional:

- `LLM_PROXY_OPENAI_UPSTREAM_URL`: defaults to `https://chatgpt.com/backend-api/codex/responses`
- `LLM_PROXY_OPENAI_IMAGES_UPSTREAM_URL`: image endpoint override, defaults to
  `https://chatgpt.com/backend-api/codex/images/generations`. The proxy replaces a trailing
  `/responses`, `/images/generations`, or `/images/edits` with the resource requested by the
  client. When this variable is unset and `LLM_PROXY_OPENAI_UPSTREAM_URL` is set, image endpoint URLs
  are derived from `LLM_PROXY_OPENAI_UPSTREAM_URL`.

## Use from `@ljoukov/llm`

Point the library at this deployment:

```bash
export LLM_PROXY_URL="https://<your-vercel-project>.vercel.app"
export LLM_PROXY_API_KEY="<same value as LLM_PROXY_API_KEY>"
```

Select this subscription route explicitly with
`{ provider: "openai", access: "subscription", model: "gpt-6.1-sol" }`.

`LLM_PROXY_URL` may be the root deployment URL or the full `/api/codex/responses`
endpoint. The library derives the corresponding `/api/codex/images/generations` and
`/api/codex/images/edits` routes from that URL.

In proxy mode, the library sends normal Codex request bodies to Vercel. Responses requests stream
the upstream ChatGPT Codex SSE response body back to the caller. Image generation and edit
requests are forwarded without rewriting their JSON bodies, default `Accept` and `Content-Type` to
`application/json`, and return the upstream JSON response. The Responses-only `openai-beta` header
is not added to image requests.

## Deploy

```bash
cd vercel/llm-proxy
vercel link
vercel env add LLM_PROXY_API_KEY production
vercel env add LLM_AUTH_URL production
vercel env add LLM_AUTH_API_KEY production
vercel deploy --prod
```

For local development:

```bash
LLM_PROXY_API_KEY=local-proxy-key \
LLM_AUTH_URL=https://example.invalid \
LLM_AUTH_API_KEY=local-worker-key \
npm run local
```

The relay currently serves OpenAI subscriptions only. Grok uses the shared auth service but sends inference directly to xAI. Retired `CODEX_PROXY_API_KEY` and `CHATGPT_*` gateway variables are not accepted.
