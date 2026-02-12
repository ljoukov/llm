# Latest Agent Benchmark Results

This file is auto-generated from the latest benchmark run.

- Run id: `agent-fs-2026-02-12T17-08-10-524Z`
- Generated at: `2026-02-12T17:23:15.828Z`
- Tasks: `tumor-vaccine-ici`, `gcse-chemistry-8-9`
- Models: `chatgpt-gpt-5.3-codex`, `gpt-5.2`, `kimi-k2.5`, `glm-5`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-3-pro-preview`, `gemini-3-flash-preview`
- Grader: `chatgpt-gpt-5.2`

## Aggregate

- Cases: 9/16 pass (10/16 schema, 14/16 tool trace, 9/16 grader)
- Total latency: 3022.59s
- Avg latency per case: 188.91s
- Total cost: $1.429731
- Tokens (in/cached/out): 756,249/402,729/58,963
- Thinking tokens: 57,710
- Total tokens: 872,922

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex` | PASS | 2/2 | 2/2 | 2/2 | 56 | 100.59 | 201.19 | 0.172799 | 50,626 | 19,456 | 6,653 |
| `gpt-5.2` | FAIL | 2/2 | 2/2 | 1/2 | 74 | 267.14 | 534.29 | 0.324877 | 115,484 | 65,920 | 7,379 |
| `kimi-k2.5` | FAIL | 1/2 | 2/2 | 1/2 | 62 | 50.19 | 100.38 | 0.079534 | 68,589 | 34,319 | 10,121 |
| `glm-5` | PASS | 2/2 | 2/2 | 2/2 | 80 | 83.16 | 166.32 | 0.138937 | 103,029 | 37,648 | 13,835 |
| `gemini-2.5-pro` | FAIL | 1/2 | 2/2 | 1/2 | 54 | 211.97 | 423.93 | 0.265816 | 142,823 | 77,942 | 6,648 |
| `gemini-flash-latest` | FAIL | 0/2 | 2/2 | 0/2 | 50 | 162.08 | 324.15 | 0.032884 | 134,784 | 82,490 | 7,671 |
| `gemini-3-pro-preview` | PASS | 2/2 | 2/2 | 2/2 | 54 | 452.60 | 905.19 | 0.396626 | 137,241 | 84,954 | 5,876 |
| `gemini-3-flash-preview` | FAIL | 0/2 | 0/2 | 0/2 | 4 | 183.57 | 367.13 | 0.018258 | 3,673 | 0 | 780 |

## Artifact Paths

- Committed traces/workspaces: `benchmarks/agent/traces/latest/`
- Raw run outputs (gitignored): `benchmarks/agent/results/`

