# Latest Agent Benchmark Results

This file is auto-generated from the latest benchmark run.

- Run id: `agent-fs-2026-02-19T19-48-09-871Z`
- Generated at: `2026-02-19T19:53:27.572Z`
- Tasks: `tumor-vaccine-ici`, `trappist1b-atmosphere`, `gcse-chemistry-8-9`
- Models: `chatgpt-gpt-5.3-codex`, `gemini-3.1-pro-preview`
- Grader: `chatgpt-gpt-5.2`

## Aggregate

- Cases: 4/6 pass (5/6 schema, 6/6 tool trace, 4/6 grader)
- Total latency: 555.07s
- Avg latency per case: 92.51s
- Total cost: $0.728960
- Tokens (in/cached/out): 134,999/26,516/19,804
- Thinking tokens: 27,084
- Total tokens: 181,887

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex` | FAIL | 2/3 | 3/3 | 2/3 | 82 | 79.15 | 237.46 | 0.229203 | 66,687 | 14,848 | 10,527 |
| `gemini-3.1-pro-preview` | FAIL | 3/3 | 3/3 | 2/3 | 70 | 105.87 | 317.61 | 0.499757 | 68,312 | 11,668 | 9,277 |

## Per-Task Across Runs (Best + Average)

| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex` | `tumor-vaccine-ici` | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 72.60 | 72.60 | 0.073538 | 0.073538 | 22.00 | 22 |
| `chatgpt-gpt-5.3-codex` | `trappist1b-atmosphere` | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 62.81 | 62.81 | 0.069907 | 0.069907 | 24.00 | 24 |
| `chatgpt-gpt-5.3-codex` | `gcse-chemistry-8-9` | 1 | FAIL (run 1) | 0/1 (0.0%) | 0/1 (0.0%) | 1/1 (100.0%) | 0/1 (0.0%) | 102.06 | 102.06 | 0.085758 | 0.085758 | 36.00 | 36 |
| `gemini-3.1-pro-preview` | `tumor-vaccine-ici` | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 108.47 | 108.47 | 0.166688 | 0.166688 | 22.00 | 22 |
| `gemini-3.1-pro-preview` | `trappist1b-atmosphere` | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 86.90 | 86.90 | 0.153002 | 0.153002 | 20.00 | 20 |
| `gemini-3.1-pro-preview` | `gcse-chemistry-8-9` | 1 | FAIL (run 1) | 0/1 (0.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 0/1 (0.0%) | 122.24 | 122.24 | 0.180067 | 0.180067 | 28.00 | 28 |

## Artifact Paths

- Committed traces/workspaces: `benchmarks/agent/traces/latest/`
- Raw run outputs (gitignored): `benchmarks/agent/results/`

