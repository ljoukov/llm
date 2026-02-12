# Agent Task

Task id: tumor-vaccine-ici
Task title: mRNA tumor sensitization for checkpoint blockade
Reference paper: SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade
Reference URL: https://www.nature.com/articles/s41586-025-09006-8

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
- Do not invent facts or numbers absent from the report.
- Use line refs as `L<number>` where required.
- For claim evidence quotes, copy exact report snippets.
- Use relative paths only.
- Never use absolute paths.
- Never use `..` in paths.
- Write valid JSON only.

## Completion
Respond with a checklist of written output files.
