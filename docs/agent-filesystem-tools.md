# Agent Filesystem Tools

This document describes how filesystem tools are exposed in `@ljoukov/llm` and how profile selection works.

## What Is True

### `codex` profile

This profile is aligned to the Codex CLI tool contract:

- tool names:
  - `apply_patch`
  - `read_file`
  - `list_dir`
  - `grep_files`
- `read_file`, `list_dir`, and `grep_files` schemas mirror `codex-rs` shapes.
- `apply_patch` text and grammar follow Codex wording/format.

`apply_patch` is exposed as a **freeform custom tool** in `runToolLoop` (OpenAI/ChatGPT Responses), not JSON arguments.

### `gemini` profile

This profile uses JSON function tools and matches Gemini CLI core tool naming:

- `read_file`
- `write_file`
- `replace`
- `list_directory`
- `grep_search`
- `glob`

This is the default practical profile for non-Codex coding agents.

### `model-agnostic` profile

Currently the same toolset as `gemini` (JSON function tools).

### `auto` profile

Resolved by model id:

- contains `codex` -> `codex`
- starts with `gemini-` -> `gemini`
- otherwise -> `model-agnostic`

## Freeform vs JSON

`runToolLoop` now supports both:

- JSON function tools via `tool(...)`
- freeform/custom tools via `customTool(...)`

Gemini provider path only supports JSON function tools. If you pass a custom/freeform tool to Gemini, `runToolLoop`
throws an explicit error.

## Access Control and Filesystem Backend

Filesystem tools are built on `AgentFilesystem`:

- `createNodeAgentFilesystem()` for disk-backed execution
- `createInMemoryAgentFilesystem()` for tests/sandboxed runs

Safety hooks:

- `checkAccess(context)` for per-action allow/deny
- path confinement to `cwd` unless `allowOutsideCwd` is explicitly enabled

## Recommended Usage

Use `runAgentLoop` with `filesystemTool`:

```ts
import { createInMemoryAgentFilesystem, runAgentLoop } from "@ljoukov/llm";

const fs = createInMemoryAgentFilesystem({
  "/repo/src/a.ts": "export const value = 1;\n",
});

await runAgentLoop({
  model: "chatgpt-gpt-5.3-codex",
  input: "Change value from 1 to 2.",
  filesystemTool: {
    profile: "auto",
    options: {
      cwd: "/repo",
      fs,
    },
  },
});
```

If you need direct control, use `createCodexFilesystemToolSet` or `createGeminiFilesystemToolSet`.
