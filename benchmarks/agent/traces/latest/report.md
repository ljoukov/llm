# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-19T19-48-09-871Z
- Generated at: 2026-02-19T19:53:27.572Z
- Models: chatgpt-gpt-5.3-codex, gemini-3.1-pro-preview
- Grader model: chatgpt-gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici, trappist1b-atmosphere, gcse-chemistry-8-9
- Runs per model/task: 1
- Cases: 6
- Overall success: 4/6
- Schema pass: 5/6
- Tool trace pass: 6/6
- Grader pass: 4/6
- Observed total latency: 555.07s
- Observed avg latency/case: 92.51s
- Observed total cost: $0.728960
- Observed tokens (in/cached/out): 134,999/26,516/19,804
- Observed thinking tokens: 27,084
- Observed total tokens: 181,887

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)
- trappist1b-atmosphere: Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b (https://arxiv.org/abs/2409.13036)
- gcse-chemistry-8-9: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark) (https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.100350
- Estimated grader cost total: $0.084000
- Estimated grand total: $0.184350

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | 2/3 | 2/3 | 3/3 | 2/3 | 79.15 | 237.46 | 82 | 0.229203 | 66,687 | 14,848 | 10,527 |
| gemini-3.1-pro-preview | 2/3 | 3/3 | 3/3 | 2/3 | 105.87 | 317.61 | 70 | 0.499757 | 68,312 | 11,668 | 9,277 |

## Per-Task Across Runs (Best + Average)

| Model | Task | Runs | Best result | Overall pass rate | Schema pass rate | Tool pass rate | Grader pass rate | Avg latency (s) | Best latency (s) | Avg cost (USD) | Best cost (USD) | Avg tool calls | Best tool calls |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 72.60 | 72.60 | 0.073538 | 0.073538 | 22.00 | 22 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 62.81 | 62.81 | 0.069907 | 0.069907 | 24.00 | 24 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 1 | FAIL (run 1) | 0/1 (0.0%) | 0/1 (0.0%) | 1/1 (100.0%) | 0/1 (0.0%) | 102.06 | 102.06 | 0.085758 | 0.085758 | 36.00 | 36 |
| gemini-3.1-pro-preview | tumor-vaccine-ici | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 108.47 | 108.47 | 0.166688 | 0.166688 | 22.00 | 22 |
| gemini-3.1-pro-preview | trappist1b-atmosphere | 1 | PASS (run 1) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 86.90 | 86.90 | 0.153002 | 0.153002 | 20.00 | 20 |
| gemini-3.1-pro-preview | gcse-chemistry-8-9 | 1 | FAIL (run 1) | 0/1 (0.0%) | 1/1 (100.0%) | 1/1 (100.0%) | 0/1 (0.0%) | 122.24 | 122.24 | 0.180067 | 0.180067 | 28.00 | 28 |

## Case Matrix

| Model | Task | Run | Reasoning | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 72.60 | 22 | 0.073538 | 22,389 | 4,608 | 3,714 |
| chatgpt-gpt-5.3-codex | trappist1b-atmosphere | 1 | medium | PASS | pass | pass | pass | 62.81 | 24 | 0.069907 | 22,235 | 4,608 | 3,598 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 1 | medium | FAIL | fail | pass | fail | 102.06 | 36 | 0.085758 | 22,063 | 5,632 | 3,215 |
| gemini-3.1-pro-preview | tumor-vaccine-ici | 1 | medium | PASS | pass | pass | pass | 108.47 | 22 | 0.166688 | 21,535 | 8,152 | 3,013 |
| gemini-3.1-pro-preview | trappist1b-atmosphere | 1 | medium | PASS | pass | pass | pass | 86.90 | 20 | 0.153002 | 18,788 | 0 | 2,956 |
| gemini-3.1-pro-preview | gcse-chemistry-8-9 | 1 | medium | FAIL | pass | pass | fail | 122.24 | 28 | 0.180067 | 27,989 | 3,516 | 3,308 |

## Failures

- chatgpt-gpt-5.3-codex / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-3.1-pro-preview / gcse-chemistry-8-9 / run 1: grader_verdict=fail
