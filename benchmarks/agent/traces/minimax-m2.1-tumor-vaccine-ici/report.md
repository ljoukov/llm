# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-13T14-07-03-472Z
- Generated at: 2026-02-13T14:07:59.157Z
- Models: minimax-m2.1
- Grader model: chatgpt-gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici
- Runs per model/task: 1
- Cases: 1
- Overall success: 0/1
- Schema pass: 0/1
- Tool trace pass: 1/1
- Grader pass: 0/1
- Observed total latency: 55.66s
- Observed avg latency/case: 55.66s
- Observed total cost: $0.031907
- Observed tokens (in/cached/out): 30,964/13,084/5,379
- Observed thinking tokens: 350
- Observed total tokens: 36,693

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.002340
- Estimated grader cost total: $0.014000
- Estimated grand total: $0.016340

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| minimax-m2.1 | 0/1 | 0/1 | 1/1 | 0/1 | 55.66 | 55.66 | 24 | 0.031907 | 30,964 | 13,084 | 5,379 |

## Case Matrix

| Model | Task | Run | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|
| minimax-m2.1 | tumor-vaccine-ici | 1 | FAIL | fail | pass | fail | 55.66 | 24 | 0.031907 | 30,964 | 13,084 | 5,379 |

## Failures

- minimax-m2.1 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
