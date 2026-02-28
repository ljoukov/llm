# Lesson Generation Benchmark

Spark-style lesson creation benchmark focused on generation + verification loops with early subagent delegation.

## Scope

- Task: `subagent-generation-verification`
- Model default: `chatgpt-gpt-5.3-codex`
- Variant default: `subagents`
- Rubrics: schema validation + tool trace + 4-pass `chatgpt-gpt-5.2` grading
- Extra artifacts:
  - `artifacts/logs/llm-call-trace.json`
  - `artifacts/logs/stale-diagnostic.json`

## Run

```bash
npx tsx benchmarks/lesson-generation/run.ts \
  --tasks subagent-generation-verification \
  --models chatgpt-gpt-5.3-codex \
  --variants subagents \
  --runs 1
```

## Notes

- Uses Spark publication schemas from `benchmarks/lesson-generation/schemas/spark/`.
- Enforces early subagent delegation with evidence file:
  - `lesson/output/delegation_evidence.json`
