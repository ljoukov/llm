# Agent Benchmark (Micro)

Small, budget-friendly benchmark for code-edit style tasks across three edit formats:

- `replace`
- `patch` (line-range patches)
- `hashline` (line anchors with short hashes)
- `apply_patch` (Codex-style patch envelope)

The default model is `chatgpt-gpt-5.3-codex`.

This is a **single configurable experiment harness**. You control scope with `--tasks`, `--variants`, and `--runs`.

Note: these are synthetic micro-edit tasks for cost/format sensitivity checks. They are not a direct replica of the
`react-edit-benchmark` tasks from the blog post.

## Run

```bash
npx tsx benchmarks/agent/run.ts
```

## Estimate-only mode

```bash
npx tsx benchmarks/agent/run.ts --estimate-only
```

## Common options

```bash
npx tsx benchmarks/agent/run.ts \
  --model chatgpt-gpt-5.3-codex \
  --variants replace,patch,hashline,apply_patch \
  --max-tasks 4 \
  --runs 1 \
  --reasoning low \
  --estimate-prompt-tokens 1200 \
  --estimate-response-tokens 300
```

## Typical runs

Smoke (cheap):

```bash
npx tsx benchmarks/agent/run.ts --tasks off-by-one-loop --variants apply_patch --runs 1
```

Small matrix:

```bash
npx tsx benchmarks/agent/run.ts --max-tasks 2 --variants replace,patch,hashline,apply_patch --runs 1
```

## Expected starter costs

With defaults (`4 tasks * 4 variants * 1 run = 16 calls`) and `1200/300` estimated prompt/response tokens per call:

- Estimated per call: about `$0.004500`
- Estimated total: about `$0.072000`

These are projections. Actual cost depends on usage tokens returned by the model and is reported in the output.

## Output

Results are written to `benchmarks/agent/results/`:

- `agent-micro-<timestamp>.json`
- `agent-micro-<timestamp>.md`
