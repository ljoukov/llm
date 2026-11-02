# LLM Subscription Admin

Shared authentication for ChatGPT (`openai`) and Grok (`xai`) subscriptions. The service stores
refreshable account sessions, atomically rotates permitted accounts per provider, and issues short-lived
access tokens to named application keys. Inference normally goes directly from the application to the
provider. An optional OpenAI relay handles networks blocked by ChatGPT.

## Application setup

```dotenv
LLM_AUTH_URL=https://llm-auth.<your-domain>
LLM_AUTH_API_KEY=<named-caller-key>
```

The library requests `GET /v1/token?provider=openai|xai`. The provider filter and the key's account
selection both apply before atomic account selection. An empty selection grants no accounts.
A configured service error never falls back to a local login. No remote configuration means local
Codex/Grok CLI authentication. API access and provider-native API keys are unchanged.

## Deploy separately from the old service

Keep all hostnames, IDs, email allowlists and secrets in ignored environment files or deployment
settings. The checked-in Wrangler configuration contains placeholders. Configure:

```dotenv
LLM_AUTH_WORKER_NAME=<new-worker-name>
LLM_AUTH_DATABASE_NAME=<database-name>
LLM_AUTH_DATABASE_ID=<database-id>
LLM_AUTH_HOSTNAME=llm-auth.<your-domain>
LLM_AUTH_GROK_CLIENT_VERSION=<output-version-from-grok---version>
```

```sh
npm --prefix web/admin ci
npm run dashboard:check
npm run dashboard:build
npm run llm-auth:config
npx wrangler d1 migrations apply LLM_AUTH_DB --remote --config workers/llm-auth/.runtime/wrangler.json
npx wrangler deploy --config workers/llm-auth/.runtime/wrangler.json
npx wrangler secret put LLM_AUTH_ADMIN_API_KEY --config workers/llm-auth/.runtime/wrangler.json
```

Migrations create `llm_auth_*` tables. They have distinct names from the retired service's migrations,
so the two services may share a D1 database while keeping separate tables and credential ownership.
Do not apply this version as an in-place upgrade to the old Worker. Deploy a new Worker instead.
The generated `.runtime/` configuration is ignored. Existing ChatGPT-auth deployments are unaffected.

## Admin sign-in

Set Worker secrets `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET`, `ADMIN_BASE_URL`, and
`ADMIN_ALLOWED_EMAILS` (comma/space-separated). Add the exact `${ADMIN_BASE_URL}/auth/callback` redirect
URI to the Google web client. Preserve the old callback when keeping the old service running.
Google sign-in uses full-page `/auth` redirects, PKCE/state/nonce, verified identities, an exact email
allowlist, and HttpOnly Secure cookies. No popup or browser credential storage is used.
`ADMIN_ALLOW_KEY_LOGIN=1` optionally enables the admin-key login fallback.

Alternatively, with `LLM_AUTH_URL` and `LLM_AUTH_ADMIN_API_KEY` configured:

```sh
npm run llm-auth -- dashboard
```

This opens a one-use link that expires after 60 seconds. Admin sessions expire after eight hours.
Changing the admin secret invalidates existing sessions.

## Connect accounts

Use **Add subscription**, select **ChatGPT** or **Grok**, then approve the provider's device login.
The server owns the resulting independent refreshable session. ChatGPT device-code login must be
allowed in the account's security settings. Grok device login uses the public `auth.x.ai` issuer.

The CLI can create an isolated session without replacing the caller's normal CLI login:

```sh
npm run llm-auth -- login --provider openai --label "Personal ChatGPT"
npm run llm-auth -- login --provider xai --device-auth --label "Personal Grok"
```

Auth-file import is also available. For Grok, choose an official CLI `auth.json` and enter its CLI
version. Imports accept public xAI OIDC credentials only, never API keys or enterprise issuers.
Use a dedicated session: do not keep using an imported rotating refresh token from another process
or service. Refresh tokens stay on the server and are never returned to applications or the browser.

## Keys and activity

Create named keys, choose all enabled accounts or a fixed set across providers, rename/enable/disable,
rotate/delete, and test a key against either provider. Application keys can only obtain tokens;
management routes require admin authorization. Full keys appear once after creation/rotation and are
stored as hashes. Revocation prevents new grants; already-issued access tokens last until expiry.

Activity counts token grants and selection failures, not inference calls, token consumption, or billing.
ChatGPT account limits are available where supported. Grok limits are explicitly unavailable.
Audit events expire after `LLM_AUTH_AUDIT_RETENTION_DAYS` (default 30). `LLM_AUTH_LOG_EMAIL=1`
opts into logging full account emails; the default redacts them.

## Optional OpenAI relay

Deploy `vercel/llm-proxy` separately with `LLM_PROXY_API_KEY`, `LLM_AUTH_URL`, and a named
`LLM_AUTH_API_KEY`. Applications that need the relay set `LLM_PROXY_URL` and `LLM_PROXY_API_KEY`.
To relay ChatGPT quota checks from this Worker, set those same two settings on the Worker.
The relay uses its own named key's account scope. Grok inference does not use the relay.

## Extension boundary

Providers are explicit (`openai`, `xai`). Adding another subscription provider requires an authenticated
onboarding/refresh adapter, an inference adapter, and provider-isolation tests. Generic naming does not
imply Gemini or other subscriptions are already implemented.

## Targeted verification

With the new application settings configured, run Grok JSON and function-tool checks with
`LLM_INTEGRATION_GROK_SUBSCRIPTION=1 npm run test:integration:grok-subscription`. Restrict OpenAI
checks with `LLM_INTEGRATION_MODELS=openai:subscription:gpt-6-luna,openai:subscription:gpt-6.1-sol`
before `npm run test:integration:openai-models`. These checks consume the selected subscription's quota.
