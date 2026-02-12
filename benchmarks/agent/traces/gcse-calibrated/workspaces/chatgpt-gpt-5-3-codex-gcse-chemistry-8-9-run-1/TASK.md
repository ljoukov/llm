# Agent Task

Task id: gcse-chemistry-8-9
Task title: GCSE chemistry grade 8-9 multi-step quantitative solving
Reference paper: GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark)
Reference URL: https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance

## Objective
Read the report and produce all required JSON outputs that satisfy their schemas.

## Inputs On Disk
- Report: `input/report.md`
- Schemas: in `schemas/`

## Required Outputs
- `output/problem_01.json` (schema: `schemas/problem_01.schema.json`)
- `output/problem_02.json` (schema: `schemas/problem_02.schema.json`)
- `output/problem_03.json` (schema: `schemas/problem_03.schema.json`)
- `output/problem_04.json` (schema: `schemas/problem_04.schema.json`)
- `output/problem_05.json` (schema: `schemas/problem_05.schema.json`)
- `output/problem_06.json` (schema: `schemas/problem_06.schema.json`)

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
