# Latest Agent Benchmark Results

This is a committed summary of the most recent benchmark run.

- Run id: `agent-fs-2026-02-12T12-40-12-306Z`
- Task: `tumor-vaccine-ici`
- Models: `chatgpt-gpt-5.3-codex`, `gemini-2.5-pro`, `gemini-flash-latest`
- Grader: `gpt-5.2`

## Outcome

| Model | Overall | Schema | Tool Trace | Grader | Tool Calls |
|---|---|---|---|---|---:|
| `chatgpt-gpt-5.3-codex` | PASS | pass | pass | pass | 24 |
| `gemini-2.5-pro` | FAIL | fail | pass | fail | 20 |
| `gemini-flash-latest` | FAIL | pass | pass | fail | 20 |

## Interpretation

- Codex 5.3: passed end-to-end on a non-trivial filesystem extraction/summarization task.
- Gemini 2.5 Pro: used tools correctly but failed strict output quality checks in this run (schema + grader).
- Gemini Flash: used tools and satisfied schema in this run, but failed grader on faithfulness/calibration.

## Tool Usage Confirmation

All three models called filesystem tools (read + write) and produced trace artifacts. Path policy checks passed:

- no absolute paths
- no `..` traversal

## Note on Raw Artifacts

Full per-run artifacts are generated under `benchmarks/agent/results/` at runtime but are not tracked in git (that directory is gitignored by design).
