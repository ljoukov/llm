# LLM Subscription Admin web app

SvelteKit application built with the standard shadcn-svelte components and Tailwind theme tokens.
The app supports light, dark, and system appearance and responsive mobile/desktop layouts.

From the repository root:

```sh
npm --prefix web/admin ci
npm run dashboard:check
npm run dashboard:build
npm run chatgpt-auth:config
```

The static adapter writes `web/admin/build`. The Cloudflare Worker serves these assets alongside
its admin APIs and the server-side Google `/auth` and `/auth/callback` redirect flow. The browser
receives feature flags from `/admin/config`; credentials and the email allowlist remain server-side.
No environment files or deployment identifiers belong in this package or its build output.

Use the generated private Wrangler configuration for a complete local preview, with a disposable
local database and a local admin secret. A standalone Vite preview supplies the frontend assets
without the Worker APIs. See [the Worker guide](../../workers/chatgpt-auth/README.md) for migration,
Google sign-in, environment variables, and deployment instructions.

Add UI components through `shadcn-svelte add <component>` from this directory. Keep visual changes
in the standard components, Tailwind utility classes, and generated theme tokens.
