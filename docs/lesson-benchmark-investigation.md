# Lesson Benchmark Investigation (Checkpoint)

Date: 2026-02-28

## Scope
This checkpoint summarizes the current investigation status for:
- `benchmarks/lesson-generation`
- task: `subagent-generation-verification`
- model focus: `chatgpt-gpt-5.3-codex`
- variants: `baseline`, `subagents`

Goal remains unchanged: make codex pass cleanly without rubric/spec weakening, then run all models in parallel and report per-model metrics.

## Run History Snapshot (codex)

| Run ID | Variant | Success | Schema | Grader | Duration (s) | Cost (USD) | Subagent calls | Primary failure signal |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `agent-fs-2026-02-28T15-57-25-492Z` | baseline | false | false | false | 339.38 | 0.0525 | 0 | timeout; empty session output |
| `agent-fs-2026-02-28T15-57-25-492Z` | subagents | false | false | false | 376.06 | 0.0673 | 0 | timeout; empty session output |
| `agent-fs-2026-02-28T16-10-09-195Z` | baseline | false | false | false | 351.98 | 0.0732 | 0 | quiz→coding alignment failures |
| `agent-fs-2026-02-28T16-10-09-195Z` | subagents | false | false | false | 361.28 | 0.0785 | 0 | timeout; invalid/missing plan artifacts |
| `agent-fs-2026-02-28T16-22-51-920Z` | baseline | false | false | false | 258.59 | 0.2902 | 0 | grounding/coherence failures |
| `agent-fs-2026-02-28T16-22-51-920Z` | subagents | false | false | false | 383.42 | 0.0808 | 0 | timeout + alignment failures |
| `agent-fs-2026-02-28T16-35-41-169Z` | baseline | false | false | false | 231.83 | 0.2806 | 0 | alignment question targeting fails |
| `agent-fs-2026-02-28T16-35-41-169Z` | subagents | false | false | false | 378.08 | 0.4850 | 6 | missing required Problem 3 hidden marking cases |
| `agent-fs-2026-02-28T16-46-47-439Z` | baseline | false | true | false | 487.72 | 0.2797 | 0 | grader aspect failure / grader-call robustness |
| `agent-fs-2026-02-28T16-46-47-439Z` | subagents | false | false | false | 338.89 | 0.3591 | 6 | quiz-4 alignment fails |
| `agent-fs-2026-02-28T17-01-46-523Z` | baseline | false | true | false | 314.20 | 0.3583 | 0 | hidden-marking cases leaked into examples |
| `agent-fs-2026-02-28T17-01-46-523Z` | subagents | false | true | false | 516.68 | 0.4961 | 7 | Darwinian terminology drift |
| `agent-fs-2026-02-28T17-17-05-091Z` | baseline | false | true | false | 277.76 | 0.3234 | 0 | output-format ambiguity in Problem 2 example |
| `agent-fs-2026-02-28T17-17-05-091Z` | subagents | false | false | false | 303.91 | 0.2981 | 6 | invalid JSON in `problem-1.json` |
| `agent-fs-2026-02-28T17-27-58-478Z` | baseline | false | true | false | 389.66 | 0.4286 | 0 | solution correctness bug in Problem 3 code |
| `agent-fs-2026-02-28T17-27-58-478Z` | subagents | false | true | false | 598.79 | 0.1609 | 0 | timeout + weak/non-trivial test depth |

## What has been changed already

Investigation has already added/adjusted:
- stricter quiz→coding alignment checks
- delegation evidence schema and policy checks
- hidden-test leakage constraints for Problem 3
- Darwinian-term prohibition checks
- timeout/retry/reasoning toggles for codex runs
- grader prompt clarifications to avoid schema-external assumptions

## Current Understanding of Root Causes

1. **Task difficulty + strict validators** produce many near-miss failures, especially in:
   - alignment specificity,
   - hidden/visible case separation,
   - exact output-format expectations.
2. **Subagents reliability is unstable** (sometimes used, sometimes not; sometimes malformed JSON; occasional timeout with no subagent usage).
3. **Grader-sensitive failures remain** after schema passes, often due to content-quality gaps (insufficiently strong tests, correctness defects, or ambiguous formatting).
4. **Benchmark can regress between runs** due to prompt/validator tightening outpacing generation quality under current budgets.

## Remaining Hypotheses

- The strongest blocker is not single wiring bug anymore; it is a **compound of strict content requirements + brittle generation quality under time budget**.
- Subagent mode may need tighter generation guardrails (output shape contracts + immediate repair pass) to avoid malformed/low-quality artifacts.
- Some grading failures are likely solvable by reducing ambiguity in task wording and examples (without weakening rubric).

## Recommended Next Experiments (no rubric weakening)

1. **Stabilize codex-only pass path first (baseline)**
   - Keep single-model codex runs with deterministic constraints.
   - Add pre-grader deterministic checks for known failure classes (format/hidden-case leakage/required coverage).
2. **Then stabilize subagents variant**
   - Require early spawn + explicit artifact ownership + mandatory merge/repair step.
   - Add JSON validity gate before accepting subagent outputs.
3. **Only after codex is green on both variants**, run all models in parallel and produce final matrix.
4. **Preserve and compare full per-model metrics**
   - pass/fail, schema/tool/grader flags, wall time, phase times, subagent calls, queue/setup/generation times, tokens, cost.

## Notes
- Latest in-repo traces/report snapshot referenced during this checkpoint:
  - `benchmarks/lesson-generation/traces/latest/summary.json`
  - `benchmarks/lesson-generation/traces/latest/report.md`
  - `benchmarks/lesson-generation/LATEST_RESULTS.md`
