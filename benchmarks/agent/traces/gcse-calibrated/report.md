# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-12T17-03-12-735Z
- Generated at: 2026-02-12T17:08:01.127Z
- Models: chatgpt-gpt-5.3-codex, gemini-3-pro-preview, gemini-flash-latest
- Grader model: chatgpt-gpt-5.2
- Reasoning effort: medium
- Tasks: gcse-chemistry-8-9
- Runs per model/task: 1
- Cases: 3
- Overall success: 2/3
- Schema pass: 2/3
- Tool trace pass: 3/3
- Grader pass: 2/3
- Observed total latency: 450.11s
- Observed avg latency/case: 150.04s
- Observed total cost: $0.314930
- Observed tokens (in/cached/out): 157,906/77,418/8,922
- Observed thinking tokens: 16,695
- Observed total tokens: 183,523

## Source Papers

- gcse-chemistry-8-9: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark) (https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.033450
- Estimated grader cost total: $0.042000
- Estimated grand total: $0.075450

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | 1/1 | 1/1 | 1/1 | 1/1 | 95.96 | 95.96 | 34 | 0.095035 | 31,429 | 7,168 | 2,910 |
| gemini-3-pro-preview | 1/1 | 1/1 | 1/1 | 1/1 | 288.36 | 288.36 | 28 | 0.204489 | 82,590 | 47,630 | 2,753 |
| gemini-flash-latest | 0/1 | 0/1 | 1/1 | 0/1 | 65.79 | 65.79 | 22 | 0.015405 | 43,887 | 22,620 | 3,259 |

## Case Matrix

| Model | Task | Run | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 95.96 | 34 | 0.095035 | 31,429 | 7,168 | 2,910 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 288.36 | 28 | 0.204489 | 82,590 | 47,630 | 2,753 |
| gemini-flash-latest | gcse-chemistry-8-9 | 1 | FAIL | fail | pass | fail | 65.79 | 22 | 0.015405 | 43,887 | 22,620 | 3,259 |

## Failures

- gemini-flash-latest / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
