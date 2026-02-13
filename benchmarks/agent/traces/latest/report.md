# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-13T17-38-16-588Z
- Generated at: 2026-02-13T18:51:29.047Z
- Models: chatgpt-gpt-5.3-codex-spark, gpt-5.2, kimi-k2.5, glm-5, minimax-m2.1, gemini-2.5-pro, gemini-flash-latest, gemini-3-pro-preview, gemini-3-flash-preview
- Grader model: chatgpt-gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici, trappist1b-atmosphere, gcse-chemistry-8-9
- Runs per model/task: 3
- Cases: 81
- Overall success: 0/81
- Schema pass: 31/81
- Tool trace pass: 70/81
- Grader pass: 0/81
- Observed total latency: 12220.30s
- Observed avg latency/case: 150.87s
- Observed total cost: $3.949424
- Observed tokens (in/cached/out): 3,324,065/1,608,052/266,633
- Observed thinking tokens: 211,641
- Observed total tokens: 3,802,339

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)
- trappist1b-atmosphere: Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b (https://arxiv.org/abs/2409.13036)
- gcse-chemistry-8-9: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark) (https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.638010
- Estimated grader cost total: $1.134000
- Estimated grand total: $1.772010

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex-spark | 0/9 | 0/9 | 0/9 | 0/9 | 0.73 | 6.61 | 0 | 0.000000 | 0 | 0 | 0 |
| gpt-5.2 | 0/9 | 8/9 | 8/9 | 0/9 | 113.01 | 1017.09 | 243 | 0.934545 | 307,789 | 229,888 | 30,316 |
| kimi-k2.5 | 0/9 | 2/9 | 9/9 | 0/9 | 29.44 | 264.98 | 226 | 0.205371 | 196,661 | 87,482 | 43,705 |
| glm-5 | 0/9 | 4/9 | 9/9 | 0/9 | 488.02 | 4392.19 | 304 | 0.433669 | 364,917 | 60,796 | 36,684 |
| minimax-m2.1 | 0/9 | 0/9 | 9/9 | 0/9 | 40.87 | 367.87 | 292 | 0.141659 | 390,648 | 248,452 | 51,444 |
| gemini-2.5-pro | 0/9 | 1/9 | 8/9 | 0/9 | 146.16 | 1315.45 | 210 | 0.821967 | 447,959 | 208,348 | 23,252 |
| gemini-flash-latest | 0/9 | 1/9 | 9/9 | 0/9 | 144.50 | 1300.54 | 198 | 0.000000 | 544,888 | 318,372 | 30,897 |
| gemini-3-pro-preview | 0/9 | 7/9 | 9/9 | 0/9 | 214.40 | 1929.59 | 228 | 1.412212 | 514,663 | 237,312 | 23,942 |
| gemini-3-flash-preview | 0/9 | 8/9 | 9/9 | 0/9 | 180.67 | 1626.00 | 226 | 0.000000 | 556,540 | 217,402 | 26,393 |

## Per-Task Across Runs (Best + Average)

| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0.83 | 0.74 | 0.000000 | 0.000000 | 0.00 | 0 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0.69 | 0.67 | 0.000000 | 0.000000 | 0.00 | 0 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0/3 (0.0%) | 0.69 | 0.67 | 0.000000 | 0.000000 | 0.00 | 0 |
| gpt-5.2 | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 103.03 | 99.83 | 0.108176 | 0.112221 | 26.67 | 24 |
| gpt-5.2 | trappist1b-atmosphere | 3 | FAIL (run 1) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 100.91 | 92.27 | 0.099191 | 0.089446 | 24.00 | 22 |
| gpt-5.2 | gcse-chemistry-8-9 | 3 | FAIL (run 3) | 0/3 (0.0%) | 2/3 (66.7%) | 2/3 (66.7%) | 0/3 (0.0%) | 135.09 | 164.78 | 0.104148 | 0.145080 | 30.33 | 32 |
| kimi-k2.5 | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 29.81 | 23.07 | 0.023388 | 0.019559 | 22.00 | 22 |
| kimi-k2.5 | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 26.97 | 30.50 | 0.019560 | 0.021299 | 22.67 | 24 |
| kimi-k2.5 | gcse-chemistry-8-9 | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 31.55 | 27.49 | 0.025509 | 0.027350 | 30.67 | 30 |
| glm-5 | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 473.60 | 370.39 | 0.077901 | 0.049313 | 34.67 | 30 |
| glm-5 | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 605.99 | 720.37 | 0.028003 | 0.000000 | 24.67 | 19 |
| glm-5 | gcse-chemistry-8-9 | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 384.48 | 174.83 | 0.038652 | 0.047551 | 42.00 | 48 |
| minimax-m2.1 | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 35.33 | 30.02 | 0.013599 | 0.010275 | 29.33 | 22 |
| minimax-m2.1 | trappist1b-atmosphere | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 52.76 | 41.65 | 0.018544 | 0.013931 | 32.00 | 26 |
| minimax-m2.1 | gcse-chemistry-8-9 | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 34.53 | 30.55 | 0.015076 | 0.015019 | 36.00 | 44 |
| gemini-2.5-pro | tumor-vaccine-ici | 3 | FAIL (run 3) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 144.41 | 100.78 | 0.095809 | 0.087523 | 22.67 | 22 |
| gemini-2.5-pro | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 138.25 | 72.58 | 0.090345 | 0.074598 | 23.33 | 22 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 2/3 (66.7%) | 0/3 (0.0%) | 155.81 | 186.84 | 0.087836 | 0.108467 | 24.00 | 30 |
| gemini-flash-latest | tumor-vaccine-ici | 3 | FAIL (run 2) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 120.12 | 169.01 | 0.000000 | 0.000000 | 21.33 | 22 |
| gemini-flash-latest | trappist1b-atmosphere | 3 | FAIL (run 2) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 152.41 | 132.13 | 0.000000 | 0.000000 | 21.33 | 20 |
| gemini-flash-latest | gcse-chemistry-8-9 | 3 | FAIL (run 1) | 0/3 (0.0%) | 0/3 (0.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 160.98 | 137.28 | 0.000000 | 0.000000 | 23.33 | 20 |
| gemini-3-pro-preview | tumor-vaccine-ici | 3 | FAIL (run 1) | 0/3 (0.0%) | 1/3 (33.3%) | 3/3 (100.0%) | 0/3 (0.0%) | 234.75 | 247.58 | 0.154964 | 0.148137 | 22.00 | 22 |
| gemini-3-pro-preview | trappist1b-atmosphere | 3 | FAIL (run 3) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 238.27 | 203.61 | 0.152236 | 0.144586 | 23.33 | 22 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 3 | FAIL (run 2) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 170.18 | 110.76 | 0.163538 | 0.180718 | 30.67 | 30 |
| gemini-3-flash-preview | tumor-vaccine-ici | 3 | FAIL (run 3) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 183.09 | 143.37 | 0.000000 | 0.000000 | 22.67 | 22 |
| gemini-3-flash-preview | trappist1b-atmosphere | 3 | FAIL (run 2) | 0/3 (0.0%) | 2/3 (66.7%) | 3/3 (100.0%) | 0/3 (0.0%) | 140.97 | 127.54 | 0.000000 | 0.000000 | 24.00 | 22 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 3 | FAIL (run 3) | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | 0/3 (0.0%) | 217.93 | 121.59 | 0.000000 | 0.000000 | 28.67 | 30 |

## Case Matrix

| Model | Task | Run | Reasoning | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 1 | medium | FAIL | fail | fail | fail | 0.89 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 2 | medium | FAIL | fail | fail | fail | 0.74 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | tumor-vaccine-ici | 3 | medium | FAIL | fail | fail | fail | 0.84 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 1 | medium | FAIL | fail | fail | fail | 0.69 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 2 | medium | FAIL | fail | fail | fail | 0.69 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | trappist1b-atmosphere | 3 | medium | FAIL | fail | fail | fail | 0.67 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | fail | fail | 0.72 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | fail | fail | 0.69 | 0 | 0.000000 | 0 | 0 | 0 |
| chatgpt-gpt-5.3-codex-spark | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | fail | fail | 0.67 | 0 | 0.000000 | 0 | 0 | 0 |
| gpt-5.2 | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 99.83 | 24 | 0.112221 | 24,968 | 7,424 | 4,045 |
| gpt-5.2 | tumor-vaccine-ici | 2 | medium | FAIL | pass | pass | fail | 104.33 | 32 | 0.110724 | 36,687 | 28,800 | 4,202 |
| gpt-5.2 | tumor-vaccine-ici | 3 | medium | FAIL | pass | pass | fail | 104.94 | 24 | 0.101582 | 19,791 | 12,800 | 3,832 |
| gpt-5.2 | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 92.27 | 22 | 0.089446 | 18,091 | 9,728 | 3,471 |
| gpt-5.2 | trappist1b-atmosphere | 2 | medium | FAIL | pass | pass | fail | 110.42 | 24 | 0.111280 | 26,750 | 17,024 | 4,026 |
| gpt-5.2 | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 100.02 | 26 | 0.096847 | 29,850 | 23,552 | 3,708 |
| gpt-5.2 | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 171.13 | 50 | 0.167365 | 116,055 | 103,424 | 3,790 |
| gpt-5.2 | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | fail | fail | 69.35 | 9 | 0.000000 | 0 | 0 | 0 |
| gpt-5.2 | gcse-chemistry-8-9 | 3 | medium | FAIL | pass | pass | fail | 164.78 | 32 | 0.145080 | 35,597 | 27,136 | 3,242 |
| kimi-k2.5 | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 23.07 | 22 | 0.019559 | 18,364 | 8,778 | 4,310 |
| kimi-k2.5 | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 37.27 | 24 | 0.030054 | 26,560 | 16,746 | 7,497 |
| kimi-k2.5 | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 29.10 | 20 | 0.020551 | 15,925 | 3,844 | 4,306 |
| kimi-k2.5 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 29.60 | 22 | 0.018554 | 17,541 | 8,181 | 4,040 |
| kimi-k2.5 | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 20.80 | 22 | 0.018826 | 17,653 | 7,909 | 4,063 |
| kimi-k2.5 | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 30.50 | 24 | 0.021299 | 26,727 | 16,294 | 4,470 |
| kimi-k2.5 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 27.49 | 30 | 0.027350 | 27,721 | 9,094 | 5,088 |
| kimi-k2.5 | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 29.84 | 30 | 0.025606 | 20,059 | 4,040 | 5,197 |
| kimi-k2.5 | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 37.31 | 32 | 0.023571 | 26,111 | 12,596 | 4,734 |
| glm-5 | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 370.39 | 30 | 0.049313 | 32,628 | 0 | 5,214 |
| glm-5 | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 359.42 | 30 | 0.048926 | 32,568 | 0 | 5,112 |
| glm-5 | tumor-vaccine-ici | 3 | medium | FAIL | pass | pass | fail | 690.99 | 44 | 0.135463 | 130,315 | 21,157 | 6,898 |
| glm-5 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 377.21 | 40 | 0.084010 | 65,934 | 10,145 | 8,185 |
| glm-5 | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 720.38 | 15 | 0.000000 | 0 | 0 | 0 |
| glm-5 | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 720.37 | 19 | 0.000000 | 0 | 0 | 0 |
| glm-5 | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 174.83 | 48 | 0.047551 | 54,464 | 27,829 | 4,797 |
| glm-5 | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 720.34 | 22 | 0.000000 | 0 | 0 | 0 |
| glm-5 | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 258.25 | 56 | 0.068406 | 49,008 | 1,665 | 6,478 |
| minimax-m2.1 | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 30.02 | 22 | 0.010275 | 20,652 | 9,863 | 4,632 |
| minimax-m2.1 | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 35.98 | 32 | 0.017078 | 55,454 | 40,052 | 5,375 |
| minimax-m2.1 | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 40.00 | 34 | 0.013444 | 34,741 | 21,703 | 5,231 |
| minimax-m2.1 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 70.12 | 46 | 0.021556 | 60,482 | 36,903 | 7,456 |
| minimax-m2.1 | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 41.65 | 26 | 0.013931 | 34,911 | 22,690 | 5,718 |
| minimax-m2.1 | trappist1b-atmosphere | 3 | medium | FAIL | fail | pass | fail | 46.52 | 24 | 0.020145 | 73,191 | 59,120 | 5,880 |
| minimax-m2.1 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 38.96 | 34 | 0.015237 | 40,034 | 22,411 | 5,490 |
| minimax-m2.1 | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 34.07 | 30 | 0.014973 | 33,962 | 13,605 | 5,688 |
| minimax-m2.1 | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 30.55 | 44 | 0.015019 | 37,221 | 22,105 | 5,974 |
| gemini-2.5-pro | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 154.44 | 22 | 0.101073 | 50,443 | 20,916 | 2,966 |
| gemini-2.5-pro | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 178.03 | 24 | 0.098829 | 45,781 | 17,011 | 3,123 |
| gemini-2.5-pro | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 100.78 | 22 | 0.087523 | 36,199 | 11,107 | 2,725 |
| gemini-2.5-pro | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 141.95 | 22 | 0.080578 | 48,904 | 20,455 | 2,869 |
| gemini-2.5-pro | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 200.23 | 26 | 0.115859 | 65,464 | 31,370 | 3,685 |
| gemini-2.5-pro | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 72.58 | 22 | 0.074598 | 19,998 | 5,564 | 2,810 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | fail | fail | 87.07 | 10 | 0.046272 | 10,340 | 2,767 | 60 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 186.84 | 30 | 0.108467 | 81,174 | 45,423 | 2,617 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 193.54 | 32 | 0.108768 | 89,656 | 53,735 | 2,397 |
| gemini-flash-latest | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 76.43 | 22 | 0.000000 | 52,206 | 37,745 | 3,274 |
| gemini-flash-latest | tumor-vaccine-ici | 2 | medium | FAIL | pass | pass | fail | 169.01 | 22 | 0.000000 | 49,689 | 35,085 | 2,877 |
| gemini-flash-latest | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 114.92 | 20 | 0.000000 | 48,934 | 37,251 | 3,446 |
| gemini-flash-latest | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 164.21 | 22 | 0.000000 | 53,298 | 31,557 | 4,099 |
| gemini-flash-latest | trappist1b-atmosphere | 2 | medium | FAIL | fail | pass | fail | 132.13 | 20 | 0.000000 | 48,303 | 36,846 | 3,293 |
| gemini-flash-latest | trappist1b-atmosphere | 3 | medium | FAIL | fail | pass | fail | 160.89 | 22 | 0.000000 | 49,577 | 32,266 | 3,021 |
| gemini-flash-latest | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 137.28 | 20 | 0.000000 | 85,354 | 21,214 | 4,271 |
| gemini-flash-latest | gcse-chemistry-8-9 | 2 | medium | FAIL | fail | pass | fail | 196.85 | 30 | 0.000000 | 123,380 | 61,379 | 3,410 |
| gemini-flash-latest | gcse-chemistry-8-9 | 3 | medium | FAIL | fail | pass | fail | 148.81 | 20 | 0.000000 | 34,147 | 25,029 | 3,206 |
| gemini-3-pro-preview | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 247.58 | 22 | 0.148137 | 49,778 | 15,864 | 2,774 |
| gemini-3-pro-preview | tumor-vaccine-ici | 2 | medium | FAIL | fail | pass | fail | 228.37 | 22 | 0.132050 | 50,219 | 20,611 | 2,876 |
| gemini-3-pro-preview | tumor-vaccine-ici | 3 | medium | FAIL | fail | pass | fail | 228.31 | 22 | 0.184704 | 48,540 | 16,600 | 2,707 |
| gemini-3-pro-preview | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 248.19 | 24 | 0.155743 | 54,945 | 32,073 | 2,709 |
| gemini-3-pro-preview | trappist1b-atmosphere | 2 | medium | FAIL | pass | pass | fail | 263.00 | 24 | 0.156378 | 54,398 | 27,192 | 2,502 |
| gemini-3-pro-preview | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 203.61 | 22 | 0.144586 | 49,015 | 15,202 | 2,677 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 158.88 | 32 | 0.180150 | 92,955 | 54,480 | 2,757 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 2 | medium | FAIL | pass | pass | fail | 110.76 | 30 | 0.180718 | 59,657 | 16,880 | 2,572 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 3 | medium | FAIL | pass | pass | fail | 240.90 | 30 | 0.129746 | 55,156 | 38,410 | 2,368 |
| gemini-3-flash-preview | tumor-vaccine-ici | 1 | medium | FAIL | pass | pass | fail | 150.82 | 24 | 0.000000 | 56,907 | 17,717 | 2,738 |
| gemini-3-flash-preview | tumor-vaccine-ici | 2 | medium | FAIL | pass | pass | fail | 255.08 | 22 | 0.000000 | 50,100 | 14,315 | 2,860 |
| gemini-3-flash-preview | tumor-vaccine-ici | 3 | medium | FAIL | pass | pass | fail | 143.37 | 22 | 0.000000 | 49,703 | 7,800 | 2,688 |
| gemini-3-flash-preview | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 120.68 | 22 | 0.000000 | 48,928 | 13,864 | 2,586 |
| gemini-3-flash-preview | trappist1b-atmosphere | 2 | medium | FAIL | pass | pass | fail | 127.54 | 22 | 0.000000 | 47,960 | 20,013 | 2,498 |
| gemini-3-flash-preview | trappist1b-atmosphere | 3 | medium | FAIL | pass | pass | fail | 174.70 | 28 | 0.000000 | 74,448 | 29,547 | 3,908 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 323.42 | 32 | 0.000000 | 92,525 | 47,678 | 2,929 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 2 | medium | FAIL | pass | pass | fail | 208.78 | 24 | 0.000000 | 52,920 | 23,506 | 3,474 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 3 | medium | FAIL | pass | pass | fail | 121.59 | 30 | 0.000000 | 83,049 | 42,962 | 2,712 |

## Failures

- chatgpt-gpt-5.3-codex-spark / tumor-vaccine-ici / run 1: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / tumor-vaccine-ici / run 2: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / tumor-vaccine-ici / run 3: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / trappist1b-atmosphere / run 1: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / trappist1b-atmosphere / run 2: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / trappist1b-atmosphere / run 3: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / gcse-chemistry-8-9 / run 1: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / gcse-chemistry-8-9 / run 2: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- chatgpt-gpt-5.3-codex-spark / gcse-chemistry-8-9 / run 3: agent_error=Failed to extract chatgpt_account_id from access token. | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / tumor-vaccine-ici / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / tumor-vaccine-ici / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / tumor-vaccine-ici / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / trappist1b-atmosphere / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / trappist1b-atmosphere / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / trappist1b-atmosphere / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / gcse-chemistry-8-9 / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / gcse-chemistry-8-9 / run 2: agent_error=terminated | schema_or_grounding_failed | tool_trace=No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- gpt-5.2 / gcse-chemistry-8-9 / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / tumor-vaccine-ici / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / trappist1b-atmosphere / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / tumor-vaccine-ici / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / tumor-vaccine-ici / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / trappist1b-atmosphere / run 2: agent_error=Request was aborted. | schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / trappist1b-atmosphere / run 3: agent_error=Request was aborted. | grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / gcse-chemistry-8-9 / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / gcse-chemistry-8-9 / run 2: agent_error=Request was aborted. | schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- glm-5 / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / trappist1b-atmosphere / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- minimax-m2.1 / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / trappist1b-atmosphere / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | tool_trace=No successful write tool call observed (write_file/replace/apply_patch). | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-2.5-pro / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / tumor-vaccine-ici / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / trappist1b-atmosphere / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / trappist1b-atmosphere / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / gcse-chemistry-8-9 / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-flash-latest / gcse-chemistry-8-9 / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / tumor-vaccine-ici / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / tumor-vaccine-ici / run 2: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / tumor-vaccine-ici / run 3: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / trappist1b-atmosphere / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / trappist1b-atmosphere / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / trappist1b-atmosphere / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / gcse-chemistry-8-9 / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / gcse-chemistry-8-9 / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-pro-preview / gcse-chemistry-8-9 / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / tumor-vaccine-ici / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / tumor-vaccine-ici / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / tumor-vaccine-ici / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / trappist1b-atmosphere / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / trappist1b-atmosphere / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / gcse-chemistry-8-9 / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / gcse-chemistry-8-9 / run 2: grader_error=LLM JSON call failed after 2 attempt(s)
- gemini-3-flash-preview / gcse-chemistry-8-9 / run 3: grader_error=LLM JSON call failed after 2 attempt(s)
