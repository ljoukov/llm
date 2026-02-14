# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-14T15-32-35-138Z
- Generated at: 2026-02-14T16:20:51.448Z
- Models: chatgpt-gpt-5.3-codex-spark, gpt-5.2, kimi-k2.5, glm-5, minimax-m2.1, gemini-2.5-pro, gemini-flash-latest, gemini-3-pro-preview, gemini-3-flash-preview, chatgpt-gpt-5.3-codex
- Grader model: gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici, trappist1b-atmosphere, gcse-chemistry-8-9
- Runs per model/task: 3
- Cases: 90
- Overall success: 29/90
- Schema pass: 52/90
- Tool trace pass: 90/90
- Grader pass: 30/90
- Observed total latency: 11607.67s
- Observed avg latency/case: 128.97s
- Observed total cost: $8.743710
- Observed tokens (in/cached/out): 6,702,731/3,832,093/417,081
- Observed thinking tokens: 422,014
- Observed total tokens: 7,541,826

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)
- trappist1b-atmosphere: Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b (https://arxiv.org/abs/2409.13036)
- gcse-chemistry-8-9: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark) (https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.766260
- Estimated grader cost total: $1.260000
- Estimated grand total: $2.026260

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex-spark | 2/9 | 6/9 | 9/9 | 2/9 | 55.79 | 502.12 | 460 | 0.524241 | 1,625,108 | 1,404,800 | 50,793 |
| gpt-5.2 | 6/9 | 7/9 | 9/9 | 6/9 | 152.04 | 1368.34 | 312 | 1.400333 | 480,902 | 294,400 | 36,951 |
| kimi-k2.5 | 0/9 | 0/9 | 9/9 | 0/9 | 42.55 | 382.93 | 258 | 0.368985 | 311,033 | 129,076 | 46,306 |
| glm-5 | 4/9 | 7/9 | 9/9 | 4/9 | 148.44 | 1335.94 | 380 | 1.106094 | 904,502 | 131,424 | 62,346 |
| minimax-m2.1 | 0/9 | 0/9 | 9/9 | 0/9 | 82.79 | 745.10 | 288 | 0.313905 | 482,287 | 361,916 | 59,010 |
| gemini-2.5-pro | 2/9 | 3/9 | 9/9 | 2/9 | 96.56 | 869.05 | 238 | 1.074547 | 534,068 | 197,304 | 27,448 |
| gemini-flash-latest | 1/9 | 3/9 | 9/9 | 1/9 | 80.85 | 727.62 | 194 | 0.166178 | 454,046 | 264,994 | 33,397 |
| gemini-3-pro-preview | 3/9 | 8/9 | 9/9 | 3/9 | 192.28 | 1730.54 | 256 | 1.681807 | 551,325 | 270,983 | 31,155 |
| gemini-3-flash-preview | 4/9 | 9/9 | 9/9 | 4/9 | 116.65 | 1049.85 | 232 | 0.159815 | 586,504 | 233,324 | 28,528 |
| chatgpt-gpt-5.3-codex | 7/9 | 9/9 | 9/9 | 8/9 | 321.80 | 2896.18 | 403 | 1.947805 | 772,956 | 543,872 | 41,147 |

## Per-Task Across Runs (Best + Average)

| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 3 | PASS (run 2) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 85.54 | 55.66 | 0.085095 | 0.062287 | 82.67 | 64 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 3 | FAIL (run 2) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 42.75 | 52.06 | 0.048243 | 0.057958 | 35.33 | 42 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 3 | PASS (run 1) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 39.09 | 43.32 | 0.041409 | 0.049301 | 35.33 | 36 |
| gpt-5.2 | tumor-vaccine-ici | 3 | PASS (run 2) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 129.69 | 109.16 | 0.156963 | 0.123976 | 32.67 | 34 |
| gpt-5.2 | trappist1b-atmosphere | 3 | PASS (run 3) | 2/3 (66.7%) | 2/3 (66.7%) | 3/3 (100.0%) | 2/3 (66.7%) | 128.63 | 130.04 | 0.135775 | 0.135960 | 34.00 | 32 |
| gpt-5.2 | gcse-chemistry-8-9 | 3 | PASS (run 1) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 197.79 | 199.29 | 0.174040 | 0.175918 | 37.33 | 32 |
| kimi-k2.5 | tumor-vaccine-ici | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 40.83 | 49.89 | 0.038440 | 0.041528 | 22.67 | 22 |
| kimi-k2.5 | trappist1b-atmosphere | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 42.26 | 36.15 | 0.041740 | 0.039418 | 26.00 | 24 |
| kimi-k2.5 | gcse-chemistry-8-9 | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 44.55 | 34.24 | 0.042815 | 0.033346 | 37.33 | 30 |
| glm-5 | tumor-vaccine-ici | 3 | PASS (run 1) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 134.34 | 209.64 | 0.150666 | 0.302268 | 35.33 | 60 |
| glm-5 | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 115.50 | 193.24 | 0.100599 | 0.173041 | 38.67 | 52 |
| glm-5 | gcse-chemistry-8-9 | 3 | PASS (run 2) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 195.47 | 88.01 | 0.117433 | 0.141561 | 52.67 | 54 |
| minimax-m2.1 | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 61.17 | 61.84 | 0.029666 | 0.030168 | 26.67 | 24 |
| minimax-m2.1 | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 96.93 | 81.55 | 0.036327 | 0.033879 | 31.33 | 28 |
| minimax-m2.1 | gcse-chemistry-8-9 | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 90.27 | 118.37 | 0.038642 | 0.047070 | 38.00 | 38 |
| gemini-2.5-pro | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 87.97 | 95.38 | 0.123706 | 0.128530 | 22.67 | 24 |
| gemini-2.5-pro | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 88.83 | 104.66 | 0.112035 | 0.128524 | 24.00 | 24 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 3 | PASS (run 1) | 2/3 (66.7%) | 2/3 (66.7%) | 3/3 (100.0%) | 2/3 (66.7%) | 112.89 | 125.96 | 0.122441 | 0.118445 | 32.67 | 34 |
| gemini-flash-latest | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 89.21 | 93.84 | 0.018192 | 0.021488 | 21.33 | 22 |
| gemini-flash-latest | trappist1b-atmosphere | 3 | PASS (run 3) | 1/3 (33.3%) | 2/3 (66.7%) | 3/3 (100.0%) | 1/3 (33.3%) | 70.33 | 65.93 | 0.018146 | 0.021817 | 21.33 | 22 |
| gemini-flash-latest | gcse-chemistry-8-9 | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 83.00 | 86.83 | 0.019055 | 0.014353 | 22.00 | 28 |
| gemini-3-pro-preview | tumor-vaccine-ici | 3 | PASS (run 1) | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | 1/3 (33.3%) | 173.14 | 202.17 | 0.171214 | 0.192556 | 22.67 | 22 |
| gemini-3-pro-preview | trappist1b-atmosphere | 3 | FAIL (run 1) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 134.96 | 116.66 | 0.156204 | 0.127303 | 23.33 | 22 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 3 | PASS (run 2) | 2/3 (66.7%) | 2/3 (66.7%) | 3/3 (100.0%) | 2/3 (66.7%) | 268.75 | 459.97 | 0.233184 | 0.216345 | 39.33 | 42 |
| gemini-3-flash-preview | tumor-vaccine-ici | 3 | PASS (run 3) | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | 1/3 (33.3%) | 125.04 | 120.50 | 0.017876 | 0.015297 | 24.67 | 26 |
| gemini-3-flash-preview | trappist1b-atmosphere | 3 | PASS (run 2) | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | 1/3 (33.3%) | 118.05 | 123.13 | 0.017123 | 0.012840 | 24.00 | 26 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 3 | PASS (run 1) | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | 2/3 (66.7%) | 106.86 | 97.51 | 0.018273 | 0.015997 | 28.67 | 30 |
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 3 | PASS (run 3) | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | 2/3 (66.7%) | 218.73 | 275.64 | 0.220825 | 0.256317 | 48.00 | 46 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 3 | PASS (run 3) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 122.25 | 87.51 | 0.123359 | 0.090014 | 30.00 | 24 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 3 | PASS (run 3) | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 624.41 | 512.46 | 0.305084 | 0.404958 | 56.33 | 60 |

## Case Matrix

| Model | Task | Run | Reasoning | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 123.16 | 112 | 0.117519 | 700,606 | 652,032 | 11,443 |
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 2 | medium | PASS | pass | pass | pass | 55.66 | 64 | 0.062287 | 215,472 | 180,480 | 8,590 |
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 77.80 | 72 | 0.075478 | 355,625 | 319,360 | 7,274 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 48.55 | 40 | 0.051094 | 123,840 | 102,656 | 5,463 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 2 | medium | FAIL | pass | pass | fail | 52.06 | 42 | 0.057958 | 117,926 | 95,360 | 5,374 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 3 | medium | FAIL | fail | pass | fail | 27.63 | 24 | 0.035675 | 24,957 | 10,240 | 3,798 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 43.32 | 36 | 0.049301 | 21,231 | 7,680 | 2,850 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 31.47 | 36 | 0.034468 | 27,237 | 12,800 | 3,329 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 3 | medium | FAIL | pass | pass | fail | 42.47 | 34 | 0.040459 | 38,214 | 24,192 | 2,672 |
| gpt-5.2 | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 105.95 | 24 | 0.121099 | 27,345 | 5,504 | 3,816 |
| gpt-5.2 | tumor-vaccine-ici | 2 | medium | PASS | pass | pass | pass | 109.16 | 34 | 0.123976 | 43,696 | 23,552 | 4,140 |
| gpt-5.2 | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 173.97 | 40 | 0.225813 | 107,473 | 57,472 | 5,293 |
| gpt-5.2 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 119.69 | 30 | 0.125209 | 39,119 | 21,248 | 4,264 |
| gpt-5.2 | trappist1b-atmosphere | 2 | medium | PASS | pass | pass | pass | 136.15 | 40 | 0.146157 | 69,696 | 48,384 | 4,136 |
| gpt-5.2 | trappist1b-atmosphere | 3 | medium | PASS | pass | pass | pass | 130.04 | 32 | 0.135960 | 41,909 | 26,624 | 4,086 |
| gpt-5.2 | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 199.29 | 32 | 0.175918 | 41,822 | 27,264 | 3,300 |
| gpt-5.2 | gcse-chemistry-8-9 | 2 | medium | PASS | pass | pass | pass | 196.47 | 36 | 0.174580 | 53,843 | 41,088 | 4,235 |
| gpt-5.2 | gcse-chemistry-8-9 | 3 | medium | PASS | pass | pass | pass | 197.62 | 44 | 0.171621 | 55,999 | 43,264 | 3,681 |
| kimi-k2.5 | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 31.82 | 22 | 0.034828 | 22,482 | 6,656 | 4,704 |
| kimi-k2.5 | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 40.80 | 24 | 0.038965 | 31,780 | 11,150 | 4,543 |
| kimi-k2.5 | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 49.89 | 22 | 0.041528 | 22,784 | 5,915 | 5,047 |
| kimi-k2.5 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 43.08 | 22 | 0.041929 | 22,046 | 3,444 | 5,657 |
| kimi-k2.5 | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 36.15 | 24 | 0.039418 | 29,721 | 8,701 | 4,076 |
| kimi-k2.5 | trappist1b-atmosphere | 3 | medium | FAIL | fail | pass | fail | 47.56 | 32 | 0.043873 | 40,073 | 15,805 | 5,014 |
| kimi-k2.5 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 62.83 | 52 | 0.057873 | 94,667 | 63,495 | 7,364 |
| kimi-k2.5 | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 34.24 | 30 | 0.033346 | 23,325 | 8,984 | 4,751 |
| kimi-k2.5 | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 36.57 | 30 | 0.037225 | 24,155 | 4,926 | 5,150 |
| glm-5 | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 209.64 | 60 | 0.302268 | 287,836 | 36,891 | 10,292 |
| glm-5 | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 77.42 | 22 | 0.067303 | 46,982 | 11,815 | 5,434 |
| glm-5 | tumor-vaccine-ici | 3 | medium | FAIL | pass | pass | fail | 115.96 | 24 | 0.082427 | 55,121 | 7,846 | 5,472 |
| glm-5 | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 89.07 | 40 | 0.076681 | 46,803 | 2,408 | 6,280 |
| glm-5 | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 64.20 | 24 | 0.052077 | 31,601 | 6,267 | 5,007 |
| glm-5 | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 193.24 | 52 | 0.173041 | 159,254 | 28,145 | 6,939 |
| glm-5 | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 323.88 | 44 | 0.074127 | 44,839 | 3,494 | 6,552 |
| glm-5 | gcse-chemistry-8-9 | 2 | medium | PASS | pass | pass | pass | 88.01 | 54 | 0.141561 | 115,865 | 6,470 | 6,365 |
| glm-5 | gcse-chemistry-8-9 | 3 | medium | PASS | pass | pass | pass | 174.54 | 60 | 0.136609 | 116,201 | 28,088 | 10,005 |
| minimax-m2.1 | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 61.84 | 24 | 0.030168 | 30,974 | 17,386 | 6,340 |
| minimax-m2.1 | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 47.53 | 24 | 0.027155 | 36,799 | 25,696 | 4,404 |
| minimax-m2.1 | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 74.13 | 32 | 0.031675 | 37,471 | 24,981 | 6,293 |
| minimax-m2.1 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 104.83 | 32 | 0.037579 | 60,445 | 47,408 | 6,758 |
| minimax-m2.1 | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 104.41 | 34 | 0.037523 | 46,863 | 33,889 | 7,732 |
| minimax-m2.1 | trappist1b-atmosphere | 3 | medium | FAIL | fail | pass | fail | 81.55 | 28 | 0.033879 | 56,856 | 44,298 | 6,138 |
| minimax-m2.1 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 62.29 | 32 | 0.033886 | 41,613 | 25,501 | 6,851 |
| minimax-m2.1 | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 118.37 | 38 | 0.047070 | 129,785 | 114,745 | 7,658 |
| minimax-m2.1 | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 90.15 | 44 | 0.034970 | 41,481 | 28,012 | 6,836 |
| gemini-2.5-pro | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 95.38 | 24 | 0.128530 | 61,703 | 14,440 | 3,286 |
| gemini-2.5-pro | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 77.47 | 22 | 0.110972 | 40,592 | 12,134 | 3,314 |
| gemini-2.5-pro | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 91.05 | 22 | 0.131616 | 40,956 | 0 | 3,483 |
| gemini-2.5-pro | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 89.46 | 24 | 0.119207 | 62,173 | 22,869 | 3,187 |
| gemini-2.5-pro | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 72.37 | 24 | 0.088375 | 53,045 | 23,769 | 3,123 |
| gemini-2.5-pro | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 104.66 | 24 | 0.128524 | 61,661 | 27,328 | 3,436 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 125.96 | 34 | 0.118445 | 76,187 | 42,307 | 2,080 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 2 | medium | PASS | pass | pass | pass | 112.01 | 32 | 0.111709 | 42,472 | 11,822 | 2,356 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 100.69 | 32 | 0.137169 | 95,279 | 42,635 | 3,183 |
| gemini-flash-latest | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 93.84 | 22 | 0.021488 | 54,785 | 34,798 | 3,638 |
| gemini-flash-latest | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 68.82 | 22 | 0.017395 | 55,153 | 33,591 | 3,722 |
| gemini-flash-latest | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 104.95 | 20 | 0.015692 | 53,298 | 37,175 | 3,468 |
| gemini-flash-latest | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 69.24 | 22 | 0.016002 | 20,411 | 3,885 | 3,932 |
| gemini-flash-latest | trappist1b-atmosphere | 2 | medium | FAIL | pass | pass | fail | 75.83 | 20 | 0.016618 | 52,454 | 29,220 | 3,557 |
| gemini-flash-latest | trappist1b-atmosphere | 3 | medium | PASS | pass | pass | pass | 65.93 | 22 | 0.021817 | 54,046 | 17,770 | 3,723 |
| gemini-flash-latest | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 71.77 | 20 | 0.021198 | 38,807 | 24,980 | 3,732 |
| gemini-flash-latest | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 90.39 | 18 | 0.021614 | 37,647 | 23,147 | 3,886 |
| gemini-flash-latest | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 86.83 | 28 | 0.014353 | 87,445 | 60,428 | 3,739 |
| gemini-3-pro-preview | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 202.17 | 22 | 0.192556 | 55,117 | 21,006 | 3,184 |
| gemini-3-pro-preview | tumor-vaccine-ici | 2 | medium | FAIL | pass | pass | fail | 138.20 | 22 | 0.142690 | 40,911 | 12,983 | 3,207 |
| gemini-3-pro-preview | tumor-vaccine-ici | 3 | medium | FAIL | pass | pass | fail | 179.04 | 24 | 0.178396 | 54,186 | 22,070 | 3,348 |
| gemini-3-pro-preview | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 116.66 | 22 | 0.127303 | 37,988 | 18,227 | 2,836 |
| gemini-3-pro-preview | trappist1b-atmosphere | 2 | medium | FAIL | pass | pass | fail | 171.10 | 24 | 0.196282 | 57,946 | 27,384 | 2,973 |
| gemini-3-pro-preview | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 117.12 | 24 | 0.145027 | 50,441 | 29,892 | 3,200 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 153.99 | 46 | 0.240613 | 100,949 | 57,494 | 4,752 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 2 | medium | PASS | pass | pass | pass | 459.97 | 42 | 0.216345 | 67,565 | 37,076 | 4,640 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 3 | medium | PASS | pass | pass | pass | 192.29 | 30 | 0.242594 | 86,222 | 44,851 | 3,015 |
| gemini-3-flash-preview | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 112.16 | 24 | 0.017937 | 62,670 | 15,626 | 3,328 |
| gemini-3-flash-preview | tumor-vaccine-ici | 2 | medium | FAIL | pass | pass | fail | 142.47 | 24 | 0.020394 | 62,592 | 26,608 | 3,281 |
| gemini-3-flash-preview | tumor-vaccine-ici | 3 | medium | PASS | pass | pass | pass | 120.50 | 26 | 0.015297 | 56,069 | 19,153 | 3,165 |
| gemini-3-flash-preview | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 122.08 | 24 | 0.017981 | 60,841 | 25,723 | 3,273 |
| gemini-3-flash-preview | trappist1b-atmosphere | 2 | medium | PASS | pass | pass | pass | 123.13 | 26 | 0.012840 | 62,629 | 23,836 | 3,112 |
| gemini-3-flash-preview | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 108.95 | 22 | 0.020547 | 53,201 | 13,995 | 3,300 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 97.51 | 30 | 0.015997 | 88,390 | 41,981 | 3,418 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 2 | medium | FAIL | pass | pass | fail | 94.03 | 26 | 0.017468 | 52,648 | 23,701 | 2,388 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 3 | medium | PASS | pass | pass | pass | 129.03 | 30 | 0.021353 | 87,464 | 42,701 | 3,263 |
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 232.11 | 54 | 0.239481 | 146,824 | 100,864 | 5,546 |
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 2 | medium | FAIL | pass | pass | fail | 148.46 | 44 | 0.166678 | 66,323 | 31,616 | 5,061 |
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 3 | medium | PASS | pass | pass | pass | 275.64 | 46 | 0.256317 | 138,529 | 109,696 | 6,793 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 1 | medium | PASS | pass | pass | pass | 173.25 | 42 | 0.176031 | 116,367 | 89,344 | 5,019 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 2 | medium | PASS | pass | pass | pass | 106.00 | 24 | 0.104030 | 30,241 | 14,848 | 3,808 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 3 | medium | PASS | pass | pass | pass | 87.51 | 24 | 0.090014 | 22,392 | 6,528 | 3,726 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | pass | 732.97 | 33 | 0.014963 | 3,566 | 0 | 263 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 2 | medium | PASS | pass | pass | pass | 627.79 | 76 | 0.495332 | 168,002 | 138,368 | 6,204 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 3 | medium | PASS | pass | pass | pass | 512.46 | 60 | 0.404958 | 80,712 | 52,608 | 4,727 |

## Failures

- chatgpt-gpt-5.3-codex-spark / tumor-vaccine-ici / run 1: grader_verdict=fail
- chatgpt-gpt-5.3-codex-spark / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_verdict=fail
- chatgpt-gpt-5.3-codex-spark / trappist1b-atmosphere / run 1: grader_verdict=fail
- chatgpt-gpt-5.3-codex-spark / trappist1b-atmosphere / run 2: grader_verdict=fail
- chatgpt-gpt-5.3-codex-spark / trappist1b-atmosphere / run 3: schema_or_grounding_failed | grader_verdict=fail
- chatgpt-gpt-5.3-codex-spark / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_verdict=fail
- chatgpt-gpt-5.3-codex-spark / gcse-chemistry-8-9 / run 3: grader_verdict=fail
- gpt-5.2 / tumor-vaccine-ici / run 1: grader_verdict=fail
- gpt-5.2 / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_verdict=fail
- gpt-5.2 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / trappist1b-atmosphere / run 3: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_verdict=fail
- glm-5 / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_verdict=fail
- glm-5 / tumor-vaccine-ici / run 3: grader_verdict=fail
- glm-5 / trappist1b-atmosphere / run 1: grader_verdict=fail
- glm-5 / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_verdict=fail
- glm-5 / trappist1b-atmosphere / run 3: grader_verdict=fail
- minimax-m2.1 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / trappist1b-atmosphere / run 3: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / trappist1b-atmosphere / run 3: grader_verdict=fail
- gemini-2.5-pro / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 1: grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / trappist1b-atmosphere / run 2: grader_verdict=fail
- gemini-flash-latest / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_verdict=fail
- gemini-3-pro-preview / tumor-vaccine-ici / run 2: grader_verdict=fail
- gemini-3-pro-preview / tumor-vaccine-ici / run 3: grader_verdict=fail
- gemini-3-pro-preview / trappist1b-atmosphere / run 1: grader_verdict=fail
- gemini-3-pro-preview / trappist1b-atmosphere / run 2: grader_verdict=fail
- gemini-3-pro-preview / trappist1b-atmosphere / run 3: grader_verdict=fail
- gemini-3-pro-preview / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-3-flash-preview / tumor-vaccine-ici / run 1: grader_verdict=fail
- gemini-3-flash-preview / tumor-vaccine-ici / run 2: grader_verdict=fail
- gemini-3-flash-preview / trappist1b-atmosphere / run 1: grader_verdict=fail
- gemini-3-flash-preview / trappist1b-atmosphere / run 3: grader_verdict=fail
- gemini-3-flash-preview / gcse-chemistry-8-9 / run 2: grader_verdict=fail
- chatgpt-gpt-5.3-codex / tumor-vaccine-ici / run 2: grader_verdict=fail
- chatgpt-gpt-5.3-codex / gcse-chemistry-8-9 / run 1: agent_error=Agent timeout exceeded.
