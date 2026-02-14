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

export const GcseChemistryProblemSchema = strictObject({
  problem_id: z.string().regex(/^P[0-9]{2}$/),
  final_answer: strictObject({
    value: z.number(),
    units: z.string().min(1),
    precision_note: z.string().min(8).max(220),
  }),
  method: z.string().min(120).max(3000),
  key_equations: z.array(z.string().min(3)).min(1).max(5),
  line_refs: z.array(LineRefSchema).min(1).max(4),
  checks: z.array(z.string().min(10)).min(1).max(4),
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
  readonly groundingMode?: "none" | "line-refs" | "quantitative-findings" | "claim-audit";
  readonly expectedAnswer?: {
    readonly value: number;
    readonly tolerance: number;
    readonly units: string;
  };
};

export const SCIENCE_OUTPUT_FILE_SPECS: readonly OutputFileSpec[] = [
  {
    outputFile: "output/study_overview.json",
    schemaFile: "schemas/study_overview.schema.json",
    description:
      "Core metadata, study framing, cohorts/scenarios, and major limitations extracted from the report.",
    schema: StudyOverviewSchema,
    groundingMode: "none",
  },
  {
    outputFile: "output/quantitative_findings.json",
    schemaFile: "schemas/quantitative_findings.schema.json",
    description:
      "Structured quantitative findings with explicit line references and null/control outcomes.",
    schema: QuantitativeFindingsSchema,
    groundingMode: "quantitative-findings",
  },
  {
    outputFile: "output/claim_audit.json",
    schemaFile: "schemas/claim_audit.schema.json",
    description: "Claims with strength labels and grounded evidence quotes copied from the report.",
    schema: ClaimAuditSchema,
    groundingMode: "claim-audit",
  },
  {
    outputFile: "output/public_summary.json",
    schemaFile: "schemas/public_summary.schema.json",
    description: "Public-friendly summary, caution notes, glossary, and open questions.",
    schema: PublicSummarySchema,
    groundingMode: "none",
  },
] as const;

export const GCSE_CHEMISTRY_OUTPUT_FILE_SPECS: readonly OutputFileSpec[] = [
  {
    outputFile: "output/problem_01.json",
    schemaFile: "schemas/problem_01.schema.json",
    description: "Dilution concentration calculation.",
    schema: GcseChemistryProblemSchema,
    groundingMode: "line-refs",
    expectedAnswer: { value: 0.02, tolerance: 0.0004, units: "mol/dm3" },
  },
  {
    outputFile: "output/problem_02.json",
    schemaFile: "schemas/problem_02.schema.json",
    description: "Limestone purity and theoretical CO2 mass.",
    schema: GcseChemistryProblemSchema,
    groundingMode: "line-refs",
    expectedAnswer: { value: 1.85, tolerance: 0.05, units: "g" },
  },
  {
    outputFile: "output/problem_03.json",
    schemaFile: "schemas/problem_03.schema.json",
    description: "Titration concentration of sulfuric acid.",
    schema: GcseChemistryProblemSchema,
    groundingMode: "line-refs",
    expectedAnswer: { value: 0.0702, tolerance: 0.0015, units: "mol/dm3" },
  },
  {
    outputFile: "output/problem_04.json",
    schemaFile: "schemas/problem_04.schema.json",
    description: "Bond-energy enthalpy estimate for methane combustion.",
    schema: GcseChemistryProblemSchema,
    groundingMode: "line-refs",
    expectedAnswer: { value: -814, tolerance: 25, units: "kJ/mol" },
  },
  {
    outputFile: "output/problem_05.json",
    schemaFile: "schemas/problem_05.schema.json",
    description: "Electrolysis copper mass from current and time.",
    schema: GcseChemistryProblemSchema,
    groundingMode: "line-refs",
    expectedAnswer: { value: 0.889, tolerance: 0.03, units: "g" },
  },
  {
    outputFile: "output/problem_06.json",
    schemaFile: "schemas/problem_06.schema.json",
    description: "Kc from equilibrium moles and vessel volume.",
    schema: GcseChemistryProblemSchema,
    groundingMode: "line-refs",
    expectedAnswer: { value: 0.0736, tolerance: 0.003, units: "dimensionless" },
  },
] as const;

export type AgentBenchmarkTask = {
  readonly id: string;
  readonly title: string;
  readonly reportFile: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly outputFileSpecs: readonly OutputFileSpec[];
};

export const AGENT_BENCHMARK_TASKS: readonly AgentBenchmarkTask[] = [
  {
    id: "tumor-vaccine-ici",
    title: "mRNA tumor sensitization for checkpoint blockade",
    reportFile: "input/tumor-vaccine-ici.md",
    sourceTitle: "SARS-CoV-2 mRNA vaccines sensitize tumours to immune checkpoint blockade",
    sourceUrl: "https://www.nature.com/articles/s41586-025-09006-8",
    outputFileSpecs: SCIENCE_OUTPUT_FILE_SPECS,
  },
  {
    id: "trappist1b-atmosphere",
    title: "JWST phase-curve evidence for an atmosphere on TRAPPIST-1 b",
    reportFile: "input/trappist-b-atmosphere.md",
    sourceTitle: "Phase-curve Evidence for an Atmosphere on TRAPPIST-1 b",
    sourceUrl: "https://arxiv.org/abs/2409.13036",
    outputFileSpecs: SCIENCE_OUTPUT_FILE_SPECS,
  },
  {
    id: "gcse-chemistry-8-9",
    title: "GCSE chemistry grade 8-9 multi-step quantitative solving",
    reportFile: "input/gcse-chemistry-8-9.md",
    sourceTitle: "GCSE Chemistry topic set (AQA specification-aligned, synthesized benchmark)",
    sourceUrl:
      "https://www.aqa.org.uk/subjects/science/gcse/chemistry-8462/specification-at-a-glance",
    outputFileSpecs: GCSE_CHEMISTRY_OUTPUT_FILE_SPECS,
  },
];

export const DEFAULT_BENCHMARK_MODELS: readonly string[] = [
  "chatgpt-gpt-5.3-codex",
  "chatgpt-gpt-5.3-codex-spark",
  "gpt-5.2",
  "kimi-k2.5",
  "glm-5",
  "minimax-m2.1",
  "gemini-2.5-pro",
  "gemini-flash-latest",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
];
