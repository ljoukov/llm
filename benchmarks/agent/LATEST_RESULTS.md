# Latest Agent Benchmark Results

This file is auto-generated from the latest benchmark run.

- Run id: `agent-fs-2026-02-12T14-34-19-197Z`
- Generated at: `2026-02-12T14:42:10.925Z`
- Tasks: `tumor-vaccine-ici`
- Models: `chatgpt-gpt-5.3-codex`, `gpt-5.2`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-3-pro-preview`, `gemini-3-flash-preview`
- Grader: `gpt-5.2`

## Aggregate

- Cases: 1/6 pass (4/6 schema, 6/6 tool trace, 1/6 grader)
- Total latency: 1536.04s
- Avg latency per case: 256.01s
- Total cost: $0.571183
- Tokens (in/cached/out): 305,062/122,289/22,192
- Thinking tokens: 27,032
- Total tokens: 354,286

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex` | PASS | 1/1 | 1/1 | 1/1 | 24 | 74.71 | 74.71 | 0.078713 | 21,422 | 0 | 3,695 |
| `gpt-5.2` | FAIL | 0/1 | 1/1 | 0/1 | 32 | 110.61 | 110.61 | 0.139197 | 39,559 | 15,744 | 4,761 |
| `gemini-2.5-pro` | FAIL | 0/1 | 1/1 | 0/1 | 26 | 226.46 | 226.46 | 0.095224 | 60,336 | 28,341 | 3,364 |
| `gemini-flash-latest` | FAIL | 1/1 | 1/1 | 0/1 | 20 | 277.75 | 277.75 | 0.022332 | 51,339 | 25,574 | 3,650 |
| `gemini-3-pro-preview` | FAIL | 1/1 | 1/1 | 0/1 | 28 | 471.69 | 471.69 | 0.217559 | 70,675 | 34,906 | 3,209 |
| `gemini-3-flash-preview` | FAIL | 1/1 | 1/1 | 0/1 | 24 | 374.82 | 374.82 | 0.018156 | 61,731 | 17,724 | 3,513 |

## Artifact Paths

- Committed traces/workspaces: `benchmarks/agent/traces/latest/`
- Raw run outputs (gitignored): `benchmarks/agent/results/`

