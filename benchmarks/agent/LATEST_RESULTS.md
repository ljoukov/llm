# Latest Agent Benchmark Results

This is a committed summary of the most recent benchmark run.

- Run id: `agent-fs-2026-02-12T13-24-32-749Z`
- Task: `tumor-vaccine-ici`
- Models: `chatgpt-gpt-5.3-codex`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-3-pro-preview`, `gemini-3-flash-preview`
- Grader: `gpt-5.2`

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls |
|---|---|---|---|---|---:|
| `chatgpt-gpt-5.3-codex` | PASS | pass | pass | pass | 26 |
| `gemini-2.5-pro` | FAIL | fail | pass | fail | 22 |
| `gemini-flash-latest` | FAIL | pass | pass | fail | 20 |
| `gemini-3-pro-preview` | FAIL | pass | pass | fail | 22 |
| `gemini-3-flash-preview` | FAIL | pass | pass | fail | 22 |

## Interpretation

- Codex 5.3: passed end-to-end on a non-trivial filesystem extraction/summarization task.
- Gemini 2.5 Pro: used tools correctly but failed strict output quality checks in this run (schema + grader).
- Gemini Flash: used tools and satisfied schema in this run, but failed grader on faithfulness/calibration.
- Gemini 3 Pro preview: used tools and satisfied schema in this run, but failed grader on faithfulness/calibration.
- Gemini 3 Flash preview: used tools and satisfied schema in this run, but failed grader on faithfulness/calibration.

## Tool Usage Confirmation

All five models called filesystem tools (read + write) and produced trace artifacts. Path policy checks passed:

- no absolute paths
- no `..` traversal

## Note on Artifacts

Committed per-model traces and workspace snapshots are available at `benchmarks/agent/traces/latest/`.
Raw per-run artifacts are generated under `benchmarks/agent/results/` at runtime (gitignored).
