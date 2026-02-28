# Generic Subagent Candidate Improvement Framework

## Goal
Build a reusable framework for tasks that have:
- a **generation prompt** (produce a candidate solution), and
- a **verification prompt/spec** (score and diagnose candidate quality).

The framework runs with role-specialized subagents, stores feedback from each iteration, and improves candidate quality over time.

Implemented API entrypoint:
- `runCandidateEvolution` in [src/agent/candidateEvolution.ts](/home/yaroslav_volovich/projects/llm/src/agent/candidateEvolution.ts)

---

## Design Options

### 1) Single-Path Repair Loop
Flow: generate -> verify -> revise (using feedback) -> repeat.

How it works:
- Keep one active candidate.
- Verifier returns pass/fail + issues.
- Generator revises the same candidate each round.

Pros:
- Simple mental model.
- Cheapest to run.
- Easy to debug.

Cons:
- Brittle to noisy verifier/generator behavior.
- Easy to get stuck in local minima.
- No exploration/diversity.

Best for:
- Low-cost, deterministic tasks with stable feedback.

### 2) Stage DAG with Checkpoints + Invalidation
Flow: explicit stages with cached outputs and downstream invalidation on failure (Spark-like pipeline orchestration).

How it works:
- Define stage graph (draft, grade, edit, normalize, final verify).
- Persist stage outputs/checkpoints.
- On failure, invalidate stage and downstream stages.

Pros:
- Strong resumability.
- Operationally robust for long pipelines.
- Clear failure boundaries.

Cons:
- More orchestration complexity.
- Optimized for fixed workflows, less for open-ended search.

Best for:
- Product pipelines with expensive, restart-prone long runs.

### 3) Weighted Candidate Archive with Parallel Subagent Mutation (Chosen)
Flow: maintain an archive of candidates, select promising parents, generate variants from sampled issues, optional post-check, full verification, archive accepted variants.

How it works:
- Keep all assessed candidates in an archive.
- Parent sampling weight = quality sigmoid * novelty bonus.
- Sample issue batches by issue type.
- Run multiple generator subagents in parallel per parent.
- Pass learning feedback from prior attempts (ancestor/neighborhood scope).
- Optional post-generation gate before full verification.

Pros:
- Tolerates noisy mutation and verification.
- Balances exploitation (high-score parents) with exploration (novelty).
- Naturally parallel.
- Generalizes across tasks where verifier returns structured issues.

Cons:
- More moving parts than linear loops.
- Requires telemetry to tune.

Best for:
- Prompt/code/spec optimization where reliability comes from repeated selection.

### 4) Tournament Bracket + Bandit Routing
Flow: generators produce candidates, pairwise/tournament verifier compares candidates, bandit allocates budget to higher-yield generators.

How it works:
- Treat verifier as comparative judge instead of absolute scorer.
- Multi-armed bandit routes calls to generator strategies with best win-rate.
- Keep only top candidates per round.

Pros:
- Less sensitive to absolute score calibration.
- Adapts budget toward productive generators.

Cons:
- Harder to preserve rich failure diagnostics.
- Comparative judgments can be unstable.
- More complex for users.

Best for:
- Creative generation where ranking is easier than absolute scoring.

---

## Comparison Summary

| Option | Reliability under noise | Exploration | Operational complexity | Fit for generic generation+verification |
|---|---|---|---|---|
| 1. Single-path repair | Low-Medium | Low | Low | Medium |
| 2. Stage DAG + checkpoints | Medium-High | Low-Medium | High | Medium-High |
| 3. Weighted archive + parallel mutation | High | High | Medium-High | **High** |
| 4. Tournament + bandit | Medium | High | High | Medium |

## Selected Approach
**Option 3** is the default framework.

Why:
- Keeps Darwinian-style strengths (selection + variation + retention) without domain-specific terminology.
- Integrates Spark-like feedback loops directly: verifier diagnostics drive the next generation wave.
- Remains domain-agnostic as long as assessment returns score + issues.
- Works naturally with subagents and optional post-generation checks.

---

## What Is Implemented
Core entities:
- **candidate**: your generated artifact (`TCandidate`)
- **assessment**: score + issue lists (`CandidateAssessment`)
- **issue**: typed, trainable defect (`CandidateIssue`)
- **generator subagent**: mutation strategy (`GenerationSubagent`)
- **feedback entry**: persistent change/outcome memory

Key controls (`CandidateEvolutionOptions`):
- parent selection: `sharpness`, `midpoint`, `noveltyWeight`, replacement policy
- issue batching: `batchSize`, per-type weights from verifier
- feedback scope: `none`, `ancestors`, `neighborhood`
- concurrency: generation and assessment limits
- `verifyGeneratedCandidate`: optional pre-assessment gate
- snapshots: `onSnapshot` callback + stored percentiles and stats

Outputs (`CandidateEvolutionResult`):
- full archive with lineage metadata
- feedback log
- post-check rejections
- per-iteration snapshots
- best candidate + aggregate stats

---

## Execution Lifecycle (Mental Model)
Each iteration does this:
1. Select parent candidates from archive using score + novelty weights.
2. Sample trainable issue batches from each parent assessment.
3. Gather feedback memory (`none` / `ancestors` / `neighborhood`).
4. Run generator subagents in parallel to produce proposals.
5. Optionally reject malformed proposals in `verifyGeneratedCandidate`.
6. Assess surviving proposals and append accepted records to archive.
7. Record feedback entries and emit snapshot telemetry.

In short: selection -> issue-directed variation -> verification -> retention.

---

## Integration Checklist
Use this checklist when wiring a new task into the framework.

1. Define your candidate payload:
- keep it small and explicit (for example `{ session, quizzes, problems }`)
- include enough metadata to debug lineage in logs

2. Define issue taxonomy:
- use stable `issueType` values (`plan`, `quiz_mix`, `schema`, `consistency`)
- emit deterministic `issueId` when possible to improve learning reuse

3. Implement cheap post-check:
- reject obvious malformed outputs before expensive grading
- examples: JSON parse, required files exist, required sections present

4. Implement full assessment:
- combine objective checks (schema/tests) + rubric/judge checks
- return normalized `score` in `[0, 1]`

5. Configure exploration pressure:
- start with `parentsPerIteration=2..4`, `batchSize=2..3`
- increase `noveltyWeight` only when search collapses to similar outputs

6. Add snapshot + trace logging:
- persist per-iteration scores and model/tool durations
- use traces to identify bottlenecks (judge fan-out, retries, parser failures)

---

## How To Use

### 1) Minimal (Single Generator, One Issue Type)
Use this to bootstrap quickly.

```ts
import { runCandidateEvolution } from "@ljoukov/llm";

type Candidate = { text: string };

type Issue = {
  issueId?: string;
  issueType?: string;
  summary?: string;
};

const result = await runCandidateEvolution<Candidate, Issue>({
  seedCandidate: { text: "Draft answer" },
  iterations: 6,
  parentsPerIteration: 1,
  generators: [
    {
      name: "rewrite-generator",
      async generate({ parent, sampledIssues }) {
        const issueHint = sampledIssues.map((i) => i.summary ?? "").join("; ");
        return [
          {
            candidate: { text: `${parent.candidate.text}\n\nImproved: ${issueHint}` },
            changeSummary: "Applied sampled issue hints",
          },
        ];
      },
    },
  ],
  async assessCandidate({ candidate }) {
    const hasImproved = candidate.text.includes("Improved:");
    return {
      score: hasImproved ? 0.8 : 0.4,
      trainableIssues: hasImproved
        ? []
        : [{ issueType: "missing-improvement", summary: "No explicit fix section" }],
      isViable: true,
    };
  },
});

console.log(result.bestCandidate.assessment.score);
```

When to use:
- fast smoke tests
- proving data contract correctness

### 1.5) Small Realistic (One LLM Generator + Deterministic Verifier)
Use this when you want one-model generation but strict deterministic validation.

```ts
await runCandidateEvolution<{ answer: string }, CandidateIssue>({
  seedCandidate: { answer: "" },
  iterations: 5,
  parentsPerIteration: 1,
  generators: [
    {
      name: "single-llm-generator",
      async generate({ parent, sampledIssues }) {
        const prompt = [
          "Improve this answer using the issues.",
          `Current: ${parent.candidate.answer}`,
          `Issues: ${JSON.stringify(sampledIssues)}`,
        ].join("\n");
        const answer = await callModel(prompt);
        return [{ candidate: { answer }, changeSummary: "Applied issue-guided rewrite" }];
      },
    },
  ],
  async verifyGeneratedCandidate({ proposal }) {
    return proposal.candidate.answer.length > 20;
  },
  async assessCandidate({ candidate }) {
    const score = deterministicScore(candidate.answer); // your rules/tests
    return {
      score,
      trainableIssues: collectIssues(candidate.answer),
      isViable: score >= 0.3,
    };
  },
});
```

When to use:
- straightforward text/spec refinement
- low orchestration overhead with strict validators

### 2) Medium (Typed Issues + Post-Check Gate)
Use this when malformed outputs are common and expensive to fully assess.

```ts
type LessonIssue = {
  issueId?: string;
  issueType?: "plan" | "quiz_mix" | "tests";
  summary?: string;
};

await runCandidateEvolution<{ lessonJson: string }, LessonIssue>({
  seedCandidate: { lessonJson: "{}" },
  iterations: 10,
  parentsPerIteration: 2,
  batchSize: 2,
  generators: [quizGenerator, codingGenerator],
  async verifyGeneratedCandidate({ proposal }) {
    // Cheap structural pre-check before full grading.
    return proposal.candidate.lessonJson.includes("\"plan\"");
  },
  async assessCandidate({ candidate }) {
    // Full expensive grading/scoring.
    return gradeLesson(candidate.lessonJson);
  },
});
```

When to use:
- medium-cost graders
- frequent syntactic/shape failures

### 3) Advanced (Multiple Generators, Weighted Issues, Snapshot Telemetry)
Use for production-scale prompt/spec optimization.

```ts
await runCandidateEvolution<MyCandidate, MyIssue, MyAssessment>({
  seedCandidate,
  iterations: 30,
  parentsPerIteration: 4,
  batchSize: 3,
  generationConcurrency: 8,
  assessmentConcurrency: 6,
  parentSelection: {
    sharpness: 12,
    midpoint: { mode: "percentile", percentile: 80 },
    noveltyWeight: 1.2,
    replace: true,
  },
  feedbackScope: { mode: "neighborhood", maxDistance: 2 },
  generators: [
    strategyGenerator,
    compressionGenerator,
    verifierRepairGenerator,
  ],
  assessCandidate,
  verifyGeneratedCandidate,
  onSnapshot(snapshot) {
    console.log(
      `iter=${snapshot.iteration} archive=${snapshot.archiveSize} best=${snapshot.bestScore.toFixed(3)}`,
    );
  },
});
```

When to use:
- noisy verifiers
- many issue types
- need for exploration + exploitation balance

### 4) Production Lesson Generation (Spark-Style Bundle)
Use this for the lesson benchmark that generates:
- session structure
- quizzes
- coding problems
- delegation evidence/traces

```ts
type LessonBundle = {
  sessionJson: string;
  quizJsonById: Record<string, string>;
  problemJsonById: Record<string, string>;
};

type LessonIssue = {
  issueId?: string;
  issueType?: "schema" | "plan" | "quiz_mix" | "pedagogy" | "consistency";
  summary?: string;
};

await runCandidateEvolution<LessonBundle, LessonIssue>({
  seedCandidate: initialLessonBundle(),
  iterations: 8,
  parentsPerIteration: 3,
  batchSize: 2,
  generationConcurrency: 6,
  assessmentConcurrency: 4,
  feedbackScope: { mode: "ancestors", maxDepth: 3 },
  generators: [
    planGenerator, // edits session plan + sequencing
    quizGenerator, // edits question mix + progression
    codingProblemGenerator, // edits problem specs/tests
    consistencyRepairGenerator, // cross-file consistency pass
  ],
  async verifyGeneratedCandidate({ proposal }) {
    return quickStructuralGate(proposal.candidate); // parse + required files + plan count
  },
  async assessCandidate({ candidate }) {
    // Typical stack:
    // 1) JSON schema validation
    // 2) deterministic rubric checks
    // 3) judge model passes for flow/consistency/pedagogy
    return assessLessonBundle(candidate);
  },
  onSnapshot(s) {
    appendSnapshotLog(s);
  },
});
```

Recommended evolution setup for speed + quality:
- keep one strong generator model (`chatgpt-gpt-5.3-codex`) for mutations
- keep judge passes isolated in assessor path
- fail fast in post-check so invalid bundles do not reach expensive grading
- enforce early subagent delegation in generation prompt and require evidence file

---

## Tuning Guide

If quality stalls:
- increase `noveltyWeight`
- increase `parentsPerIteration`
- widen feedback scope (`ancestors` -> `neighborhood`)

If cost is too high:
- lower `iterations`
- lower generation/assessment concurrency
- add/strengthen `verifyGeneratedCandidate`

If candidates diverge into low quality:
- increase `sharpness`
- raise midpoint percentile
- reduce generator strategies that over-mutate

If loops repeat same mistakes:
- keep richer `changeSummary`
- improve `describeObservedOutcome`
- ensure verifier emits stable issue ids/types

If runtime exceeds target wall-clock:
- reduce generations that trigger expensive judge passes
- increase post-check strictness to block low-quality proposals earlier
- cap iterations and raise parent quality threshold
- inspect trace timing by stage and parallelize slow independent checks

---

## Practical Patterns

For Spark-like lesson creation:
- candidate = lesson artifact bundle (session + quizzes + coding problems)
- assessment = schema validity + rubric score + issue list by category
- generators = role-specialized subagents (plan, quiz, coding, final consistency)
- post-check = cheap schema/shape gate before expensive rubric judge
- feedback scope = `ancestors` or `neighborhood` to retain recent repair memory

For code-spec generation:
- candidate = problem spec + tests + reference solution
- assessment = solvability + test quality + hidden-test coverage
- post-check = parser/executor sanity check

For parallel subagent enforcement:
- instruct generator prompt to identify independent workstreams before writing content
- require explicit delegation evidence artifact (subagent ids + owned outputs)
- add an assessment penalty when delegation evidence is missing/incomplete
- trace spawn/tool ordering to verify delegation happened early

---

## Why This Is Better Than a Plain Retry Loop
A plain retry loop forgets history and explores narrowly.

This framework improves by design:
- **selection pressure** toward better candidates
- **issue-directed mutation** instead of blind rewrites
- **persistent feedback memory** to avoid repeated failures
- **parallel generation** for throughput and diversity
- **structured telemetry** for tuning and debugging
