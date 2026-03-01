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
  - Quiz track (parallel draft stage): create quiz skeletons + first-pass drafts for `lesson/output/quiz/quiz-1.json`, `quiz-2.json`, `quiz-3.json`, `quiz-4.json`
  - Coding track (parallel draft stage): create coding blueprints + drafts for `lesson/output/code/problem-1.json`, `problem-2.json`, `problem-3.json`
- Dependency rule: final quiz content is downstream of coding drafts.
  - Coding problem concepts/requirements define prerequisite coverage targets for paired quizzes.
  - After both tracks finish, run a required alignment pass to update quizzes against coding prerequisites/tricky concepts.
- Record delegation evidence in `lesson/output/delegation_evidence.json`:
  - strategy
  - delegated_early=true
  - first_spawn_step
  - parallel_workstreams[] with subagent ids and owned outputs
  - alignment_pass with paired quiz/problem checks and updated quiz files
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
- Coding problem scope must remain on official Safe Haven progression (no unrelated warmups):
  - `problem-1` (required scope): setup-phase simulator only.
    - Input: `n r g`.
    - Output: final controlled-square counts after setup (`RedCount GreenCount`).
    - Use official setup rules: Red pre-claims `1`, Green starts alternating turns, count empty visits only, wrap at `n^2 -> 1`, start after most recently controlled square.
  - `problem-2` (required scope): static-board haven/safe-haven analysis prerequisite.
    - Input must include a grid state with empty squares allowed (`E` or `.`) plus `R/G`.
    - Haven definition must match official wording: maximal connected component of non-empty squares (regardless of colour).
    - Safe haven means that haven contains one colour only.
    - Do not redefine haven as a monochrome component.
  - `problem-3` (required scope): full official Safe Haven game simulation and final safe-haven counts.
- Coding test depth requirements:
  - `problem-1`: at least 6 tests, with at least 2 tests not duplicated from examples.
  - `problem-2`: at least 6 tests, with at least 2 tests not duplicated from examples.
  - `problem-3`: include full official hidden marking set (all 10 rows beyond sample) in `tests[]`.
- Every coding problem must include runnable Python3 `solution.code` (no placeholder stubs, TODO text, or pass-only bodies).
- `solution.code` must be consistent with the problem statement and listed examples/tests.
- Keep official sample run visible in Problem 3 examples.
- Use marking cases as hidden tests in Problem 3 tests.
- Problem 3 hidden tests must include all 10 official marking rows beyond the sample (no omissions).
- Do not leak official hidden marking rows into Problem 3 examples (only the official sample should use official marking inputs/outputs in `examples[]`).
- Do not leak official hidden marking rows into quiz content either (prompts/options/bodies/answers must not include exact hidden rows).
- In quizzes, discuss hidden tests only conceptually (policy/process), never by quoting concrete hidden-row numeric values.
- In quizzes, avoid concrete Safe Haven marking-row tuples entirely (do not write raw `n r g -> a b` or five-integer row forms).
- Do not use Darwinian terminology anywhere (forbidden terms include: `darwin`, `darwinian`, `evolution`, `mutation`, `survive/survival`, `birth`, `reproduction`, `colony`).
- Keep Problem 2 aligned to Safe Haven prerequisites; do not switch to unrelated cellular-automata or life-simulation themes.
- Required quiz->coding alignment acceptance checks (must pass before completion):
  - Pairing: `quiz-1 -> problem-1`, `quiz-2 -> problem-2`, `quiz-3 -> problem-3`, `quiz-4 -> problem-3` (review/cumulative prep).
  - Each paired quiz must explicitly signal the target coding problem in title, description, or grading prompt.
  - `quiz-1..quiz-3`: each must cover at least 2 paired-problem topics and at least 3 prerequisite/tricky concepts from that problem's title/description/inputFormat/constraints/hints.
  - `quiz-4`: must reinforce final-problem/cumulative prerequisites (at least 1 `problem-3` topic + at least 3 `problem-3` prerequisite/tricky concepts).
  - Each quiz must include at least one question directly testing a paired coding requirement/constraint/edge case.
- Problem 3 acceptance check:
  - examples include official sample `3 5 5 -> 2 1`;
  - tests include every official hidden marking case.
  - examples do not include any official hidden marking case beyond the sample.
- Problem 1 acceptance check:
  - include anchor case `2 7 23 -> 2 2` in examples or tests.
  - include anchor case `3 5 5 -> 5 4` in examples or tests.
- Problem 2 acceptance check:
  - at least one example includes empty squares in the grid input.
  - haven wording explicitly says non-empty connected components can be mixed-colour; safe haven is monochrome.
  - include anchor case `3` + grid rows `R.E`, `.RG`, `E.G` with output `1 0` in examples or tests.
  - include anchor case `4` + grid rows `R..G`, `.R.G`, `..G.`, `R...` with output `3 2` in examples or tests.
  - include anchor case `3` + grid rows `RRG`, `EGG`, `EER` with output `0 0` in examples or tests.
- Keep text concise: short question stems and compact feedback; avoid long narratives.
- Runtime target: complete within ~5 minutes by keeping only one alignment pass and one verification/fix pass.
- Use relative paths only; never absolute paths or `..`.
- Write valid JSON only.

## Execution Plan (Required)
1. Read `TASK.md`, `brief.md`, and the three active schemas once.
2. Spawn subagents within the first 8 steps:
   - Subagent `quiz-track`: write quiz skeletons + first-pass drafts for all four quizzes.
   - Subagent `code-track`: write coding blueprints + drafts for all three coding problems.
3. Wait for both subagents, close both, and integrate outputs.
4. Parent alignment pass (required, single pass):
   - derive prerequisite/tricky concepts from `problem-1..3`;
   - update `quiz-1..4` to satisfy the quiz->coding acceptance checks above.
   - confirm `problem-1` and `problem-2` still match the required canonical scopes (no drift to unrelated tasks).
5. Parent agent writes:
   - `lesson/output/session.json`
   - `lesson/output/delegation_evidence.json`
6. Do at most one verification/fix pass (no rewrite loops).
7. Before completion, do one final deterministic sanity check by re-reading code problems:
   - verify `problem-1` anchor outputs (`2 7 23 -> 2 2`, `3 5 5 -> 5 4`);
   - verify `problem-2` includes empties and official haven wording;
   - verify each `solution.code` is full runnable code, not a placeholder.

## Schema Cheat Sheet (use this to avoid repeated schema reads)
- `session.json`:
  - required: `title`, `summary`, `tagline`, `emoji`, `topics[]`, `plan[]`
  - `plan[]` items need: `id`, `title`, `kind`
- `quiz/*.json`:
  - required: `title`, `description`, `gradingPrompt`, `questions[]`
  - question kinds allowed: `info-card`, `multiple-choice`, `type-answer`
- `code/*.json`:
  - required: `title`, `topics[]`, `difficulty`, `description`, `inputFormat`, `constraints[]`, `examples[3]`, `tests[4..100]`, `hints[3]`, `solution.code`, `metadataVersion`
- `delegation_evidence.json`:
  - required: `strategy`, `delegated_early`, `first_spawn_step`, `parallel_workstreams[]`, `alignment_pass`, `merge_notes`

## Completion
Respond with a checklist of written output files.
After the checklist, stop. Do not call more tools.
