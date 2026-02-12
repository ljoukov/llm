# Agent Benchmark (Filesystem Extraction + Summarization)

This benchmark evaluates a filesystem-based agent that must:

- read a science-report markdown file from disk,
- read JSON schema files from disk,
- write a required set of JSON outputs that satisfy those schemas,
- ground claims in report evidence (line refs and quotes), and
- pass an LLM grader (`gpt-5.2`) for fidelity and coverage.

It runs the agent with:

- ChatGPT Codex: `chatgpt-gpt-5.3-codex`
- Gemini Pro: `gemini-2.5-pro`
- Gemini Flash: `gemini-flash-latest`

The tasks are adapted from real science papers and stored under `benchmarks/agent/reports/`.
Default run uses one shared task (`tumor-vaccine-ici`) across all models so Codex vs Gemini is directly comparable.

## Run

```bash
npx tsx benchmarks/agent/run.ts
```

## Estimate-only

```bash
npx tsx benchmarks/agent/run.ts --estimate-only
```

## Common options

```bash
npx tsx benchmarks/agent/run.ts \
  --models chatgpt-gpt-5.3-codex,gemini-2.5-pro,gemini-flash-latest \
  --tasks tumor-vaccine-ici \
  --runs 1 \
  --reasoning medium \
  --grader-model gpt-5.2 \
  --max-steps 20
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
4. LLM grading with `gpt-5.2`:
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
- `schemas/*.schema.json`
- `output/*.json` (agent outputs)
- `agent-run.json` (full step/tool trace)
- `filesystem-access-trace.json` (filesystem-level action trace)
- `validation.json` (schema/grounding/tool/grader verdicts)

A committed high-level snapshot is kept in `benchmarks/agent/LATEST_RESULTS.md`.
