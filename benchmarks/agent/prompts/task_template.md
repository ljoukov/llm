# Agent Task

Task id: {{TASK_ID}}
Task title: {{TASK_TITLE}}
Reference paper: {{SOURCE_TITLE}}
Reference URL: {{SOURCE_URL}}

## Objective
Read the report and produce all required JSON outputs that satisfy their schemas.

## Inputs On Disk
- Report: `{{REPORT_PATH}}`
- Schemas: in `schemas/`

## Required Outputs
{{OUTPUT_SCHEMA_MAPPING_LIST}}

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
