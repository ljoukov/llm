# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-13T15-11-45-630Z
- Generated at: 2026-02-13T15:30:13.089Z
- Models: chatgpt-gpt-5.3-codex, gpt-5.2, kimi-k2.5, glm-5, minimax-m2.1, gemini-2.5-pro, gemini-flash-latest, gemini-3-pro-preview, gemini-3-flash-preview
- Grader model: chatgpt-gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici, trappist1b-atmosphere, gcse-chemistry-8-9
- Runs per model/task: 1
- Cases: 27
- Overall success: 7/27
- Schema pass: 13/27
- Tool trace pass: 26/27
- Grader pass: 7/27
- Observed total latency: 5384.69s
- Observed avg latency/case: 199.43s
- Observed total cost: $2.093792
- Observed tokens (in/cached/out): 1,353,598/669,666/108,223
- Observed thinking tokens: 81,379
- Observed total tokens: 1,543,200

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)
- trappist1b-atmosphere: Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b (https://arxiv.org/abs/2409.13036)
- gcse-chemistry-8-9: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark) (https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.246870
- Estimated grader cost total: $0.378000
- Estimated grand total: $0.624870

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | 3/3 | 3/3 | 3/3 | 3/3 | 75.00 | 225.00 | 80 | 0.233405 | 64,304 | 4,608 | 10,051 |
| gpt-5.2 | 2/3 | 3/3 | 3/3 | 2/3 | 195.73 | 587.19 | 100 | 0.392447 | 169,041 | 122,624 | 12,114 |
| kimi-k2.5 | 0/3 | 0/3 | 3/3 | 0/3 | 40.90 | 122.70 | 88 | 0.120302 | 107,608 | 51,801 | 15,661 |
| glm-5 | 0/3 | 1/3 | 3/3 | 0/3 | 318.61 | 955.84 | 100 | 0.188809 | 172,953 | 91,409 | 16,150 |
| minimax-m2.1 | 0/3 | 0/3 | 3/3 | 0/3 | 50.62 | 151.85 | 82 | 0.098867 | 107,243 | 42,293 | 18,000 |
| gemini-2.5-pro | 0/3 | 1/3 | 3/3 | 0/3 | 227.36 | 682.08 | 80 | 0.416666 | 208,747 | 82,691 | 9,695 |
| gemini-flash-latest | 0/3 | 1/3 | 3/3 | 0/3 | 241.38 | 724.14 | 74 | 0.053902 | 187,940 | 125,531 | 11,010 |
| gemini-3-pro-preview | 2/3 | 3/3 | 3/3 | 2/3 | 276.20 | 828.60 | 76 | 0.548001 | 199,653 | 100,232 | 8,570 |
| gemini-3-flash-preview | 0/3 | 1/3 | 2/3 | 0/3 | 369.10 | 1107.29 | 62 | 0.041393 | 136,109 | 48,477 | 6,972 |

## Case Matrix

| Model | Task | Run | Reasoning | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 63.58 | 24 | 0.072906 | 22,370 | 0 | 3,586 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 1 | medium | PASS | pass | pass | pass | 65.43 | 24 | 0.070997 | 21,047 | 4,608 | 3,651 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 95.99 | 32 | 0.089502 | 20,887 | 0 | 2,814 |
| gpt-5.2 | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 87.22 | 26 | 0.104495 | 32,766 | 20,096 | 4,137 |
| gpt-5.2 | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 341.12 | 34 | 0.130011 | 71,519 | 51,328 | 4,480 |
| gpt-5.2 | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 158.84 | 40 | 0.157941 | 64,756 | 51,200 | 3,497 |
| kimi-k2.5 | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 37.32 | 24 | 0.032969 | 31,563 | 23,047 | 4,582 |
| kimi-k2.5 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 40.42 | 32 | 0.042939 | 42,526 | 17,589 | 4,995 |
| kimi-k2.5 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 44.96 | 32 | 0.044395 | 33,519 | 11,165 | 6,084 |
| glm-5 | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 412.64 | 32 | 0.062091 | 63,158 | 35,464 | 4,797 |
| glm-5 | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 364.84 | 34 | 0.063039 | 68,371 | 40,484 | 4,818 |
| glm-5 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 178.36 | 34 | 0.063679 | 41,424 | 15,461 | 6,535 |
| minimax-m2.1 | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 54.70 | 24 | 0.033716 | 31,460 | 12,008 | 5,552 |
| minimax-m2.1 | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 48.52 | 24 | 0.031306 | 31,376 | 8,827 | 6,262 |
| minimax-m2.1 | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 48.63 | 34 | 0.033845 | 44,407 | 21,458 | 6,186 |
| gemini-2.5-pro | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 125.32 | 24 | 0.138374 | 61,412 | 21,537 | 3,573 |
| gemini-2.5-pro | trappist1b-atmosphere | 1 | medium | FAIL | fail | pass | fail | 288.85 | 24 | 0.115695 | 59,364 | 16,982 | 3,155 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 267.91 | 32 | 0.162597 | 87,971 | 44,172 | 2,967 |
| gemini-flash-latest | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 90.34 | 22 | 0.019871 | 52,920 | 32,958 | 3,660 |
| gemini-flash-latest | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 506.30 | 22 | 0.018002 | 51,802 | 34,157 | 3,568 |
| gemini-flash-latest | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 127.50 | 30 | 0.016028 | 83,218 | 58,416 | 3,782 |
| gemini-3-pro-preview | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 303.48 | 22 | 0.153502 | 57,729 | 24,786 | 2,979 |
| gemini-3-pro-preview | trappist1b-atmosphere | 1 | medium | FAIL | pass | pass | fail | 280.07 | 22 | 0.172744 | 50,398 | 13,308 | 3,019 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 1 | medium | PASS | pass | pass | pass | 245.05 | 32 | 0.221756 | 91,526 | 62,138 | 2,572 |
| gemini-3-flash-preview | tumor-vaccine-ici | 1 | medium | FAIL | fail | pass | fail | 107.27 | 22 | 0.015172 | 52,213 | 19,981 | 3,207 |
| gemini-3-flash-preview | trappist1b-atmosphere | 1 | medium | FAIL | fail | fail | fail | 737.38 | 8 | 0.008578 | 1,622 | 0 | 377 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 262.64 | 32 | 0.017642 | 82,274 | 28,496 | 3,388 |

## Failures

- gpt-5.2 / trappist1b-atmosphere / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- kimi-k2.5 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- glm-5 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- glm-5 / trappist1b-atmosphere / run 1: grader_verdict=fail
- glm-5 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- minimax-m2.1 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / trappist1b-atmosphere / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / gcse-chemistry-8-9 / run 1: grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / trappist1b-atmosphere / run 1: grader_verdict=fail
- gemini-flash-latest / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-3-pro-preview / trappist1b-atmosphere / run 1: grader_verdict=fail
- gemini-3-flash-preview / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-3-flash-preview / trappist1b-atmosphere / run 1: agent_error=terminated | schema_or_grounding_failed | tool_trace=No successful write tool call observed (write_file/replace/apply_patch). | grader_verdict=fail
- gemini-3-flash-preview / gcse-chemistry-8-9 / run 1: grader_verdict=fail
