# LLM Subscription Admin

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

From the repository root, keep deployment identifiers in ignored `.env.local` or shell variables:

```dotenv
CHATGPT_AUTH_WORKER_NAME=<worker-name>
CHATGPT_AUTH_DATABASE_NAME=<database-name>
CHATGPT_AUTH_DATABASE_ID=<database-id>
```

Build the SvelteKit dashboard and generate the private Wrangler configuration:

```bash
npm --prefix web/admin ci
npm run dashboard:check
npm run dashboard:build
npm run chatgpt-auth:config
npx wrangler secret put CHATGPT_AUTH_API_KEY --config workers/chatgpt-auth/.runtime/wrangler.json
npx wrangler d1 migrations apply <database-name> --remote --config workers/chatgpt-auth/.runtime/wrangler.json
npx wrangler deploy --config workers/chatgpt-auth/.runtime/wrangler.json
```

The checked-in `wrangler.json` is a generic template. The generated `.runtime/` directory is ignored;
never commit deployed URLs, resource identifiers, allowlisted emails, or credentials.

Apply the pending migrations before deploying this version over an existing single-account Worker.
`0002_multi_account_and_clients.sql` preserves the original login and adds the pool, caller, and audit
metadata. `0003_admin_dashboard.sql` adds key access policies and web admin sessions.
`0004_google_admin.sql` adds Google identity binding and one-use OAuth flows. Back up the
database first, and deploy immediately after migrating: the old single-account code expects the
original row ID, which migration 0002 changes.

## Web dashboard

The dashboard uses SvelteKit, Tailwind, and the standard shadcn-svelte components, with light/dark/system
themes and responsive layouts. Open the deployment URL to manage subscriptions, API keys, and activity.

Configure these Worker secrets for Google sign-in, using a separate Google OAuth web application:

```dotenv
ADMIN_GOOGLE_CLIENT_ID=<google-client-id>
ADMIN_GOOGLE_CLIENT_SECRET=<google-client-secret>
ADMIN_BASE_URL=https://<admin-host>
ADMIN_ALLOWED_EMAILS=<admin-email>,<another-admin-email>
```

Register exactly `${ADMIN_BASE_URL}/auth/callback` as the authorized redirect URI. JavaScript origins,
Firebase, and billing are unnecessary. For an external app in testing, add the selected accounts as
Google test users. The login button navigates through `/auth` and Google to `/auth/callback`; there
are no popups or client-side OAuth SDKs. The server verifies Google's signature, issuer, audience,
expiry, email verification, nonce, and exact email allowlist. State and PKCE bind each one-use login
to its browser. Google tokens are discarded after identity verification. Allowlist removal invalidates
Google sessions on their next request. The public client configuration exposes only feature flags.

For CLI recovery, open a one-time sign-in link:

```bash
npm run chatgpt-auth -- dashboard
# Print the short-lived link without opening a browser:
npm run chatgpt-auth -- dashboard --no-open
```

The CLI reads `CHATGPT_AUTH_ADMIN_API_KEY` (or legacy `CHATGPT_AUTH_API_KEY`) from `.env.local`,
`.env`, or the shell. Browser sessions use an eight-hour HttpOnly, Secure, SameSite=Strict cookie;
the browser does not retain the admin key. One-time links expire after 60 seconds. Rotating the
Worker's admin secret invalidates existing sessions. State-changing browser requests must originate
from the same site. Direct admin-key web login is disabled when Google is configured; set
`ADMIN_ALLOW_KEY_LOGIN=1` only if that fallback is intentionally required. Sign-in attempts are rate limited.

- Add subscriptions with **Continue with ChatGPT**. OpenAI opens in a separate tab: choose the account,
  enter the one-time code, and approve. Device code login must be enabled in that account's ChatGPT
  security settings (or workspace permissions). The server exchanges the approval for refreshable
  credentials and adds the account without replacing other subscriptions.
- Alternatively, import a Codex `auth.json` file. Refresh tokens stay on the server. This dashboard
  cannot automatically read another website's browser cookies or session; browser approval is used
  to obtain its own OAuth credentials. Signing in again to the same ChatGPT account updates that
  account's stored login.
- Create named API keys and choose **all enabled subscriptions**, including future additions, or a
  fixed selection. An empty fixed selection grants no subscriptions. Restrictions are enforced in
  the database's atomic account-selection query; a failed or disabled allowed account never falls
  back to a subscription outside that key's selection. The admin key is unrestricted; use named caller
  keys for applications. Permission changes and key revocation prevent new grants; access tokens
  already issued may remain valid until they expire.
- Rename, enable, disable, rotate, or delete keys. Full keys are shown only once after creation or
  rotation. Deletion immediately revokes the key; its historical name and activity remain in the
  audit history.
- Use **Test API key** or a key's **Test key** action to paste and check an application credential.
  Newly created or rotated keys can be tested immediately in the save dialog. The check authenticates
  the supplied key and requests a token using that key's subscription selection. It reports invalid,
  revoked, or disabled keys and unavailable permitted subscriptions. Successful checks show the chosen
  subscription and token expiry and count as token grants. Subscription credentials are never returned
  by the check; the pasted key is cleared after testing.
- View grants and failed selections by day, key, and subscription, plus the latest 100 events.
  These counts represent token-provider activity, **not model-token consumption, inference success,
  or billing**. Direct model traffic does not pass through the token provider. History starts with
  the multi-account upgrade, and events expire after the configured retention period.
- **Check limits** on a subscription fetches its current ChatGPT usage windows when available. This
  is an account-wide snapshot, including activity outside this library. Unavailable limits are
  reported explicitly, not displayed as zero usage. For networks where ChatGPT blocks Cloudflare,
  set `CHATGPT_CODEX_PROXY_URL` and `CHATGPT_CODEX_PROXY_API_KEY` on the Worker to a deployed
  `vercel/codex-proxy` instance. Its protected `/api/codex/usage` route uses exactly the selected
  subscription, validates the returned account, and forwards only a sanitized usage snapshot.
  Subscription email, name, and plan are recovered from identity claims; usage can backfill email.

## Local management CLI

The CLI offers the same account and key management without the web dashboard.
Run it from the repository root. It loads `.env.local` and then `.env` from the current directory,
preserving variables already set in the process environment. Set the Worker URL and admin secret
in either file or export them in your shell:

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
npm run chatgpt-auth -- client create "Restricted app" --accounts "<account-id>,<second-account-id>"
npm run chatgpt-auth -- client scope <client-id> --accounts "<account-id>"
npm run chatgpt-auth -- client scope <client-id> --all
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
- `POST /v1/clients/test` with `{ "token": "<caller-key>", "clientId": "<optional-expected-id>" }`
- `PATCH|DELETE /v1/clients/:clientId`
- `POST /v1/clients/:clientId/rotate`
- `GET /v1/events?limit=100&clientId=...`
- `GET /v1/stats?days=7` (1–30 days)
- `POST /v1/accounts/:accountId/usage`
- `POST /v1/admin-links` (single-use dashboard sign-in link)
- `POST /v1/login/start`, `POST /v1/login/:id/poll`, `DELETE /v1/login/:id`

Google sign-in uses `GET /auth` and `GET /auth/callback`. Public `GET /admin/config` returns feature
flags only. The CLI ticket login/logout endpoint is `POST|DELETE /admin/session`; it requires a matching `Origin`
header. `GET /v1/session` checks the current authenticated admin session. Public dashboard assets
contain no credentials or account data. Named caller keys cannot access any admin endpoint.

Admin and named-caller endpoint:

- `GET /v1/token`

Send credentials with `Authorization: Bearer ...`. `x-chatgpt-auth` and `x-api-key` remain supported
as fallbacks for environments that strip `Authorization`.

## Refresh and logging

Cron runs every 15 minutes, refreshes every enabled account expiring within an hour, and removes
expired audit events. Logs include `account_id`; email is redacted unless
`CHATGPT_AUTH_LOG_EMAIL=1`.
