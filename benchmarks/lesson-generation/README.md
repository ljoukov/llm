# Lesson Generation Benchmark

Spark-style lesson creation benchmark focused on generation + verification loops with early subagent delegation.

## Scope

- Task: `subagent-generation-verification`
- Model default: `openai:subscription:gpt-6-luna`
- Variant default: `subagents`
- Rubrics: schema validation + tool trace + 4-pass `openai:subscription:gpt-6-luna` grading
- Extra artifacts:
  - `artifacts/logs/llm-call-trace.json`
  - `artifacts/logs/stale-diagnostic.json`

Model arguments accept known native IDs or explicit `provider:access:model` selections, such as `vercel:api:reflection/beam-free`. Reports preserve the full selection. Unknown or unavailable costs are recorded as `null` and displayed as `unknown`; totals remain unknown whenever any included call has unknown cost. Projections use API-equivalent rates, including for subscription selections, and do not represent a subscription charge.

## Run

```bash
npx tsx benchmarks/lesson-generation/run.ts \
  --tasks subagent-generation-verification \
  --models openai:subscription:gpt-6-luna \
  --variants subagents \
  --runs 1
```

## Notes

- Uses Spark publication schemas from `benchmarks/lesson-generation/schemas/spark/`.
- Enforces early subagent delegation with evidence file:
  - `lesson/output/delegation_evidence.json`
