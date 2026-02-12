# Filesystem Agent Benchmark Report

- Run id: agent-fs-2026-02-12T17-08-10-524Z
- Generated at: 2026-02-12T17:23:15.828Z
- Models: chatgpt-gpt-5.3-codex, gpt-5.2, kimi-k2.5, glm-5, gemini-2.5-pro, gemini-flash-latest, gemini-3-pro-preview, gemini-3-flash-preview
- Grader model: chatgpt-gpt-5.2
- Reasoning effort: medium
- Tasks: tumor-vaccine-ici, gcse-chemistry-8-9
- Runs per model/task: 1
- Cases: 16
- Overall success: 9/16
- Schema pass: 10/16
- Tool trace pass: 14/16
- Grader pass: 9/16
- Observed total latency: 3022.59s
- Observed avg latency/case: 188.91s
- Observed total cost: $1.429731
- Observed tokens (in/cached/out): 756,249/402,729/58,963
- Observed thinking tokens: 57,710
- Observed total tokens: 872,922

## Source Papers

- tumor-vaccine-ici: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade (https://www.nature.com/articles/s41586-025-09006-8)
- gcse-chemistry-8-9: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark) (https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance)

## Cost Projection Inputs

- Agent prompt tokens per call: 4200
- Agent response tokens per call: 900
- Grader prompt tokens per call: 5200
- Grader response tokens per call: 350
- Estimated agent cost total: $0.159900
- Estimated grader cost total: $0.224000
- Estimated grand total: $0.383900

## Per-Model Summary

| Model | Success | Schema pass | Tool pass | Grader pass | Avg latency (s) | Total latency (s) | Tool calls | Total cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | 2/2 | 2/2 | 2/2 | 2/2 | 100.59 | 201.19 | 56 | 0.172799 | 50,626 | 19,456 | 6,653 |
| gpt-5.2 | 1/2 | 2/2 | 2/2 | 1/2 | 267.14 | 534.29 | 74 | 0.324877 | 115,484 | 65,920 | 7,379 |
| kimi-k2.5 | 1/2 | 1/2 | 2/2 | 1/2 | 50.19 | 100.38 | 62 | 0.079534 | 68,589 | 34,319 | 10,121 |
| glm-5 | 2/2 | 2/2 | 2/2 | 2/2 | 83.16 | 166.32 | 80 | 0.138937 | 103,029 | 37,648 | 13,835 |
| gemini-2.5-pro | 1/2 | 1/2 | 2/2 | 1/2 | 211.97 | 423.93 | 54 | 0.265816 | 142,823 | 77,942 | 6,648 |
| gemini-flash-latest | 0/2 | 0/2 | 2/2 | 0/2 | 162.08 | 324.15 | 50 | 0.032884 | 134,784 | 82,490 | 7,671 |
| gemini-3-pro-preview | 2/2 | 2/2 | 2/2 | 2/2 | 452.60 | 905.19 | 54 | 0.396626 | 137,241 | 84,954 | 5,876 |
| gemini-3-flash-preview | 0/2 | 0/2 | 0/2 | 0/2 | 183.57 | 367.13 | 4 | 0.018258 | 3,673 | 0 | 780 |

## Case Matrix

| Model | Task | Run | Status | Schema | Tool trace | Grader | Latency (s) | Tool calls | Cost (USD) | In tokens | Cached tokens | Out tokens |
|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|
| chatgpt-gpt-5.3-codex | tumor-vaccine-ici | 1 | PASS | pass | pass | pass | 65.98 | 24 | 0.068199 | 20,234 | 4,608 | 3,598 |
| chatgpt-gpt-5.3-codex | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 135.21 | 32 | 0.104600 | 30,392 | 14,848 | 3,055 |
| gpt-5.2 | tumor-vaccine-ici | 1 | FAIL | pass | pass | fail | 352.69 | 26 | 0.125282 | 40,420 | 19,456 | 4,007 |
| gpt-5.2 | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 181.59 | 48 | 0.199595 | 75,064 | 46,464 | 3,372 |
| kimi-k2.5 | tumor-vaccine-ici | 1 | PASS | pass | pass | pass | 45.65 | 30 | 0.041520 | 35,603 | 16,896 | 4,948 |
| kimi-k2.5 | gcse-chemistry-8-9 | 1 | FAIL | fail | pass | fail | 54.72 | 32 | 0.038014 | 32,986 | 17,423 | 5,173 |
| glm-5 | tumor-vaccine-ici | 1 | PASS | pass | pass | pass | 71.66 | 24 | 0.068198 | 51,480 | 15,312 | 5,039 |
| glm-5 | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 94.66 | 56 | 0.070739 | 51,549 | 22,336 | 8,796 |
| gemini-2.5-pro | tumor-vaccine-ici | 1 | FAIL | fail | pass | fail | 140.72 | 22 | 0.123293 | 52,800 | 18,353 | 3,577 |
| gemini-2.5-pro | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 283.21 | 32 | 0.142523 | 90,023 | 59,589 | 3,071 |
| gemini-flash-latest | tumor-vaccine-ici | 1 | FAIL | fail | pass | fail | 134.55 | 22 | 0.019630 | 53,763 | 27,971 | 4,059 |
| gemini-flash-latest | gcse-chemistry-8-9 | 1 | FAIL | fail | pass | fail | 189.61 | 28 | 0.013254 | 81,021 | 54,519 | 3,612 |
| gemini-3-pro-preview | tumor-vaccine-ici | 1 | PASS | pass | pass | pass | 391.66 | 24 | 0.164432 | 57,880 | 34,535 | 2,872 |
| gemini-3-pro-preview | gcse-chemistry-8-9 | 1 | PASS | pass | pass | pass | 513.53 | 30 | 0.232194 | 79,361 | 50,419 | 3,004 |
| gemini-3-flash-preview | tumor-vaccine-ici | 1 | FAIL | fail | fail | fail | 346.53 | 4 | 0.010209 | 1,690 | 0 | 480 |
| gemini-3-flash-preview | gcse-chemistry-8-9 | 1 | FAIL | fail | fail | fail | 20.61 | 0 | 0.008048 | 1,983 | 0 | 300 |

## Failures

- gpt-5.2 / tumor-vaccine-ici / run 1: grader_error=LLM JSON call failed after 2 attempt(s)
- kimi-k2.5 / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-2.5-pro / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / tumor-vaccine-ici / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-flash-latest / gcse-chemistry-8-9 / run 1: schema_or_grounding_failed | grader_verdict=fail
- gemini-3-flash-preview / tumor-vaccine-ici / run 1: agent_error={"error":{"message":"{\n  \"error\": {\n    \"code\": 429,\n    \"message\": \"Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.\",\n    \"status\": \"RESOURCE_EXHAUSTED\"\n  }\n}\n","code":429,"status":"Too Many Requests"}} | schema_or_grounding_failed | tool_trace=No successful write tool call observed (write_file/replace/apply_patch). | grader_verdict=fail
- gemini-3-flash-preview / gcse-chemistry-8-9 / run 1: agent_error={"error":{"message":"{\n  \"error\": {\n    \"code\": 429,\n    \"message\": \"Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.\",\n    \"status\": \"RESOURCE_EXHAUSTED\"\n  }\n}\n","code":429,"status":"Too Many Requests"}} | schema_or_grounding_failed | tool_trace=Expected at least 3 tool calls, observed 0.; No successful read/list/search tool call observed.; No successful write tool call observed (write_file/replace/apply_patch). | grader_verdict=fail
