# Latest Agent Benchmark Results

This file is auto-generated from the latest benchmark run.

- Run id: `agent-fs-2026-02-14T15-32-35-138Z`
- Generated at: `2026-02-14T16:20:51.448Z`
- Tasks: `tumor-vaccine-ici`, `trappist1b-atmosphere`, `gcse-chemistry-8-9`
- Models: `chatgpt-gpt-5.3-codex-spark`, `gpt-5.2`, `kimi-k2.5`, `glm-5`, `minimax-m2.1`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-3-pro-preview`, `gemini-3-flash-preview`, `chatgpt-gpt-5.3-codex`
- Grader: `gpt-5.2`

## Aggregate

- Cases: 29/90 pass (52/90 schema, 90/90 tool trace, 30/90 grader)
- Total latency: 11607.67s
- Avg latency per case: 128.97s
- Total cost: $8.743710
- Tokens (in/cached/out): 6,702,731/3,832,093/417,081
- Thinking tokens: 422,014
- Total tokens: 7,541,826

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls | Avg latency (s) | Total latency (s) | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex-spark` | FAIL | 6/9 | 9/9 | 2/9 | 460 | 55.79 | 502.12 | 0.524241 | 1,625,108 | 1,404,800 | 50,793 |
| `gpt-5.2` | FAIL | 7/9 | 9/9 | 6/9 | 312 | 152.04 | 1368.34 | 1.400333 | 480,902 | 294,400 | 36,951 |
| `kimi-k2.5` | FAIL | 0/9 | 9/9 | 0/9 | 258 | 42.55 | 382.93 | 0.368985 | 311,033 | 129,076 | 46,306 |
| `glm-5` | FAIL | 7/9 | 9/9 | 4/9 | 380 | 148.44 | 1335.94 | 1.106094 | 904,502 | 131,424 | 62,346 |
| `minimax-m2.1` | FAIL | 0/9 | 9/9 | 0/9 | 288 | 82.79 | 745.10 | 0.313905 | 482,287 | 361,916 | 59,010 |
| `gemini-2.5-pro` | FAIL | 3/9 | 9/9 | 2/9 | 238 | 96.56 | 869.05 | 1.074547 | 534,068 | 197,304 | 27,448 |
| `gemini-flash-latest` | FAIL | 3/9 | 9/9 | 1/9 | 194 | 80.85 | 727.62 | 0.166178 | 454,046 | 264,994 | 33,397 |
| `gemini-3-pro-preview` | FAIL | 8/9 | 9/9 | 3/9 | 256 | 192.28 | 1730.54 | 1.681807 | 551,325 | 270,983 | 31,155 |
| `gemini-3-flash-preview` | FAIL | 9/9 | 9/9 | 4/9 | 232 | 116.65 | 1049.85 | 0.159815 | 586,504 | 233,324 | 28,528 |
| `chatgpt-gpt-5.3-codex` | FAIL | 9/9 | 9/9 | 8/9 | 403 | 321.80 | 2896.18 | 1.947805 | 772,956 | 543,872 | 41,147 |

## Per-Task Across Runs (Best + Average)

| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| `chatgpt-gpt-5.3-codex-spark` | `tumor-vaccine-ici` | 3 | PASS (run 2) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 85.54 | 55.66 | 0.085095 | 0.062287 | 82.67 | 64 |
| `chatgpt-gpt-5.3-codex-spark` | `trappist1b-atmosphere` | 3 | FAIL (run 2) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 42.75 | 52.06 | 0.048243 | 0.057958 | 35.33 | 42 |
| `chatgpt-gpt-5.3-codex-spark` | `gcse-chemistry-8-9` | 3 | PASS (run 1) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 39.09 | 43.32 | 0.041409 | 0.049301 | 35.33 | 36 |
| `gpt-5.2` | `tumor-vaccine-ici` | 3 | PASS (run 2) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 129.69 | 109.16 | 0.156963 | 0.123976 | 32.67 | 34 |
| `gpt-5.2` | `trappist1b-atmosphere` | 3 | PASS (run 3) | 2/3 (66.7%) | 2/3 (66.7%) | 3/3 (100.0%) | 2/3 (66.7%) | 128.63 | 130.04 | 0.135775 | 0.135960 | 34.00 | 32 |
| `gpt-5.2` | `gcse-chemistry-8-9` | 3 | PASS (run 1) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 197.79 | 199.29 | 0.174040 | 0.175918 | 37.33 | 32 |
| `kimi-k2.5` | `tumor-vaccine-ici` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 40.83 | 49.89 | 0.038440 | 0.041528 | 22.67 | 22 |
| `kimi-k2.5` | `trappist1b-atmosphere` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 42.26 | 36.15 | 0.041740 | 0.039418 | 26.00 | 24 |
| `kimi-k2.5` | `gcse-chemistry-8-9` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 44.55 | 34.24 | 0.042815 | 0.033346 | 37.33 | 30 |
| `glm-5` | `tumor-vaccine-ici` | 3 | PASS (run 1) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 134.34 | 209.64 | 0.150666 | 0.302268 | 35.33 | 60 |
| `glm-5` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 115.50 | 193.24 | 0.100599 | 0.173041 | 38.67 | 52 |
| `glm-5` | `gcse-chemistry-8-9` | 3 | PASS (run 2) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 195.47 | 88.01 | 0.117433 | 0.141561 | 52.67 | 54 |
| `minimax-m2.1` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 61.17 | 61.84 | 0.029666 | 0.030168 | 26.67 | 24 |
| `minimax-m2.1` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 96.93 | 81.55 | 0.036327 | 0.033879 | 31.33 | 28 |
| `minimax-m2.1` | `gcse-chemistry-8-9` | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 90.27 | 118.37 | 0.038642 | 0.047070 | 38.00 | 38 |
| `gemini-2.5-pro` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 87.97 | 95.38 | 0.123706 | 0.128530 | 22.67 | 24 |
| `gemini-2.5-pro` | `trappist1b-atmosphere` | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 88.83 | 104.66 | 0.112035 | 0.128524 | 24.00 | 24 |
| `gemini-2.5-pro` | `gcse-chemistry-8-9` | 3 | PASS (run 1) | 2/3 (66.7%) | 2/3 (66.7%) | 3/3 (100.0%) | 2/3 (66.7%) | 112.89 | 125.96 | 0.122441 | 0.118445 | 32.67 | 34 |
| `gemini-flash-latest` | `tumor-vaccine-ici` | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 89.21 | 93.84 | 0.018192 | 0.021488 | 21.33 | 22 |
| `gemini-flash-latest` | `trappist1b-atmosphere` | 3 | PASS (run 3) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 70.33 | 65.93 | 0.018146 | 0.021817 | 21.33 | 22 |
| `gemini-flash-latest` | `gcse-chemistry-8-9` | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 83.00 | 86.83 | 0.019055 | 0.014353 | 22.00 | 28 |
| `gemini-3-pro-preview` | `tumor-vaccine-ici` | 3 | PASS (run 1) | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | 1/3 (33.3%) | 173.14 | 202.17 | 0.171214 | 0.192556 | 22.67 | 22 |
| `gemini-3-pro-preview` | `trappist1b-atmosphere` | 3 | FAIL (run 1) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 134.96 | 116.66 | 0.156204 | 0.127303 | 23.33 | 22 |
| `gemini-3-pro-preview` | `gcse-chemistry-8-9` | 3 | PASS (run 2) | 2/3 (66.7%) | 2/3 (66.7%) | 3/3 (100.0%) | 2/3 (66.7%) | 268.75 | 459.97 | 0.233184 | 0.216345 | 39.33 | 42 |
| `gemini-3-flash-preview` | `tumor-vaccine-ici` | 3 | PASS (run 3) | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | 1/3 (33.3%) | 125.04 | 120.50 | 0.017876 | 0.015297 | 24.67 | 26 |
| `gemini-3-flash-preview` | `trappist1b-atmosphere` | 3 | PASS (run 2) | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | 1/3 (33.3%) | 118.05 | 123.13 | 0.017123 | 0.012840 | 24.00 | 26 |
| `gemini-3-flash-preview` | `gcse-chemistry-8-9` | 3 | PASS (run 1) | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | 2/3 (66.7%) | 106.86 | 97.51 | 0.018273 | 0.015997 | 28.67 | 30 |
| `chatgpt-gpt-5.3-codex` | `tumor-vaccine-ici` | 3 | PASS (run 3) | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | 2/3 (66.7%) | 218.73 | 275.64 | 0.220825 | 0.256317 | 48.00 | 46 |
| `chatgpt-gpt-5.3-codex` | `trappist1b-atmosphere` | 3 | PASS (run 3) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 122.25 | 87.51 | 0.123359 | 0.090014 | 30.00 | 24 |
| `chatgpt-gpt-5.3-codex` | `gcse-chemistry-8-9` | 3 | PASS (run 3) | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 624.41 | 512.46 | 0.305084 | 0.404958 | 56.33 | 60 |

## Artifact Paths

- Committed traces/workspaces: `benchmarks/agent/traces/latest/`
- Raw run outputs (gitignored): `benchmarks/agent/results/`

