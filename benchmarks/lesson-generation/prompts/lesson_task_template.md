# Agent Task

Task id: {{TASK_ID}}
Task title: {{TASK_TITLE}}
Reference source: {{SOURCE_TITLE}}
Reference URL: {{SOURCE_URL}}

## Objective
Create a publish-ready lesson package from `brief.md` and output valid JSON files that satisfy all schemas.

## Inputs On Disk
- Brief: `{{REPORT_PATH}}`
- Schemas: in `schemas/`

## Required Outputs
{{OUTPUT_SCHEMA_MAPPING_LIST}}

## Hard Requirements
- Identify parallelizable work up front, decompose into independent sub-tasks, and delegate via subagents early.
- Spawn subagents within the first 8 tool-loop steps.
- Required parallel workstreams:
  - Quiz track: `lesson/output/quiz/quiz-1.json`, `quiz-2.json`, `quiz-3.json`, `quiz-4.json`
  - Coding track: `lesson/output/code/problem-1.json`, `problem-2.json`, `problem-3.json`
- Record delegation evidence in `lesson/output/delegation_evidence.json`:
  - strategy
  - delegated_early=true
  - first_spawn_step
  - parallel_workstreams[] with subagent ids and owned outputs
  - merge_notes
- Follow plan preferences in the brief exactly.
- Produce 7 ordered plan items:
  1) quiz (`quiz-1`)
  2) coding_problem (`problem-1`)
  3) quiz (`quiz-2`)
  4) coding_problem (`problem-2`)
  5) quiz (`quiz-3`)
  6) coding_problem (`problem-3`)
  7) quiz (`quiz-4`)
- Each quiz must contain exactly 18 questions with this mix:
  - info-card: 4
  - multiple-choice: 10
  - type-answer: 4
- Keep Problem 3 as the final BIO Safe Haven problem.
- Keep official sample run visible in Problem 3 examples.
- Use marking cases as hidden tests in Problem 3 tests.
- Keep text concise: short question stems and compact feedback; avoid long narratives.
- Use relative paths only; never absolute paths or `..`.
- Write valid JSON only.

## Execution Plan (Required)
1. Read `TASK.md`, `brief.md`, and the three active schemas once.
2. Spawn subagents within the first 8 steps:
   - Subagent `quiz-track`: write all four quiz JSON files.
   - Subagent `code-track`: write all three coding-problem JSON files.
3. Wait for both subagents, close both, and integrate outputs.
4. Parent agent writes:
   - `lesson/output/session.json`
   - `lesson/output/delegation_evidence.json`
5. Do at most one verification/fix pass (no rewrite loops).

## Schema Cheat Sheet (use this to avoid repeated schema reads)
- `session.json`:
  - required: `title`, `summary`, `tagline`, `emoji`, `topics[]`, `plan[]`
  - `plan[]` items need: `id`, `title`, `kind`
- `quiz/*.json`:
  - required: `title`, `description`, `gradingPrompt`, `questions[]`
  - question kinds allowed: `info-card`, `multiple-choice`, `type-answer`
- `code/*.json`:
  - required: `title`, `topics[]`, `difficulty`, `description`, `inputFormat`, `constraints[]`, `examples[3]`, `tests[3..100]`, `hints[3]`, `solution.code`, `metadataVersion`
- `delegation_evidence.json`:
  - required: `strategy`, `delegated_early`, `first_spawn_step`, `parallel_workstreams[]`, `merge_notes`

## Completion
Respond with a checklist of written output files.
After the checklist, stop. Do not call more tools.
