import { randomBytes } from "node:crypto";

export type CandidateIssue = {
  readonly issueId?: string;
  readonly issueType?: string;
  readonly summary?: string;
};

export type CandidateAssessment<TIssue extends CandidateIssue = CandidateIssue> = {
  readonly score: number;
  readonly trainableIssues: readonly TIssue[];
  readonly holdoutIssues?: readonly TIssue[];
  readonly isViable?: boolean;
  readonly issueTypeWeights?: Readonly<Record<string, number>>;
};

export type CandidateProposal<TCandidate> = {
  readonly candidate: TCandidate;
  readonly changeSummary?: string;
};

export type CandidateFeedbackEntry = {
  readonly id: string;
  readonly candidateId: string;
  readonly attemptedChange: string;
  readonly observedOutcome: string;
};

export type CandidateRecord<
  TCandidate,
  TIssue extends CandidateIssue = CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue> = CandidateAssessment<TIssue>,
> = {
  readonly id: string;
  readonly candidate: TCandidate;
  readonly assessment: TAssessment;
  readonly createdAtIteration: number;
  readonly parentId?: string;
  readonly generatorName?: string;
  readonly sampledIssueIds?: readonly string[];
  readonly sampledFeedbackEntryIds?: readonly string[];
  readonly changeSummary?: string;
};

export type GenerationSubagentInput<
  TCandidate,
  TIssue extends CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue>,
> = {
  readonly parent: CandidateRecord<TCandidate, TIssue, TAssessment>;
  readonly sampledIssues: readonly TIssue[];
  readonly feedbackEntries: readonly CandidateFeedbackEntry[];
  readonly iteration: number;
};

export type GenerationSubagent<
  TCandidate,
  TIssue extends CandidateIssue = CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue> = CandidateAssessment<TIssue>,
> = {
  readonly name: string;
  readonly supportsIssueBatch?: boolean;
  generate: (
    input: GenerationSubagentInput<TCandidate, TIssue, TAssessment>,
  ) => Promise<readonly CandidateProposal<TCandidate>[]>;
};

export type AssessmentSubagentInput<
  TCandidate,
  TIssue extends CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue>,
> = {
  readonly candidate: TCandidate;
  readonly iteration: number;
  readonly parent?: CandidateRecord<TCandidate, TIssue, TAssessment>;
  readonly generatorName?: string;
  readonly sampledIssues?: readonly TIssue[];
};

export type PostGenerationCheckInput<
  TCandidate,
  TIssue extends CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue>,
> = {
  readonly proposal: CandidateProposal<TCandidate>;
  readonly parent: CandidateRecord<TCandidate, TIssue, TAssessment>;
  readonly generatorName: string;
  readonly sampledIssues: readonly TIssue[];
  readonly iteration: number;
};

export type ParentSelectionMidpoint =
  | { readonly mode: "fixed"; readonly value: number }
  | { readonly mode: "percentile"; readonly percentile: number };

export type ParentSelectionConfig = {
  readonly sharpness?: number;
  readonly midpoint?: ParentSelectionMidpoint;
  readonly noveltyWeight?: number;
  readonly replace?: boolean;
};

export type FeedbackScope =
  | { readonly mode: "none" }
  | { readonly mode: "ancestors"; readonly maxDepth?: number }
  | { readonly mode: "neighborhood"; readonly maxDistance: number };

export type CandidateEvolutionStats = {
  generationCalls: number;
  issuesSupplied: number;
  proposalsGenerated: number;
  proposalsAfterPostCheck: number;
  assessmentCalls: number;
  postCheckCalls: number;
  feedbackEntriesSupplied: number;
};

export type CandidateEvolutionSnapshot<
  TCandidate,
  TIssue extends CandidateIssue = CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue> = CandidateAssessment<TIssue>,
> = {
  readonly iteration: number;
  readonly archiveSize: number;
  readonly bestCandidateId: string;
  readonly bestScore: number;
  readonly scorePercentiles: Readonly<Record<number, number>>;
  readonly stats: CandidateEvolutionStats;
  readonly bestCandidate: CandidateRecord<TCandidate, TIssue, TAssessment>;
};

export type PostCheckRejection<TCandidate> = {
  readonly id: string;
  readonly candidate: TCandidate;
  readonly parentId: string;
  readonly generatorName: string;
  readonly iteration: number;
  readonly sampledIssueIds: readonly string[];
  readonly changeSummary?: string;
};

export type CandidateEvolutionOptions<
  TCandidate,
  TIssue extends CandidateIssue = CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue> = CandidateAssessment<TIssue>,
> = {
  readonly seedCandidate: TCandidate;
  readonly assessCandidate: (
    input: AssessmentSubagentInput<TCandidate, TIssue, TAssessment>,
  ) => Promise<TAssessment>;
  readonly generators: readonly GenerationSubagent<TCandidate, TIssue, TAssessment>[];
  readonly iterations: number;
  readonly parentsPerIteration: number;
  readonly batchSize?: number;
  readonly generationConcurrency?: number;
  readonly assessmentConcurrency?: number;
  readonly parentSelection?: ParentSelectionConfig;
  readonly feedbackScope?: FeedbackScope;
  readonly verifyGeneratedCandidate?: (
    input: PostGenerationCheckInput<TCandidate, TIssue, TAssessment>,
  ) => Promise<boolean>;
  readonly describeObservedOutcome?: (input: {
    readonly assessment: TAssessment;
    readonly parentAssessment: TAssessment | null;
  }) => string;
  readonly scorePercentiles?: readonly number[];
  readonly random?: () => number;
  readonly onSnapshot?: (
    snapshot: CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment>,
  ) => void | Promise<void>;
};

export type CandidateEvolutionResult<
  TCandidate,
  TIssue extends CandidateIssue = CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue> = CandidateAssessment<TIssue>,
> = {
  readonly archive: readonly CandidateRecord<TCandidate, TIssue, TAssessment>[];
  readonly feedbackEntries: readonly CandidateFeedbackEntry[];
  readonly postCheckRejections: readonly PostCheckRejection<TCandidate>[];
  readonly snapshots: readonly CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment>[];
  readonly bestCandidate: CandidateRecord<TCandidate, TIssue, TAssessment>;
  readonly totalStats: CandidateEvolutionStats;
  readonly stoppedEarly: boolean;
};

type IssueEnvelope<TIssue extends CandidateIssue> = {
  readonly id: string;
  readonly issueType: string;
  readonly issue: TIssue;
};

type PendingProposal<
  TCandidate,
  TIssue extends CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue>,
> = {
  readonly proposal: CandidateProposal<TCandidate>;
  readonly parent: CandidateRecord<TCandidate, TIssue, TAssessment>;
  readonly generatorName: string;
  readonly sampledIssues: readonly TIssue[];
  readonly sampledIssueIds: readonly string[];
  readonly sampledFeedbackEntryIds: readonly string[];
};

const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_GENERATION_CONCURRENCY = 8;
const DEFAULT_ASSESSMENT_CONCURRENCY = 8;
const DEFAULT_SHARPNESS = 10;
const DEFAULT_NOVELTY_WEIGHT = 1;
const DEFAULT_MIDPOINT: ParentSelectionMidpoint = { mode: "percentile", percentile: 75 };
const DEFAULT_FEEDBACK_SCOPE: FeedbackScope = { mode: "ancestors" };
const DEFAULT_SCORE_PERCENTILES = [0, 25, 50, 75, 90, 95, 100] as const;

function createEmptyStats(): CandidateEvolutionStats {
  return {
    generationCalls: 0,
    issuesSupplied: 0,
    proposalsGenerated: 0,
    proposalsAfterPostCheck: 0,
    assessmentCalls: 0,
    postCheckCalls: 0,
    feedbackEntriesSupplied: 0,
  };
}

function addStats(
  left: CandidateEvolutionStats,
  right: CandidateEvolutionStats,
): CandidateEvolutionStats {
  return {
    generationCalls: left.generationCalls + right.generationCalls,
    issuesSupplied: left.issuesSupplied + right.issuesSupplied,
    proposalsGenerated: left.proposalsGenerated + right.proposalsGenerated,
    proposalsAfterPostCheck: left.proposalsAfterPostCheck + right.proposalsAfterPostCheck,
    assessmentCalls: left.assessmentCalls + right.assessmentCalls,
    postCheckCalls: left.postCheckCalls + right.postCheckCalls,
    feedbackEntriesSupplied: left.feedbackEntriesSupplied + right.feedbackEntriesSupplied,
  };
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function toFiniteNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function normalizeRandom(random: (() => number) | undefined): () => number {
  if (!random) {
    return () => Math.random();
  }
  return () => {
    const value = toFiniteNumber(random(), 0);
    if (value <= 0) {
      return 0;
    }
    if (value >= 1) {
      return 0.999999999999;
    }
    return value;
  };
}

function sigmoidScore(score: number, midpoint: number, sharpness: number): number {
  return 1 / (1 + Math.exp(-sharpness * (score - midpoint)));
}

function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0] ?? 0;
  }
  const safePercentile = Math.max(0, Math.min(100, percentile));
  const position = (sortedValues.length - 1) * (safePercentile / 100);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower] ?? 0;
  const upperValue = sortedValues[upper] ?? lowerValue;
  if (lower === upper) {
    return lowerValue;
  }
  const fraction = position - lower;
  return lowerValue * (1 - fraction) + upperValue * fraction;
}

function computeScorePercentiles(
  records: readonly { assessment: { score: number } }[],
  percentiles: readonly number[],
): Readonly<Record<number, number>> {
  const scores = records
    .map((record) => record.assessment.score)
    .filter((score) => Number.isFinite(score))
    .sort((a, b) => a - b);
  const output: Record<number, number> = {};
  for (const percentile of percentiles) {
    output[percentile] = computePercentile(scores, percentile);
  }
  return output;
}

function pickByWeights<T>(
  values: readonly T[],
  weights: readonly number[],
  random: () => number,
): T {
  if (values.length === 0) {
    throw new Error("Cannot pick from an empty set.");
  }
  if (values.length !== weights.length) {
    throw new Error("values and weights must have the same length.");
  }

  let totalWeight = 0;
  for (const weight of weights) {
    if (Number.isFinite(weight) && weight > 0) {
      totalWeight += weight;
    }
  }

  if (totalWeight <= 0) {
    const index = Math.min(values.length - 1, Math.floor(random() * values.length));
    const fallbackValue = values[index];
    if (fallbackValue === undefined) {
      throw new Error("Unexpected empty value during uniform fallback pick.");
    }
    return fallbackValue;
  }

  let threshold = random() * totalWeight;
  for (let index = 0; index < values.length; index += 1) {
    const weight =
      Number.isFinite(weights[index] ?? 0) && (weights[index] ?? 0) > 0 ? (weights[index] ?? 0) : 0;
    threshold -= weight;
    if (threshold <= 0) {
      const value = values[index];
      if (value === undefined) {
        break;
      }
      return value;
    }
  }

  const last = values[values.length - 1];
  if (last === undefined) {
    throw new Error("Unexpected missing final value during weighted pick.");
  }
  return last;
}

function sampleWithoutReplacement<T>(
  values: readonly T[],
  k: number,
  random: () => number,
): readonly T[] {
  if (k <= 0 || values.length === 0) {
    return [];
  }
  if (k >= values.length) {
    return [...values];
  }

  const pool = [...values];
  const output: T[] = [];
  for (let index = 0; index < k; index += 1) {
    const pickIndex = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    const [picked] = pool.splice(pickIndex, 1);
    if (picked === undefined) {
      break;
    }
    output.push(picked);
  }
  return output;
}

function isEligibleRecord<TIssue extends CandidateIssue>(record: {
  assessment: CandidateAssessment<TIssue>;
}): boolean {
  return record.assessment.isViable !== false && record.assessment.trainableIssues.length > 0;
}

function resolveIssueType(issue: CandidateIssue): string {
  const raw = issue.issueType?.trim();
  if (!raw) {
    return "default";
  }
  return raw;
}

function resolveIssueId<TIssue extends CandidateIssue>(
  issue: TIssue,
  parentId: string,
  index: number,
): string {
  const raw = issue.issueId?.trim();
  if (raw && raw.length > 0) {
    return raw;
  }
  return `${parentId}:issue:${index}`;
}

function normalizeIssuesForRecord<TIssue extends CandidateIssue>(
  parentId: string,
  issues: readonly TIssue[],
): readonly IssueEnvelope<TIssue>[] {
  return issues.map((issue, index) => ({
    id: resolveIssueId(issue, parentId, index),
    issueType: resolveIssueType(issue),
    issue,
  }));
}

function sampleIssuesByType<TIssue extends CandidateIssue>(
  issues: readonly IssueEnvelope<TIssue>[],
  batchSize: number,
  typeWeights: Readonly<Record<string, number>> | undefined,
  random: () => number,
): readonly IssueEnvelope<TIssue>[] {
  if (issues.length === 0 || batchSize <= 0) {
    return [];
  }

  const frequency = new Map<string, number>();
  for (const issue of issues) {
    frequency.set(issue.issueType, (frequency.get(issue.issueType) ?? 0) + 1);
  }

  const issueTypes = [...frequency.keys()];
  const weightedFrequency = issueTypes.map((type) => {
    const base = frequency.get(type) ?? 0;
    const multiplierRaw = typeWeights?.[type] ?? 1;
    const multiplier = Number.isFinite(multiplierRaw) && multiplierRaw > 0 ? multiplierRaw : 1;
    return base * multiplier;
  });

  const selectedType = pickByWeights(issueTypes, weightedFrequency, random);
  const sameTypeIssues = issues.filter((issue) => issue.issueType === selectedType);
  const effectiveBatchSize = Math.min(batchSize, sameTypeIssues.length);
  return sampleWithoutReplacement(sameTypeIssues, effectiveBatchSize, random);
}

function resolveMidpoint(
  midpoint: ParentSelectionMidpoint,
  archive: readonly { assessment: { score: number } }[],
): number {
  if (midpoint.mode === "fixed") {
    return midpoint.value;
  }
  const scores = archive
    .map((record) => record.assessment.score)
    .filter((score) => Number.isFinite(score))
    .sort((a, b) => a - b);
  return computePercentile(scores, midpoint.percentile);
}

function selectParents<
  TCandidate,
  TIssue extends CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue>,
>(input: {
  readonly eligible: readonly CandidateRecord<TCandidate, TIssue, TAssessment>[];
  readonly archive: readonly CandidateRecord<TCandidate, TIssue, TAssessment>[];
  readonly parentsPerIteration: number;
  readonly sharpness: number;
  readonly midpoint: ParentSelectionMidpoint;
  readonly noveltyWeight: number;
  readonly replace: boolean;
  readonly childCountByParentId: ReadonlyMap<string, number>;
  readonly random: () => number;
}): readonly CandidateRecord<TCandidate, TIssue, TAssessment>[] {
  const {
    eligible,
    archive,
    parentsPerIteration,
    sharpness,
    midpoint,
    noveltyWeight,
    replace,
    childCountByParentId,
    random,
  } = input;

  if (eligible.length === 0 || parentsPerIteration <= 0) {
    return [];
  }

  const midpointScore = resolveMidpoint(midpoint, archive);
  const weightedParents = eligible.map((record) => {
    const performance = sigmoidScore(record.assessment.score, midpointScore, sharpness);
    const childCount = childCountByParentId.get(record.id) ?? 0;
    const novelty = 1 / (1 + noveltyWeight * childCount);
    return {
      record,
      weight: performance * novelty,
    };
  });

  if (replace) {
    const output: CandidateRecord<TCandidate, TIssue, TAssessment>[] = [];
    for (let index = 0; index < parentsPerIteration; index += 1) {
      output.push(
        pickByWeights(
          weightedParents.map((entry) => entry.record),
          weightedParents.map((entry) => entry.weight),
          random,
        ),
      );
    }
    return output;
  }

  if (parentsPerIteration >= weightedParents.length) {
    return weightedParents.map((entry) => entry.record);
  }

  const pool = [...weightedParents];
  const output: CandidateRecord<TCandidate, TIssue, TAssessment>[] = [];
  for (let index = 0; index < parentsPerIteration; index += 1) {
    const chosen = pickByWeights(
      pool.map((entry) => entry.record),
      pool.map((entry) => entry.weight),
      random,
    );
    output.push(chosen);
    const removeIndex = pool.findIndex((entry) => entry.record.id === chosen.id);
    if (removeIndex >= 0) {
      pool.splice(removeIndex, 1);
    }
  }
  return output;
}

function defaultObservedOutcome<TIssue extends CandidateIssue>(input: {
  readonly assessment: CandidateAssessment<TIssue>;
  readonly parentAssessment: CandidateAssessment<TIssue> | null;
}): string {
  const { assessment, parentAssessment } = input;
  if (assessment.isViable === false) {
    return "Inconclusive - resulting candidate was marked non-viable.";
  }
  const roundedScore = Number.isFinite(assessment.score) ? assessment.score.toFixed(3) : "n/a";
  if (!parentAssessment) {
    return `Candidate score: ${roundedScore}.`;
  }
  const parentScore = Number.isFinite(parentAssessment.score)
    ? parentAssessment.score.toFixed(3)
    : "n/a";
  if (assessment.score > parentAssessment.score) {
    return `Candidate score: ${roundedScore}. Improved over parent score ${parentScore}.`;
  }
  if (assessment.score < parentAssessment.score) {
    return `Candidate score: ${roundedScore}. Worse than parent score ${parentScore}.`;
  }
  return `Candidate score: ${roundedScore}. Same as parent score ${parentScore}.`;
}

function resolveFeedbackEntries<
  TCandidate,
  TIssue extends CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue>,
>(input: {
  readonly scope: FeedbackScope;
  readonly parent: CandidateRecord<TCandidate, TIssue, TAssessment>;
  readonly candidateById: ReadonlyMap<string, CandidateRecord<TCandidate, TIssue, TAssessment>>;
  readonly feedbackByCandidateId: ReadonlyMap<string, CandidateFeedbackEntry>;
  readonly childrenByParentId: ReadonlyMap<string, readonly string[]>;
}): readonly CandidateFeedbackEntry[] {
  const { scope, parent, candidateById, feedbackByCandidateId, childrenByParentId } = input;
  if (scope.mode === "none") {
    return [];
  }

  if (scope.mode === "ancestors") {
    const output: CandidateFeedbackEntry[] = [];
    let currentId: string | undefined = parent.id;
    let depth = 0;
    while (currentId) {
      if (scope.maxDepth !== undefined && depth > scope.maxDepth) {
        break;
      }
      const entry = feedbackByCandidateId.get(currentId);
      if (entry) {
        output.push(entry);
      }
      const current = candidateById.get(currentId);
      currentId = current?.parentId;
      depth += 1;
    }
    return output;
  }

  const maxDistance = scope.maxDistance;
  if (maxDistance < 0) {
    return [];
  }
  const output: CandidateFeedbackEntry[] = [];
  const queue: Array<{ id: string; distance: number }> = [{ id: parent.id, distance: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (visited.has(current.id)) {
      continue;
    }
    visited.add(current.id);

    const entry = feedbackByCandidateId.get(current.id);
    if (entry) {
      output.push(entry);
    }

    if (current.distance >= maxDistance) {
      continue;
    }

    const parentRecord = candidateById.get(current.id);
    const ancestorId = parentRecord?.parentId;
    if (ancestorId && !visited.has(ancestorId)) {
      queue.push({ id: ancestorId, distance: current.distance + 1 });
    }
    const children = childrenByParentId.get(current.id) ?? [];
    for (const childId of children) {
      if (!visited.has(childId)) {
        queue.push({ id: childId, distance: current.distance + 1 });
      }
    }
  }

  return output;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  maxConcurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }
  const concurrency = Math.max(1, Math.floor(maxConcurrency));
  const output = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        break;
      }
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      output[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return output;
}

export async function runCandidateEvolution<
  TCandidate,
  TIssue extends CandidateIssue = CandidateIssue,
  TAssessment extends CandidateAssessment<TIssue> = CandidateAssessment<TIssue>,
>(
  options: CandidateEvolutionOptions<TCandidate, TIssue, TAssessment>,
): Promise<CandidateEvolutionResult<TCandidate, TIssue, TAssessment>> {
  const iterations = Math.max(0, Math.floor(options.iterations));
  const parentsPerIteration = Math.max(0, Math.floor(options.parentsPerIteration));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const generationConcurrency = Math.max(
    1,
    Math.floor(options.generationConcurrency ?? DEFAULT_GENERATION_CONCURRENCY),
  );
  const assessmentConcurrency = Math.max(
    1,
    Math.floor(options.assessmentConcurrency ?? DEFAULT_ASSESSMENT_CONCURRENCY),
  );

  if (options.generators.length === 0) {
    throw new Error("runCandidateEvolution requires at least one generator subagent.");
  }
  if (parentsPerIteration <= 0) {
    throw new Error("parentsPerIteration must be positive.");
  }
  const generationNames = new Set<string>();
  for (const generator of options.generators) {
    if (!generator.name.trim()) {
      throw new Error("Generator names must be non-empty.");
    }
    if (generationNames.has(generator.name)) {
      throw new Error(`Duplicate generator name "${generator.name}".`);
    }
    generationNames.add(generator.name);
  }

  const random = normalizeRandom(options.random);
  const parentSelection = options.parentSelection;
  const selectionSharpness =
    parentSelection?.sharpness !== undefined
      ? Math.max(0.0001, parentSelection.sharpness)
      : DEFAULT_SHARPNESS;
  const selectionMidpoint = parentSelection?.midpoint ?? DEFAULT_MIDPOINT;
  const noveltyWeight =
    parentSelection?.noveltyWeight !== undefined
      ? Math.max(0, parentSelection.noveltyWeight)
      : DEFAULT_NOVELTY_WEIGHT;
  const selectionReplace = parentSelection?.replace ?? true;
  const feedbackScope = options.feedbackScope ?? DEFAULT_FEEDBACK_SCOPE;
  const describeObservedOutcome = options.describeObservedOutcome ?? defaultObservedOutcome;
  const scorePercentiles =
    options.scorePercentiles && options.scorePercentiles.length > 0
      ? options.scorePercentiles
      : DEFAULT_SCORE_PERCENTILES;

  const archive: CandidateRecord<TCandidate, TIssue, TAssessment>[] = [];
  const feedbackEntries: CandidateFeedbackEntry[] = [];
  const postCheckRejections: PostCheckRejection<TCandidate>[] = [];
  const snapshots: CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment>[] = [];

  const candidateById = new Map<string, CandidateRecord<TCandidate, TIssue, TAssessment>>();
  const feedbackByCandidateId = new Map<string, CandidateFeedbackEntry>();
  const childCountByParentId = new Map<string, number>();
  const childrenByParentId = new Map<string, string[]>();

  let totalStats = createEmptyStats();
  let stoppedEarly = false;

  const seedAssessment = await options.assessCandidate({
    candidate: options.seedCandidate,
    iteration: 0,
  });

  const seedRecord: CandidateRecord<TCandidate, TIssue, TAssessment> = {
    id: randomId("candidate"),
    candidate: options.seedCandidate,
    assessment: seedAssessment,
    createdAtIteration: 0,
  };

  archive.push(seedRecord);
  candidateById.set(seedRecord.id, seedRecord);

  const initialStats = createEmptyStats();
  initialStats.assessmentCalls += 1;
  totalStats = addStats(totalStats, initialStats);

  const initialSnapshot: CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment> = {
    iteration: 0,
    archiveSize: archive.length,
    bestCandidateId: seedRecord.id,
    bestScore: seedRecord.assessment.score,
    scorePercentiles: computeScorePercentiles(archive, scorePercentiles),
    stats: initialStats,
    bestCandidate: seedRecord,
  };
  snapshots.push(initialSnapshot);
  await options.onSnapshot?.(initialSnapshot);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const iterationStats = createEmptyStats();

    const eligible = archive.filter((record) => isEligibleRecord(record));
    if (eligible.length === 0) {
      stoppedEarly = true;
      const bestCandidate = archive.reduce((best, current) =>
        current.assessment.score > best.assessment.score ? current : best,
      );
      const snapshot: CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment> = {
        iteration,
        archiveSize: archive.length,
        bestCandidateId: bestCandidate.id,
        bestScore: bestCandidate.assessment.score,
        scorePercentiles: computeScorePercentiles(archive, scorePercentiles),
        stats: iterationStats,
        bestCandidate,
      };
      snapshots.push(snapshot);
      await options.onSnapshot?.(snapshot);
      break;
    }

    const selectedParents = selectParents({
      eligible,
      archive,
      parentsPerIteration,
      sharpness: selectionSharpness,
      midpoint: selectionMidpoint,
      noveltyWeight,
      replace: selectionReplace,
      childCountByParentId,
      random,
    });

    const generationTasks: Array<{
      readonly parent: CandidateRecord<TCandidate, TIssue, TAssessment>;
      readonly generator: GenerationSubagent<TCandidate, TIssue, TAssessment>;
      readonly sampledIssueEnvelopes: readonly IssueEnvelope<TIssue>[];
      readonly feedbackEntries: readonly CandidateFeedbackEntry[];
    }> = [];

    for (const parent of selectedParents) {
      const issueEnvelopes = normalizeIssuesForRecord(parent.id, parent.assessment.trainableIssues);
      const sampledIssueEnvelopes = sampleIssuesByType(
        issueEnvelopes,
        batchSize,
        parent.assessment.issueTypeWeights,
        random,
      );
      if (sampledIssueEnvelopes.length === 0) {
        continue;
      }
      const visibleFeedbackEntries = resolveFeedbackEntries({
        scope: feedbackScope,
        parent,
        candidateById,
        feedbackByCandidateId,
        childrenByParentId,
      });

      for (const generator of options.generators) {
        const issuesForGenerator = generator.supportsIssueBatch
          ? sampledIssueEnvelopes
          : sampledIssueEnvelopes.slice(0, 1);
        if (issuesForGenerator.length === 0) {
          continue;
        }
        generationTasks.push({
          parent,
          generator,
          sampledIssueEnvelopes: issuesForGenerator,
          feedbackEntries: visibleFeedbackEntries,
        });
        iterationStats.generationCalls += 1;
        iterationStats.issuesSupplied += issuesForGenerator.length;
        iterationStats.feedbackEntriesSupplied += visibleFeedbackEntries.length;
      }
    }

    if (generationTasks.length === 0) {
      stoppedEarly = true;
      const bestCandidate = archive.reduce((best, current) =>
        current.assessment.score > best.assessment.score ? current : best,
      );
      const snapshot: CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment> = {
        iteration,
        archiveSize: archive.length,
        bestCandidateId: bestCandidate.id,
        bestScore: bestCandidate.assessment.score,
        scorePercentiles: computeScorePercentiles(archive, scorePercentiles),
        stats: iterationStats,
        bestCandidate,
      };
      snapshots.push(snapshot);
      await options.onSnapshot?.(snapshot);
      break;
    }

    const generatedOutputs = await mapWithConcurrency(
      generationTasks,
      generationConcurrency,
      async (task) => {
        const proposals = await task.generator.generate({
          parent: task.parent,
          sampledIssues: task.sampledIssueEnvelopes.map((envelope) => envelope.issue),
          feedbackEntries: task.feedbackEntries,
          iteration,
        });
        return { task, proposals };
      },
    );

    const pendingProposals: PendingProposal<TCandidate, TIssue, TAssessment>[] = [];
    for (const output of generatedOutputs) {
      iterationStats.proposalsGenerated += output.proposals.length;
      for (const proposal of output.proposals) {
        pendingProposals.push({
          proposal,
          parent: output.task.parent,
          generatorName: output.task.generator.name,
          sampledIssues: output.task.sampledIssueEnvelopes.map((envelope) => envelope.issue),
          sampledIssueIds: output.task.sampledIssueEnvelopes.map((envelope) => envelope.id),
          sampledFeedbackEntryIds: output.task.feedbackEntries.map((entry) => entry.id),
        });
      }
    }

    const evaluatedProposals = await mapWithConcurrency(
      pendingProposals,
      assessmentConcurrency,
      async (pending) => {
        if (options.verifyGeneratedCandidate) {
          iterationStats.postCheckCalls += 1;
          const passes = await options.verifyGeneratedCandidate({
            proposal: pending.proposal,
            parent: pending.parent,
            generatorName: pending.generatorName,
            sampledIssues: pending.sampledIssues,
            iteration,
          });
          if (!passes) {
            postCheckRejections.push({
              id: randomId("rejected"),
              candidate: pending.proposal.candidate,
              parentId: pending.parent.id,
              generatorName: pending.generatorName,
              iteration,
              sampledIssueIds: pending.sampledIssueIds,
              changeSummary: pending.proposal.changeSummary,
            });
            return null;
          }
        }

        iterationStats.proposalsAfterPostCheck += 1;
        iterationStats.assessmentCalls += 1;
        const assessment = await options.assessCandidate({
          candidate: pending.proposal.candidate,
          iteration,
          parent: pending.parent,
          generatorName: pending.generatorName,
          sampledIssues: pending.sampledIssues,
        });

        return {
          pending,
          assessment,
        };
      },
    );

    const acceptedRecords: CandidateRecord<TCandidate, TIssue, TAssessment>[] = [];
    for (const evaluated of evaluatedProposals) {
      if (!evaluated) {
        continue;
      }
      const { pending, assessment } = evaluated;
      acceptedRecords.push({
        id: randomId("candidate"),
        candidate: pending.proposal.candidate,
        assessment,
        createdAtIteration: iteration,
        parentId: pending.parent.id,
        generatorName: pending.generatorName,
        sampledIssueIds: pending.sampledIssueIds,
        sampledFeedbackEntryIds: pending.sampledFeedbackEntryIds,
        changeSummary: pending.proposal.changeSummary,
      });
    }

    for (const record of acceptedRecords) {
      archive.push(record);
      candidateById.set(record.id, record);
      if (record.parentId) {
        const nextCount = (childCountByParentId.get(record.parentId) ?? 0) + 1;
        childCountByParentId.set(record.parentId, nextCount);

        const existingChildren = childrenByParentId.get(record.parentId) ?? [];
        existingChildren.push(record.id);
        childrenByParentId.set(record.parentId, existingChildren);
      }

      if (record.changeSummary && record.changeSummary.trim().length > 0) {
        const parentAssessment = record.parentId
          ? (candidateById.get(record.parentId)?.assessment ?? null)
          : null;
        const feedbackEntry: CandidateFeedbackEntry = {
          id: randomId("feedback"),
          candidateId: record.id,
          attemptedChange: record.changeSummary,
          observedOutcome: describeObservedOutcome({
            assessment: record.assessment,
            parentAssessment,
          }),
        };
        feedbackEntries.push(feedbackEntry);
        feedbackByCandidateId.set(record.id, feedbackEntry);
      }
    }

    totalStats = addStats(totalStats, iterationStats);
    const bestCandidate = archive.reduce((best, current) =>
      current.assessment.score > best.assessment.score ? current : best,
    );

    const snapshot: CandidateEvolutionSnapshot<TCandidate, TIssue, TAssessment> = {
      iteration,
      archiveSize: archive.length,
      bestCandidateId: bestCandidate.id,
      bestScore: bestCandidate.assessment.score,
      scorePercentiles: computeScorePercentiles(archive, scorePercentiles),
      stats: iterationStats,
      bestCandidate,
    };
    snapshots.push(snapshot);
    await options.onSnapshot?.(snapshot);
  }

  const bestCandidate = archive.reduce((best, current) =>
    current.assessment.score > best.assessment.score ? current : best,
  );

  return {
    archive,
    feedbackEntries,
    postCheckRejections,
    snapshots,
    bestCandidate,
    totalStats,
    stoppedEarly,
  };
}
