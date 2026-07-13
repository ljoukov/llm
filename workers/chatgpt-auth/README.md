# chatgpt-auth (Cloudflare Worker)

Centralized storage, refresh, and round-robin selection for multiple ChatGPT OAuth accounts. The
Worker also issues named caller credentials so deployments can fetch tokens without sharing the
admin secret.

## Architecture

- D1 is the source of truth for subscription accounts, refresh locks, caller credentials, and the
  audit trail.
- `GET /v1/token` atomically selects the least-recently-used enabled account. D1 is used for this
  operation because KV cannot coordinate rotation across concurrent Worker isolates.
- Access tokens are refreshed before expiry. Refresh tokens never leave the Worker after an
  account is seeded.
- Caller tokens are stored as SHA-256 hashes. Their plaintext is returned only when a caller is
  created or rotated.
- The legacy `CHATGPT_AUTH_API_KEY` Worker secret is the admin/bootstrap credential. Named caller
  tokens can only call `GET /v1/token`.

The old `store=kv|d1` and `cache=0|1` token query parameters are accepted but ignored, so existing
clients continue to work while all coordinated selection goes through D1.

## Deploy or upgrade

From this directory:

```bash
npx wrangler secret put CHATGPT_AUTH_API_KEY
npx wrangler d1 migrations apply chatgpt-auth --remote
npx wrangler deploy
```

Apply migration `0002_multi_account_and_clients.sql` before deploying this version over an
existing single-account Worker. It preserves the original account and adds pool, caller, and audit
metadata.

## Local management CLI

The CLI is the admin surface; no internet-hosted admin panel or separate Google login is needed.
Run it from the repository root with the Worker URL and admin secret in the environment:

```bash
export CHATGPT_AUTH_TOKEN_PROVIDER_URL="https://chatgpt-auth.<your-domain>"
export CHATGPT_AUTH_ADMIN_API_KEY="<same value as the Worker CHATGPT_AUTH_API_KEY secret>"
```

Add an account with the normal Codex browser flow. The CLI gives Codex an isolated temporary home,
uploads the result, and deletes the temporary credentials, so it does not replace `~/.codex/auth.json`:

```bash
npm run chatgpt-auth -- login --label "Personal Plus"
npm run chatgpt-auth -- login --label "Work"
```

For a headless machine, use `--device-auth`. To upload the account already stored by Codex without
starting a new login, use `npm run chatgpt-auth -- import --label "Personal Plus"`.

Manage and inspect the account pool:

```bash
npm run chatgpt-auth -- account list
npm run chatgpt-auth -- account disable <account-id>
npm run chatgpt-auth -- account enable <account-id>
npm run chatgpt-auth -- account label <account-id> "New label"
npm run chatgpt-auth -- account refresh [account-id]
npm run chatgpt-auth -- account remove <account-id>
```

## Named callers

Create one credential per deployment or machine:

```bash
npm run chatgpt-auth -- client create "Vercel production"
npm run chatgpt-auth -- client create "Laptop"
npm run chatgpt-auth -- client list
```

`client create` prints the token exactly once. Put that value in the caller's
`CHATGPT_AUTH_TOKEN_PROVIDER_API_KEY`; do not use the admin secret in application deployments.

```bash
npm run chatgpt-auth -- client rotate <client-id>
npm run chatgpt-auth -- client revoke <client-id>
npm run chatgpt-auth -- events --limit 100
npm run chatgpt-auth -- events --client <client-id>
```

The caller list reports request count and last-used time. The audit view records the named caller,
selected subscription account, outcome, timestamp, and Cloudflare/request id. It deliberately does
not store access tokens, IP addresses, or request bodies. Events are retained for 30 days by
default; change `CHATGPT_AUTH_AUDIT_RETENTION_DAYS` to configure retention.

## HTTP API

Admin-only endpoints:

- `GET /v1/health`
- `GET /v1/accounts`
- `PATCH|DELETE /v1/accounts/:accountId`
- `POST /v1/seed`
- `POST /v1/refresh` with optional `{ "accountId": "..." }`
- `GET|POST /v1/clients`
- `PATCH|DELETE /v1/clients/:clientId`
- `POST /v1/clients/:clientId/rotate`
- `GET /v1/events?limit=100&clientId=...`

Admin and named-caller endpoint:

- `GET /v1/token`

Send credentials with `Authorization: Bearer ...`. `x-chatgpt-auth` and `x-api-key` remain supported
as fallbacks for environments that strip `Authorization`.

## Refresh and logging

Cron runs every 15 minutes, refreshes every enabled account expiring within an hour, and removes
expired audit events. Logs include `account_id`; email is redacted unless
`CHATGPT_AUTH_LOG_EMAIL=1`.
