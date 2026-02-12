import { z } from "zod";

function strictObject<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape).strict();
}

export const LineRefSchema = z.string().regex(/^L[1-9]\d*$/);

export const StudyOverviewSchema = strictObject({
  paper: strictObject({
    title: z.string().min(10),
    doi: z.string().regex(/^10\./),
    publication_year: z.number().int().min(1900).max(2100),
    domain: z.enum([
      "oncology-immunology",
      "exoplanet-atmospheres",
      "climate-science",
      "neuroscience",
      "other",
    ]),
    study_type: z.enum([
      "preclinical+retrospective",
      "observational-astronomy",
      "randomized-trial",
      "simulation",
      "mixed",
    ]),
  }),
  core_question: z.string().min(20),
  datasets_or_cohorts: z
    .array(
      strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        label: z.string().min(3),
        sample_size_or_observations: z.string().min(1),
        description: z.string().min(20),
      }),
    )
    .min(2)
    .max(8),
  major_limitations: z.array(z.string().min(12)).min(3).max(8),
});

export const QuantitativeFindingsSchema = strictObject({
  findings: z
    .array(
      strictObject({
        id: z.string().regex(/^Q[0-9]{2}$/),
        metric: z.string().min(6),
        value: z.string().min(1),
        comparator_or_baseline: z.string().min(1),
        interpretation: z.string().min(12),
        evidence_line_refs: z.array(LineRefSchema).min(1).max(3),
      }),
    )
    .min(5)
    .max(14),
  controls_or_null_results: z
    .array(
      strictObject({
        statement: z.string().min(10),
        evidence_line_ref: LineRefSchema,
      }),
    )
    .min(2)
    .max(10),
});

export const ClaimAuditSchema = strictObject({
  claims: z
    .array(
      strictObject({
        claim_id: z.string().regex(/^C[0-9]{2}$/),
        claim: z.string().min(20),
        strength: z.enum(["strong", "moderate", "tentative"]),
        evidence: z
          .array(
            strictObject({
              quote: z.string().min(10),
              line_ref: LineRefSchema,
            }),
          )
          .min(2)
          .max(3),
        caveat: z.string().min(20),
      }),
    )
    .min(4)
    .max(10),
});

export const PublicSummarySchema = strictObject({
  headline: z.string().min(20).max(120),
  plain_language_summary: z.string().min(180).max(1200),
  what_is_new: z.array(z.string().min(20)).length(3),
  why_caution_is_needed: z.array(z.string().min(20)).min(3).max(5),
  glossary: z
    .array(
      strictObject({
        term: z.string().min(2),
        definition: z.string().min(20).max(220),
      }),
    )
    .min(4)
    .max(8),
  open_questions: z.array(z.string().min(20)).min(3).max(6),
});

export type StudyOverview = z.infer<typeof StudyOverviewSchema>;
export type QuantitativeFindings = z.infer<typeof QuantitativeFindingsSchema>;
export type ClaimAudit = z.infer<typeof ClaimAuditSchema>;
export type PublicSummary = z.infer<typeof PublicSummarySchema>;

export type OutputFileSpec = {
  readonly outputFile: string;
  readonly schemaFile: string;
  readonly description: string;
  readonly schema: z.ZodType;
};

export const OUTPUT_FILE_SPECS: readonly OutputFileSpec[] = [
  {
    outputFile: "output/study_overview.json",
    schemaFile: "schemas/study_overview.schema.json",
    description:
      "Core metadata, study framing, cohorts/scenarios, and major limitations extracted from the report.",
    schema: StudyOverviewSchema,
  },
  {
    outputFile: "output/quantitative_findings.json",
    schemaFile: "schemas/quantitative_findings.schema.json",
    description:
      "Structured quantitative findings with explicit line references and null/control outcomes.",
    schema: QuantitativeFindingsSchema,
  },
  {
    outputFile: "output/claim_audit.json",
    schemaFile: "schemas/claim_audit.schema.json",
    description: "Claims with strength labels and grounded evidence quotes copied from the report.",
    schema: ClaimAuditSchema,
  },
  {
    outputFile: "output/public_summary.json",
    schemaFile: "schemas/public_summary.schema.json",
    description: "Public-friendly summary, caution notes, glossary, and open questions.",
    schema: PublicSummarySchema,
  },
] as const;

export type ScienceBenchmarkTask = {
  readonly id: string;
  readonly title: string;
  readonly reportFile: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
};

export const SCIENCE_BENCHMARK_TASKS: readonly ScienceBenchmarkTask[] = [
  {
    id: "tumor-vaccine-ici",
    title: "mRNA tumor sensitization for checkpoint blockade",
    reportFile: "reports/tumor-vaccine-ici.md",
    sourceTitle: "SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade",
    sourceUrl: "https://www.nature.com/articles/s41586-025-09006-8",
  },
  {
    id: "trappist1b-atmosphere",
    title: "JWST phase-curve evidence for an atmosphere on TRAPPIST-1 b",
    reportFile: "reports/trappist-b-atmosphere.md",
    sourceTitle: "Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b",
    sourceUrl: "https://arxiv.org/abs/2409.13036",
  },
];

export const DEFAULT_BENCHMARK_MODELS: readonly string[] = [
  "chatgpt-gpt-5.3-codex",
  "gemini-2.5-pro",
  "gemini-flash-latest",
];
