# Agent Benchmark (Filesystem Extraction + Summarization)

This benchmark evaluates a filesystem-based agent that must:

- read a science-report markdown file from disk,
- read JSON schema files from disk,
- write a required set of JSON outputs that satisfy those schemas,
- ground claims in report evidence (line refs and quotes), and
- pass an LLM grader (`openai:subscription:gpt-6-luna`) for fidelity and coverage.

It runs the agent with (default model set):

- ChatGPT Codex (Spark): `openai:subscription:gpt-6-luna`
- OpenAI Responses: `gpt-6-sol`, `gpt-6-luna`
- Open models (automatic Vercel/Fireworks routing): `kimi-k3`, `glm-5.3`, `deepseek-v4.1-flash-1017`
- Google Gemini: `gemini-4-argon`, `gemini-3.8-flash`

The tasks are adapted from real science papers and stored under `benchmarks/agent/input/`.
Default run uses one shared task (`tumor-vaccine-ici`) across all models so Codex vs Gemini is directly comparable.
Each case runs in one of two variants: `baseline` (subagents disabled) and `subagents` (subagents enabled).
By default the harness runs both variants for fair side-by-side comparison.
Runs execute models in parallel and tasks/variants/runs sequentially per model.

Use `provider:access:model` for explicit routing, including arbitrary Vercel publisher/model IDs. For example: `--models vercel:api:reflection/beam-free,vercel:api:nvidia/nemotron-3.5-lightning-free`. Known bare model IDs retain automatic routing. Unavailable prices are reported as `unknown`.

## Run

```bash
npx tsx benchmarks/agent/run.ts
```

## Standard refresh (all tasks + latest traces + latest results)

```bash
npm run bench:agent:latest
```

This command:

- runs all default models across all benchmark tasks (models run in parallel),
- writes `benchmarks/agent/LATEST_RESULTS.md` automatically,
- rewrites `benchmarks/agent/traces/latest/`,
- prunes older trace folders so only `traces/latest/` remains.

## Estimate-only

```bash
npx tsx benchmarks/agent/run.ts --estimate-only
```

## Common options

```bash
npx tsx benchmarks/agent/run.ts \
  --models openai:subscription:gpt-6-luna,gpt-6-sol,gpt-6-luna,kimi-k3,glm-5.3,deepseek-v4.1-flash-1017,gemini-4-argon,gemini-3.8-flash \
  --tasks all \
  --variants baseline,subagents \
  --runs 3 \
  --reasoning medium \
  --grader-model openai:subscription:gpt-6-luna \
  --max-steps 100
```

Run only one variant:

```bash
npx tsx benchmarks/agent/run.ts --variant baseline
```

Patch `traces/latest` with only newly rerun cases (keep older model/task results):

```bash
npx tsx benchmarks/agent/run.ts \
  --models openai:subscription:gpt-6-luna,gpt-6-sol \
  --tasks all \
  --merge-latest
```

## What is validated

1. Schema compliance for each required output file.
2. Grounding checks:
   - line refs must match `L<number>` and be in-range,
   - claim evidence quotes must appear in the report text.
3. Tool usage traces from `runAgentLoop`:
   - at least 3 tool calls,
   - at least one successful read/list/search call,
   - at least one successful write call.
   - path policy checks: no absolute paths and no `..` traversal in tool arguments.
   - trace artifacts are written to `filesystem-access-trace.json` and `agent-run.json`.
4. LLM grading with `openai:subscription:gpt-6-luna`:
   - faithfulness,
   - coverage,
   - practical usefulness.

## Output

Each benchmark run writes a dedicated folder:

- `benchmarks/agent/results/agent-fs-<timestamp>/summary.json`
- `benchmarks/agent/results/agent-fs-<timestamp>/report.md`
- `benchmarks/agent/results/agent-fs-<timestamp>/workspaces/<model-task-variant-run>/...`

Workspace folders include:

- `input/report.md`
- `TASK.md` (resolved task instructions consumed by the agent)
- `schemas/*.schema.json`
- `output/*.json` (agent outputs)
- `agent-run.json` (full step/tool trace)
- `filesystem-access-trace.json` (filesystem-level action trace)
- `validation.json` (schema/grounding/tool/grader verdicts)

A committed high-level snapshot is kept in `benchmarks/agent/LATEST_RESULTS.md`.
Committed per-model traces/workspaces are kept in `benchmarks/agent/traces/latest/`.
Reports include a "Per-Task Across Runs (Best + Average)" section that summarizes each model/task pair across repeated runs.
Reports also include per-variant subagent usage metrics and baseline-vs-subagents speedup (`baseline avg latency / subagents avg latency`) per model/task.
