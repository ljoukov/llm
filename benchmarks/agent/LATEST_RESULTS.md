# Latest Agent Benchmark Results

This file is auto-generated from the latest benchmark run.

- Run id: `agent-fs-2026-02-13T15-11-45-630Z`
- Generated at: `2026-02-13T15:30:13.089Z`
- Tasks: `tumor-vaccine-ici`, `trappist1b-atmosphere`, `gcse-chemistry-8-9`
- Models: `chatgpt-gpt-5.3-codex`, `gpt-5.2`, `kimi-k2.5`, `glm-5`, `minimax-m2.1`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-3-pro-preview`, `gemini-3-flash-preview`
- Grader: `chatgpt-gpt-5.2`

## Aggregate

- Cases: 7/27 pass (13/27 schema, 26/27 tool trace, 7/27 grader)
- Total latency: 5384.69s
- Avg latency per case: 199.43s
- Total cost: $2.093792
- Tokens (in/cached/out): 1,353,598/669,666/108,223
- Thinking tokens: 81,379
- Total tokens: 1,543,200

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex` | PASS | 3/3 | 3/3 | 3/3 | 80 | 75.00 | 225.00 | 0.233405 | 64,304 | 4,608 | 10,051 |
| `gpt-5.2` | FAIL | 3/3 | 3/3 | 2/3 | 100 | 195.73 | 587.19 | 0.392447 | 169,041 | 122,624 | 12,114 |
| `kimi-k2.5` | FAIL | 0/3 | 3/3 | 0/3 | 88 | 40.90 | 122.70 | 0.120302 | 107,608 | 51,801 | 15,661 |
| `glm-5` | FAIL | 1/3 | 3/3 | 0/3 | 100 | 318.61 | 955.84 | 0.188809 | 172,953 | 91,409 | 16,150 |
| `minimax-m2.1` | FAIL | 0/3 | 3/3 | 0/3 | 82 | 50.62 | 151.85 | 0.098867 | 107,243 | 42,293 | 18,000 |
| `gemini-2.5-pro` | FAIL | 1/3 | 3/3 | 0/3 | 80 | 227.36 | 682.08 | 0.416666 | 208,747 | 82,691 | 9,695 |
| `gemini-flash-latest` | FAIL | 1/3 | 3/3 | 0/3 | 74 | 241.38 | 724.14 | 0.053902 | 187,940 | 125,531 | 11,010 |
| `gemini-3-pro-preview` | FAIL | 3/3 | 3/3 | 2/3 | 76 | 276.20 | 828.60 | 0.548001 | 199,653 | 100,232 | 8,570 |
| `gemini-3-flash-preview` | FAIL | 1/3 | 2/3 | 0/3 | 62 | 369.10 | 1107.29 | 0.041393 | 136,109 | 48,477 | 6,972 |

## Artifact Paths

- Committed traces/workspaces: `benchmarks/agent/traces/latest/`
- Raw run outputs (gitignored): `benchmarks/agent/results/`

