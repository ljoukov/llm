# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-12T14-34-19-197Z
- Generated at: 2026-02-12T14:42:10.925Z
- Models: chatgpt-gpt-5.3-codex, gpt-5.2, gemini-2.5-pro, gemini-flash-latest, gemini-3-pro-preview, gemini-3-flash-preview
- Grader model: gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici
- Runs per model/task: 1
- Cases: 6
- Overall success: 1/6
- Schema pass: 4/6
- Tool trace pass: 6/6
- Grader pass: 1/6
- Observed total latency: 1536.04s
- Observed avg latency/case: 256.01s
- Observed total cost: $0.571183
- Observed tokens (in/cached/out): 305,062/122,289/22,192
- Observed thinking tokens: 27,032
- Observed total tokens: 354,286

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.067650
- Estimated grader cost total: $0.084000
- Estimated grand total: $0.151650

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | 1/1 | 1/1 | 1/1 | 1/1 | 74.71 | 74.71 | 24 | 0.078713 | 21,422 | 0 | 3,695 |
| gpt-5.2 | 0/1 | 0/1 | 1/1 | 0/1 | 110.61 | 110.61 | 32 | 0.139197 | 39,559 | 15,744 | 4,761 |
| gemini-2.5-pro | 0/1 | 0/1 | 1/1 | 0/1 | 226.46 | 226.46 | 26 | 0.095224 | 60,336 | 28,341 | 3,364 |
| gemini-flash-latest | 0/1 | 1/1 | 1/1 | 0/1 | 277.75 | 277.75 | 20 | 0.022332 | 51,339 | 25,574 | 3,650 |
| gemini-3-pro-preview | 0/1 | 1/1 | 1/1 | 0/1 | 471.69 | 471.69 | 28 | 0.217559 | 70,675 | 34,906 | 3,209 |
| gemini-3-flash-preview | 0/1 | 1/1 | 1/1 | 0/1 | 374.82 | 374.82 | 24 | 0.018156 | 61,731 | 17,724 | 3,513 |

## Case Matrix

| Model | Task | Run | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | PASS | pass | pass | pass | 74.71 | 24 | 0.078713 | 21,422 | 0 | 3,695 |
| gpt-5.2 | tumor-vaccine-ici | 1 | FAIL | fail | pass | fail | 110.61 | 32 | 0.139197 | 39,559 | 15,744 | 4,761 |
| gemini-2.5-pro | tumor-vaccine-ici | 1 | FAIL | fail | pass | fail | 226.46 | 26 | 0.095224 | 60,336 | 28,341 | 3,364 |
| gemini-flash-latest | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 277.75 | 20 | 0.022332 | 51,339 | 25,574 | 3,650 |
| gemini-3-pro-preview | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 471.69 | 28 | 0.217559 | 70,675 | 34,906 | 3,209 |
| gemini-3-flash-preview | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 374.82 | 24 | 0.018156 | 61,731 | 17,724 | 3,513 |

## Failures

- gpt-5.2 / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 1: grader_verdict=fail
- gemini-3-pro-preview / tumor-vaccine-ici / run 1: grader_verdict=fail
- gemini-3-flash-preview / tumor-vaccine-ici / run 1: grader_verdict=fail
