# llm-browser-agent

A browser-focused, model-driven CLI agent built with `@ljoukov/llm`. Give
`llm-browser-agent run` a task in natural language: the model chooses browser
actions, inspects their results, and continues until it answers or reaches the
configured turn limit. Each `run` invocation handles one task and records an audit
log of the model and tool loop.

The separate `bridge` command keeps the local connection to Chrome running;
`run` starts the model-driven agent. Browser actions use an independently written
Manifest V3 extension, Chrome's documented `chrome.debugger` API, and an
authenticated loopback WebSocket bridge. The agent operates tabs in the Chrome
profile where you install the extension, including sites where you are already
signed in.

There is no dependency on OpenAI's Chrome extension or Codex browser runtime.
Domain permissions are owned by this CLI and can be changed with `/domains`.
The default permits all sites; restrictions are applied only when you set them.
No third-party browser-plugin prompts are loaded. The model receives the
instructions in [`prompts/browser.md`](prompts/browser.md), the browser tool
description/schema, your task, and subsequent tool results. All of those
harness-authored instructions are inspectable and replaceable.

## Setup

Run these commands from the **llm repository root**:

```sh
npm ci
npm run build
npm --prefix tools/llm-browser-agent ci
npm --prefix tools/llm-browser-agent run build
node tools/llm-browser-agent/bin/llm-browser-agent.mjs
```

On first use the CLI starts its bridge and prints the extension directory and a
private pairing URL.

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this package's `extension/` directory.
3. Open **llm Browser Agent** from Chrome's extensions menu.
4. Paste the bridge's pairing URL and click **Connect**.

Pairing is saved locally. Keep the CLI running. Subsequent starts reuse the same
port and token, so the extension reconnects. **Disconnect**
in the popup turns control off. Stopping the bridge disconnects the extension and
releases the debugger attachments it owns.

Chrome still displays its normal extension installation and debugging UI. Chrome
restricted pages, enterprise administrator policies, website behavior, and model
provider policies remain applicable. This package does not modify those controls.

## Interactive CLI

From the repository root, start the agent:

```sh
node tools/llm-browser-agent/bin/llm-browser-agent.mjs
```

It starts a local bridge automatically if one is not already running. After
pairing Chrome, type a task in plain language. Slash commands run locally and
are never sent to the model:

```text
/help
/domains
/domains inspect 123
/domains only example.com,docs.example.com
/domains allow https://another.example.com
/domains allow *.example.com
/domains block https://private.example.com
/domains remove https://another.example.com
/domains clear
/domains all
/model
/model openai:subscription:gpt-6.1-sol high
/thinking medium
/usage
/cancel
/quit
```

`/model` opens a numbered model picker and then a thinking-level picker. Explicit
model references are validated by `llm`; unsupported model/thinking combinations
are rejected. Model and thinking settings persist locally. Startup `--model`,
`--speed`, and `--thinking` options override saved choices.

`/usage` reports session tokens and model turns from completed results. It keeps
subscription API-equivalent estimates separate from charged costs. Usage for
failed or interrupted tasks may be unavailable; it is not counted as zero.

### Domain permissions

Host shorthand means its HTTPS origin: `example.com` grants
`https://example.com`, not all subdomains, protocols, or ports. A wildcard rule
such as `*.example.com` grants the apex and proper subdomains, including
`example.com` and `www.example.com`, over HTTPS on its default port. Use
`http://*.example.test:3000` for an explicit scheme/port wildcard. A wildcard must
occupy the whole leftmost label; `*.com`, wildcard IPs, and partial stars are
rejected. Use explicit origins such as `http://localhost:3000` for development.
`/domains only` replaces
the allowlist, `/domains allow` adds an origin and enables allowlist mode,
`/domains block` denies an origin, `/domains clear` denies all sites, and
`/domains all` restores unrestricted access. Explicit denies take precedence.

Rules are enforced in the extension, rather than in model instructions. They
filter tab access and apply to navigation, redirects, and child frames in
controlled tabs. Normal site resources remain allowed. This is an agent site
access policy, **not** a network egress firewall: it does not promise to block
every request made by an allowed website, or the first request of an unsolicited
popup before Chrome reports the new tab.

Chrome can report a blocked embedded frame without a verifiable URL. Restricted
mode then refuses to read the whole tab; navigate to a page without that frame
or adjust your site policy. It does not guess that an opaque frame is safe.

Allowing an origin grants browser reads and interactions with that origin using
the profile's signed-in session. It does not make the site read-only or limit
which buttons may be clicked. Browser downloads keep Chrome's normal behavior;
these domain rules do not provide a disk quota or a laptop-wide sandbox.

When restricted, arbitrary page JavaScript (`evaluate` and expression-based
`wait`) is disabled. Fixed reads, form filling, screenshots, and ordinary browser
input still work through extension-owned code. Changing permissions cancels the
active task and clears retained conversation/references; it cannot retract data
already received by a model. The model has no tool for changing these rules.

The CLI settings and extension policy are stored locally. Keep the controller's
pairing token and policy files outside any future model-writable workspace. The
current agent exposes no shell or laptop filesystem tool. Filesystem quotas and
archive extraction limits are not implemented by these browser controls.

When a frame blocks inspection, `/domains inspect <tabId>` gives the operator
origin-only frame diagnostics. It omits paths, queries, frame contents, and raw
attributes. The model has no diagnostic or permission-management tool; these
commands are local controls.

## Run a single browsing task

For one-shot tasks, start a persistent bridge with the `bridge` subcommand, then
run from another terminal at the repository root:

```sh
node tools/llm-browser-agent/bin/llm-browser-agent.mjs status
node tools/llm-browser-agent/bin/llm-browser-agent.mjs run \
  'Open https://example.com and report its heading.'
```

The default model is `openai:subscription:gpt-6.1-sol`. It uses existing `llm`
subscription authentication; it creates no keys and has no fallback to API
billing. `llm` reads `.env.local`/`.env` from the working directory, then uses its
normal subscription auth routing, including `LLM_AUTH_URL` + `LLM_AUTH_API_KEY`
or the local Codex auth file. Running from the repository root preserves this
repository's existing auth setup. Environment files and pairing tokens are never
included in the harness prompt.

Model and speed are separate options, validated by `llm`'s existing model policy:

```sh
node tools/llm-browser-agent/bin/llm-browser-agent.mjs run \
  --model openai:subscription:gpt-6.1-sol --speed standard \
  --max-steps 30 --instructions /absolute/path/to/my-instructions.txt \
  'Read the open documentation tab and summarize the installation steps.'
```

`--instructions` replaces the entire harness instruction string. It must be
nonblank, because `llm` supplies a fallback when instructions are blank. Tasks can
also come from `--task-file <file>` or `--task-file -` for stdin. Ctrl-C aborts the
model run; completed browser actions remain completed. `--max-steps` limits model
turns, including turns that execute tools.

## Inspect prompts and audit a run

```sh
node tools/llm-browser-agent/bin/llm-browser-agent.mjs prompt
node tools/llm-browser-agent/bin/llm-browser-agent.mjs prompt --instructions ./my-prompt.txt
node tools/llm-browser-agent/bin/llm-browser-agent.mjs run \
  --audit ./tools/llm-browser-agent/artifacts/my-run.jsonl \
  'Inspect the current page and report its title.'
```

`prompt` prints the harness instruction string and browser tool schema without
connecting to Chrome or a model. The runner calls `runToolLoop` directly; it does
not use the agent wrapper, subagent instructions, skills, Codex plugins, or hosted
web-search tools.

Each run records its resolved model selection, harness inputs, streamed model
events, tool inputs/results/errors, and outcome in a new JSONL file. Audit files
are created with mode `0600`; the default `artifacts/` directory is ignored by Git.
Choose an ignored destination when supplying `--audit`. Logs can contain page text,
form values, and screenshots from your task. Pairing state lives separately in
`.local/bridge.json`, also ignored by Git. Treat the pairing URL like a password.

The prompt manifest describes **harness-authored inputs**, not a claim about
the provider's complete internal context or exact serialized wire request. `llm`
normalizes tool schemas/media, reports tool errors, and may attach oversized
outputs with an explanatory notice. Model-provider instructions and policies are
outside this package. No OpenAI browser-plugin instructions are in this path.

## Use the tool without a model

One-shot commands are useful for diagnostics:

```sh
node tools/llm-browser-agent/bin/llm-browser-agent.mjs call '{"action":"tabs"}'
node tools/llm-browser-agent/bin/llm-browser-agent.mjs call \
  '{"action":"open","url":"https://example.com"}'
```

For an external agent, use **session**, a persistent JSONL process. Send one
action per line; it returns `{id,result}` or `{id,error}`. Optional string/number
`id` values are echoed. Element refs live for this session and expire on document
navigation. A separate one-shot `call` cannot reuse another process's refs.

```sh
node tools/llm-browser-agent/bin/llm-browser-agent.mjs session
```

Example inputs (replace the tab ID and ref with those observed):

```jsonl
{"id":1,"action":"tabs"}
{"id":2,"action":"snapshot","tabId":123}
{"id":3,"action":"click","tabId":123,"ref":"e7"}
```

The supported actions are:

| Action | Inputs |
| --- | --- |
| `tabs` | none |
| `open` | `url` |
| `activate`, `close` | `tabId` |
| `snapshot` | `tabId`, optional `maxChars` (default 24,000) |
| `navigate` | `tabId`, `url` |
| `back`, `forward`, `reload` | `tabId` |
| `click` | `tabId`, `ref` **or** viewport `x`,`y` |
| `fill` | `tabId`, `ref`, `text` |
| `press` | `tabId`, `key` such as `Enter`, `Tab`, `Meta+A` |
| `scroll` | `tabId`, pixel deltas `x`,`y` |
| `screenshot` | `tabId` |
| `evaluate` | `tabId`, page JavaScript `expression` |
| `wait` | `tabId`, optional truthy `expression` and `timeoutMs` (up to 30,000) |

Snapshots use Chrome's accessibility tree and return roles, labels, values, and
element refs. Calls within a session execute in order even if a model emits
parallel calls. Screenshot results are inline image content compatible with
`llm`'s multimodal tool outputs. Navigation accepts HTTP(S) URLs and `about:blank`,
subject to your current domain policy.

Screenshots use bounded inline JPEGs, with progressive downscaling for large
viewports, so ordinary screenshots do not need the optional canonical file-storage
backend. Each interactive task resets its inline-media budget; once the budget
is exhausted, use text snapshots or start another task. Programmatic callers can
call `session.resetMediaBudget()` when beginning a new tool loop.

Current limits: snapshots do not separately expand out-of-process iframe trees;
use screenshots/coordinate input for those views. There are no specialized
download, upload, browser-history search, or CAPTCHA-solving tools. Navigation
readiness is bounded at 10 seconds; slow pages can be inspected again with
`wait`/`snapshot`. These are implementation limits, not injected website policy.

### Observation strategy

Use accessibility text and element references for ordinary reading and actions;
reserve screenshots for visual evidence such as product-package diagrams,
unlabelled controls, or layout. Snapshots include observed HTTP(S) link targets,
so an agent can open a link directly without depending on a new-tab click.

Read-only source inspection of agent-browser on 2026-11-10, at commit
`f423bb090ccdcadd0de587dd77eed3430d93a306`, found a native Rust CDP client,
rather than a Playwright runtime. Its
[`take_snapshot()` implementation](https://github.com/vercel-labs/agent-browser/blob/f423bb090ccdcadd0de587dd77eed3430d93a306/cli/src/native/snapshot.rs)
reads `Accessibility.getFullAXTree`, supplements custom interactive elements with
DOM checks, and supports compact, interactive-only, scoped snapshots. Its
[`CdpClient`](https://github.com/vercel-labs/agent-browser/blob/f423bb090ccdcadd0de587dd77eed3430d93a306/cli/src/native/cdp/client.rs)
sends protocol commands over WebSockets. This package does not install or depend
on agent-browser.

Useful follow-up improvements are compact/scoped observations and change-only
results, fixed DOM helpers for custom controls missing from AX, stronger
visibility/hit-target checks, explicit browser-dialog handling, and bounded waits
for an expected UI state. These are not yet implemented here.

## Embed in another TypeScript agent

After building this package:

```ts
import { runToolLoop } from "@ljoukov/llm";
import { BrowserSession, connectBridge, createBrowserTools } from "./dist/index.js";

const client = await connectBridge(privateClientUrl); // /client URL, not /extension
try {
  const result = await runToolLoop({
    provider: "openai", access: "subscription", model: "gpt-6.1-sol",
    instructions: "Your complete browser-agent instructions.",
    input: "Your browsing task.",
    tools: createBrowserTools(new BrowserSession(client)),
    maxSteps: 30,
  });
  console.log(result.text);
} finally {
  await client.close();
}
```

The extension receives browser commands only; it never receives model
instructions or the conversation. The loopback server binds to `127.0.0.1`,
requires a random 256-bit token, rejects webpage origins, and accepts one paired
extension connection. It does not expose a webpage-callable HTTP control API.

## Why an independent Chrome extension

Chrome's documented `chrome.debugger` API exposes browser control through CDP.
This package uses its own Manifest V3 extension and authenticated local bridge;
it does not import, copy, patch, or call the OpenAI extension or native host.
Its domain rules are enforced by code owned by this package, and its model
instructions are supplied by the CLI.

Direct CDP is an alternative for an isolated profile, but Chrome's default
profile no longer accepts ordinary remote-debugging flags. An independent
extension supports an existing profile without depending on a proprietary
browser integration.

Primary references:
[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[Chrome remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port).

## Verification

```sh
npm --prefix tools/llm-browser-agent run typecheck
npm --prefix tools/llm-browser-agent test
npm --prefix tools/llm-browser-agent run build
CHROME_EXECUTABLE=/path/to/chrome npm --prefix tools/llm-browser-agent run test:chrome
```

The Chrome smoke launches an isolated temporary profile, loads only this
extension through the opt-in `Extensions.loadUnpacked` CDP interface, pairs it,
and tests real snapshots, form filling/clicks, navigation, stale refs, screenshots,
and cross-host navigation. Set `CHROME_EXECUTABLE` to a Chrome or Chrome for
Testing binary that supports this interface. It does not change your normal
Chrome profile.

To include a real model-driven task through existing subscription authentication,
run from the repository root:

```sh
CHROME_EXECUTABLE=/path/to/chrome LLM_BROWSER_LIVE=1 \
  node --import tsx tools/llm-browser-agent/test/chrome-smoke.ts
```

The live smoke checks the observed DOM result and rejects tool argument errors.
Its screenshot and subscription trace are saved under ignored `artifacts/`.

The regression suite covers authenticated bridge access, domain rules, browser
actions, stale references, bounded media, tool arguments, interactive commands,
settings persistence and usage reporting. The isolated Chrome smoke additionally
checks the extension against real browser documents and blocked frame/redirect
fixtures. Local pairing state, settings, screenshots and model traces are not
part of the source distribution.
