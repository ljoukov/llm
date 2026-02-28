# Lesson Benchmark Investigation (Checkpoint)

Date: 2026-02-28
Owner: Codex investigation checkpoint

## Scope and evidence

This checkpoint is based on current repo evidence only:

- `benchmarks/lesson-generation/traces/latest/summary.json`
- `benchmarks/lesson-generation/traces/latest/report.md`
- `benchmarks/lesson-generation/LATEST_RESULTS.md`
- Visible run logs captured during this investigation session (some older raw artifacts are no longer present in-repo)

## Latest confirmed snapshot (from repo artifacts)

Run ID: `agent-fs-2026-02-28T17-27-58-478Z`

- Model/variants: `chatgpt-gpt-5.3-codex` (`baseline`, `subagents`)
- Overall: `0/2` pass
- Schema: `2/2` pass
- Tool trace: `2/2` pass
- Grader: `0/2` pass
- Total latency: `988.45s` (avg `494.23s`)
- Total cost: `$0.589499`
- Subagent calls observed: `0`
- Baseline vs subagents latency: `389.66s` vs `598.79s` (`0.65x`, subagents slower)

Key confirmed grader-critical failures in this snapshot:

- Problem 1 solution was a placeholder (`def solve(): pass`), not runnable.
- Problem 3 solution had logic/indentation issues in component extraction.
- Problems 1-2 test sets judged insufficiently non-trivial.

## Run log timeline (visible logs)

These runs were observed in visible logs during the investigation; older full artifacts were not retained in the checked-in `traces/` directory.

| Run ID | Baseline | Subagents | Notes |
|---|---|---|---|
| `agent-fs-2026-02-28T15-57-25-492Z` | timeout + schema/tool/grader fail | timeout + schema/grader fail | no subagent calls seen |
| `agent-fs-2026-02-28T16-10-09-195Z` | timeout + schema/grader fail | timeout + schema/grader fail | early instability |
| `agent-fs-2026-02-28T16-22-51-920Z` | schema fail (no timeout) | timeout + schema fail | no subagent calls in subagent variant |
| `agent-fs-2026-02-28T16-35-41-169Z` | schema fail (alignment) | schema fail (alignment + marking gaps) | some subagent calls observed |
| `agent-fs-2026-02-28T16-46-47-439Z` | schema pass, grader fail | schema fail + grader fail | quiz-4 alignment issue in subagent output |
| `agent-fs-2026-02-28T17-01-46-523Z` | schema pass, grader fail | schema pass, grader fail | quality still below grader bar |
| `agent-fs-2026-02-28T17-17-05-091Z` | schema pass, grader fail | schema fail + grader fail | invalid JSON observed in subagent output |
| `agent-fs-2026-02-28T17-27-58-478Z` | schema/tool pass, grader fail | schema/tool pass + timeout + subagent-policy fail | no subagent calls (confirmed in latest artifacts) |
| `agent-fs-2026-02-28T17-45-12-039Z` | partial/aborted | partial/aborted | user interrupted run |

## Root causes identified

1. Quality failures after schema success
- Outputs frequently satisfy schema/tool constraints but fail grader requirements for executable reference solutions and robust test depth.

2. Subagent policy/runtime mismatch
- Subagent variant often timed out or failed policy due to missing early `spawn_agent` usage (including the latest confirmed run with `0` subagent calls).

3. Ambiguous strictness around test sufficiency
- “Sufficient non-trivial tests” is interpreted strictly by grader; minimal or example-like tests in Problems 1-2 repeatedly trigger failures.

4. Latency budget pressure
- Connection setup overhead and long generation passes make the 5-minute target fragile, especially in subagent mode when delegation does not happen early.

## Fixes tried and outcomes (from visible investigation logs)

| Fix attempted | Outcome |
|---|---|
| Added explicit quiz-to-coding alignment pass in task template/prompt flow | Reduced pure alignment errors; did not resolve grader technical-correctness failures |
| Added validator checks (alignment + prohibited terminology + hidden-case leakage guard) | Improved schema rigor; remaining failures shifted to grader quality/solution correctness |
| Prompt hardening for tests/marking coverage and output constraints | Partial improvement; still inconsistent test depth and code correctness |
| Reasoning/timeout tuning (`xhigh/medium/low`, timeout extension) | Reduced some hard timeouts but did not produce clean pass |
| Grader robustness tweaks (retry attempts/context handling) | Reduced transient grading-call failures, not core content-quality failures |

## Remaining hypotheses

1. Subagent instructions are still too easy to satisfy superficially without actual delegation, causing policy and speed regressions.
2. The generator lacks a mandatory code-quality gate (runnable/reference-solution sanity check) before finalization.
3. Assessment constraints are under-specified for Problems 1-2 test depth, so model optimizes for minimal schema-compliant tests.
4. Combined strict constraints may be overloading a single pass; without explicit staged QA, late defects persist.

## Recommended next experiments

1. Add a pre-submit executable-quality gate for each coding problem
- Verify non-placeholder solution code and basic self-consistency against declared tests.

2. Add deterministic assessment-strength checks
- Enforce minimum diversity/depth heuristics for Problems 1-2 tests (not just count).

3. Enforce early delegation mechanically in subagent mode
- Require first spawn by a fixed early step and fail fast if absent.

4. Split generation into a bounded two-pass pipeline
- Pass A: draft artifacts in parallel.
- Pass B: strict alignment + technical QA rewrite only for failing artifacts.

5. Preserve all run artifacts by run ID in-repo or stable results path
- Avoid losing historical evidence when `traces/latest` is overwritten.

## Current status

- No clean pass yet for `chatgpt-gpt-5.3-codex` baseline+subagents under current strict rubric.
- Investigation is checkpointed here before additional benchmark reruns.
