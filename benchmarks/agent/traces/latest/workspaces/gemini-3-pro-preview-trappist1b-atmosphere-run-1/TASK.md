# Agent Task

Task id: trappist1b-atmosphere
Task title: JWST phase-curve evidence for an atmosphere on TRAPPIST-1 b
Reference paper: Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b
Reference URL: https://arxiv.org/abs/2409.13036

## Objective
Read the report and produce all required JSON outputs that satisfy their schemas.

## Inputs On Disk
- Report: `input/report.md`
- Schemas: in `schemas/`

## Required Outputs
- `output/study_overview.json` (schema: `schemas/study_overview.schema.json`)
- `output/quantitative_findings.json` (schema: `schemas/quantitative_findings.schema.json`)
- `output/claim_audit.json` (schema: `schemas/claim_audit.schema.json`)
- `output/public_summary.json` (schema: `schemas/public_summary.schema.json`)

## Constraints
- Do not invent source facts; derive calculations only from values in the report.
- Use line refs as `L<number>` where required.
- Where quotes are required, copy exact report snippets.
- For calculation outputs, line_refs must include every report line used for equations, constants, and numeric substitutions.
- Use relative paths only.
- Never use absolute paths.
- Never use `..` in paths.
- Write valid JSON only.

## Completion
Respond with a checklist of written output files.
