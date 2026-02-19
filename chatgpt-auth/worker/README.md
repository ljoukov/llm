# chatgpt-auth (Cloudflare Worker)

Centralized storage + refresh for ChatGPT OAuth tokens, exposed via a small bearer-protected REST API.

This is intended to back the `chatgpt-*` provider in this repo so multiple deployments (local, Vercel, GCP, etc.)
share the same token store and only the Worker performs refresh.

Companion seed CLI lives in `chatgpt-auth/seed/` and can seed this worker by running:

```bash
npm run chatgpt-auth:seed -- --worker-url https://chatgpt-auth.<your-domain>
```

## Endpoints

- `GET /v1/health`
- `GET /v1/token?store=kv|d1&cache=1|0`
- `POST /v1/seed` (accepts `{ authJsonB64 }` or `{ accessToken, refreshToken, expiresAt, accountId, idToken? }`)
- `POST /v1/refresh` (force refresh)

All endpoints require `Authorization: Bearer <CHATGPT_AUTH_API_KEY>`.

Note: some setups appear to strip `Authorization` on inbound requests. This Worker also accepts
`x-chatgpt-auth: <CHATGPT_AUTH_API_KEY>` as a fallback.

## Storage

- D1 table `chatgpt_auth_state` is the source of truth (stores refresh token and a refresh lock).
- KV key `chatgpt_auth_state_v1` is a read cache (fast reads; eventually consistent).

## Cron

Cron runs every 15 minutes and refreshes if the token expires within the next hour.

## Logging

The Worker logs `account_id` on seed/refresh. If you want the full email (from `id_token`) in logs, set:

- `CHATGPT_AUTH_LOG_EMAIL=1`

Otherwise the email is redacted.
