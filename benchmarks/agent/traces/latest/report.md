# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-12T13-24-32-749Z
- Generated at: 2026-02-12T13:38:15.620Z
- Models: chatgpt-gpt-5.3-codex, gemini-2.5-pro, gemini-flash-latest, gemini-3-pro-preview, gemini-3-flash-preview
- Grader model: gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici
- Runs per model/task: 1
- Cases: 5
- Overall success: 1/5
- Schema pass: 4/5
- Tool trace pass: 5/5
- Grader pass: 1/5
- Observed total cost: $0.416250

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.047700
- Estimated grader cost total: $0.070000
- Estimated grand total: $0.117700

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total cost (USD) |
|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | 1/1 | 1/1 | 1/1 | 1/1 | 62.94 | 0.078646 |
| gemini-2.5-pro | 0/1 | 0/1 | 1/1 | 0/1 | 300.38 | 0.124462 |
| gemini-flash-latest | 0/1 | 1/1 | 1/1 | 0/1 | 136.53 | 0.020564 |
| gemini-3-pro-preview | 0/1 | 1/1 | 1/1 | 0/1 | 217.99 | 0.174573 |
| gemini-3-flash-preview | 0/1 | 1/1 | 1/1 | 0/1 | 104.97 | 0.018006 |

## Case Matrix

| Model | Task | Run | Status | Schema | Tool trace | Grader | Tool calls | Cost (USD) |
|---|---|---:|---|---|---|---|---:|---:|
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | PASS | pass | pass | pass | 26 | 0.078646 |
| gemini-2.5-pro | tumor-vaccine-ici | 1 | FAIL | fail | pass | fail | 22 | 0.124462 |
| gemini-flash-latest | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 20 | 0.020564 |
| gemini-3-pro-preview | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 22 | 0.174573 |
| gemini-3-flash-preview | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 22 | 0.018006 |

## Failures

- gemini-2.5-pro / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 1: grader_verdict=fail
- gemini-3-pro-preview / tumor-vaccine-ici / run 1: grader_verdict=fail
- gemini-3-flash-preview / tumor-vaccine-ici / run 1: grader_verdict=fail
