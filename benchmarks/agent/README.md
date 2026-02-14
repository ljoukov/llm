# Agent Benchmark (Filesystem Extraction + Summarization)

This benchmark evaluates a filesystem-based agent that must:

- read a science-report markdown file from disk,
- read JSON schema files from disk,
- write a required set of JSON outputs that satisfy those schemas,
- ground claims in report evidence (line refs and quotes), and
- pass an LLM grader (`chatgpt-gpt-5.2`) for fidelity and coverage.

It runs the agent with (default model set):

- ChatGPT Codex: `chatgpt-gpt-5.3-codex`
- ChatGPT Codex (Spark): `chatgpt-gpt-5.3-codex-spark`
- OpenAI Responses: `gpt-5.2`
- Fireworks: `kimi-k2.5`, `glm-5`, `minimax-m2.1`
- Gemini Pro: `gemini-2.5-pro`, `gemini-3-pro-preview`
- Gemini Flash: `gemini-flash-latest`, `gemini-3-flash-preview`

The tasks are adapted from real science papers and stored under `benchmarks/agent/input/`.
Default run uses one shared task (`tumor-vaccine-ici`) across all models so Codex vs Gemini is directly comparable.
Runs execute models in parallel and tasks/runs sequentially per model.

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
  --models chatgpt-gpt-5.3-codex,chatgpt-gpt-5.3-codex-spark,gpt-5.2,kimi-k2.5,glm-5,minimax-m2.1,gemini-2.5-pro,gemini-flash-latest,gemini-3-pro-preview,gemini-3-flash-preview \
  --tasks all \
  --runs 3 \
  --reasoning medium \
  --grader-model chatgpt-gpt-5.2 \
  --max-steps 100
```

Patch `traces/latest` with only newly rerun cases (keep older model/task results):

```bash
npx tsx benchmarks/agent/run.ts \
  --models chatgpt-gpt-5.3-codex,chatgpt-gpt-5.3-codex-spark \
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
4. LLM grading with `chatgpt-gpt-5.2`:
   - faithfulness,
   - coverage,
   - practical usefulness.

## Output

Each benchmark run writes a dedicated folder:

- `benchmarks/agent/results/agent-fs-<timestamp>/summary.json`
- `benchmarks/agent/results/agent-fs-<timestamp>/report.md`
- `benchmarks/agent/results/agent-fs-<timestamp>/workspaces/<model-task-run>/...`

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
