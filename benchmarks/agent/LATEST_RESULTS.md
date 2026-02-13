# Latest Agent Benchmark Results

This file is auto-generated from the latest benchmark run.

- Run id: `agent-fs-2026-02-13T17-38-16-588Z`
- Generated at: `2026-02-13T18:51:29.047Z`
- Tasks: `tumor-vaccine-ici`, `trappist1b-atmosphere`, `gcse-chemistry-8-9`
- Models: `chatgpt-gpt-5.3-codex-spark`, `gpt-5.2`, `kimi-k2.5`, `glm-5`, `minimax-m2.1`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-3-pro-preview`, `gemini-3-flash-preview`
- Grader: `chatgpt-gpt-5.2`

## Aggregate

- Cases: 0/81 pass (31/81 schema, 70/81 tool trace, 0/81 grader)
- Total latency: 12220.30s
- Avg latency per case: 150.87s
- Total cost: $3.949424
- Tokens (in/cached/out): 3,324,065/1,608,052/266,633
- Thinking tokens: 211,641
- Total tokens: 3,802,339

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex-spark` | FAIL | 0/9 | 0/9 | 0/9 | 0 | 0.73 | 6.61 | 0.000000 | 0 | 0 | 0 |
| `gpt-5.2` | FAIL | 8/9 | 8/9 | 0/9 | 243 | 113.01 | 1017.09 | 0.934545 | 307,789 | 229,888 | 30,316 |
| `kimi-k2.5` | FAIL | 2/9 | 9/9 | 0/9 | 226 | 29.44 | 264.98 | 0.205371 | 196,661 | 87,482 | 43,705 |
| `glm-5` | FAIL | 4/9 | 9/9 | 0/9 | 304 | 488.02 | 4392.19 | 0.433669 | 364,917 | 60,796 | 36,684 |
| `minimax-m2.1` | FAIL | 0/9 | 9/9 | 0/9 | 292 | 40.87 | 367.87 | 0.141659 | 390,648 | 248,452 | 51,444 |
| `gemini-2.5-pro` | FAIL | 1/9 | 8/9 | 0/9 | 210 | 146.16 | 1315.45 | 0.821967 | 447,959 | 208,348 | 23,252 |
| `gemini-flash-latest` | FAIL | 1/9 | 9/9 | 0/9 | 198 | 144.50 | 1300.54 | 0.000000 | 544,888 | 318,372 | 30,897 |
| `gemini-3-pro-preview` | FAIL | 7/9 | 9/9 | 0/9 | 228 | 214.40 | 1929.59 | 1.412212 | 514,663 | 237,312 | 23,942 |
| `gemini-3-flash-preview` | FAIL | 8/9 | 9/9 | 0/9 | 226 | 180.67 | 1626.00 | 0.000000 | 556,540 | 217,402 | 26,393 |

## Per-Task Across Runs (Best + Average)

| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex-spark` | `tumor-vaccine-ici` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0.83 | 0.74 | 0.000000 | 0.000000 | 0.00 | 0 |
| `chatgpt-gpt-5.3-codex-spark` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0.69 | 0.67 | 0.000000 | 0.000000 | 0.00 | 0 |
| `chatgpt-gpt-5.3-codex-spark` | `gcse-chemistry-8-9` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0.69 | 0.67 | 0.000000 | 0.000000 | 0.00 | 0 |
| `gpt-5.2` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 103.03 | 99.83 | 0.108176 | 0.112221 | 26.67 | 24 |
| `gpt-5.2` | `trappist1b-atmosphere` | 3 | FAIL (run 1) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 100.91 | 92.27 | 0.099191 | 0.089446 | 24.00 | 22 |
| `gpt-5.2` | `gcse-chemistry-8-9` | 3 | FAIL (run 3) | 0/3 (0.0%) | 2/3 (66.7%) | 2/3 (66.7%) | 0/3 (0.0%) | 135.09 | 164.78 | 0.104148 | 0.145080 | 30.33 | 32 |
| `kimi-k2.5` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 29.81 | 23.07 | 0.023388 | 0.019559 | 22.00 | 22 |
| `kimi-k2.5` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 26.97 | 30.50 | 0.019560 | 0.021299 | 22.67 | 24 |
| `kimi-k2.5` | `gcse-chemistry-8-9` | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 31.55 | 27.49 | 0.025509 | 0.027350 | 30.67 | 30 |
| `glm-5` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 473.60 | 370.39 | 0.077901 | 0.049313 | 34.67 | 30 |
| `glm-5` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 605.99 | 720.37 | 0.028003 | 0.000000 | 24.67 | 19 |
| `glm-5` | `gcse-chemistry-8-9` | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 384.48 | 174.83 | 0.038652 | 0.047551 | 42.00 | 48 |
| `minimax-m2.1` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 35.33 | 30.02 | 0.013599 | 0.010275 | 29.33 | 22 |
| `minimax-m2.1` | `trappist1b-atmosphere` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 52.76 | 41.65 | 0.018544 | 0.013931 | 32.00 | 26 |
| `minimax-m2.1` | `gcse-chemistry-8-9` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 34.53 | 30.55 | 0.015076 | 0.015019 | 36.00 | 44 |
| `gemini-2.5-pro` | `tumor-vaccine-ici` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 144.41 | 100.78 | 0.095809 | 0.087523 | 22.67 | 22 |
| `gemini-2.5-pro` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 138.25 | 72.58 | 0.090345 | 0.074598 | 23.33 | 22 |
| `gemini-2.5-pro` | `gcse-chemistry-8-9` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 2/3 (66.7%) | 0/3 (0.0%) | 155.81 | 186.84 | 0.087836 | 0.108467 | 24.00 | 30 |
| `gemini-flash-latest` | `tumor-vaccine-ici` | 3 | FAIL (run 2) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 120.12 | 169.01 | 0.000000 | 0.000000 | 21.33 | 22 |
| `gemini-flash-latest` | `trappist1b-atmosphere` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 152.41 | 132.13 | 0.000000 | 0.000000 | 21.33 | 20 |
| `gemini-flash-latest` | `gcse-chemistry-8-9` | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 160.98 | 137.28 | 0.000000 | 0.000000 | 23.33 | 20 |
| `gemini-3-pro-preview` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 234.75 | 247.58 | 0.154964 | 0.148137 | 22.00 | 22 |
| `gemini-3-pro-preview` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 238.27 | 203.61 | 0.152236 | 0.144586 | 23.33 | 22 |
| `gemini-3-pro-preview` | `gcse-chemistry-8-9` | 3 | FAIL (run 2) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 170.18 | 110.76 | 0.163538 | 0.180718 | 30.67 | 30 |
| `gemini-3-flash-preview` | `tumor-vaccine-ici` | 3 | FAIL (run 3) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 183.09 | 143.37 | 0.000000 | 0.000000 | 22.67 | 22 |
| `gemini-3-flash-preview` | `trappist1b-atmosphere` | 3 | FAIL (run 2) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 140.97 | 127.54 | 0.000000 | 0.000000 | 24.00 | 22 |
| `gemini-3-flash-preview` | `gcse-chemistry-8-9` | 3 | FAIL (run 3) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 217.93 | 121.59 | 0.000000 | 0.000000 | 28.67 | 30 |

## Artifact Paths

- Committed traces/workspaces: `benchmarks/agent/traces/latest/`
- Raw run outputs (gitignored): `benchmarks/agent/results/`

