# Generic Subagent Candidate Improvement Framework

## Goal
Build a reusable framework for tasks that have:
- a **generation prompt** (produce a candidate solution), and
- a **verification prompt/spec** (score and diagnose candidate quality).

The framework should run with role-specialized subagents, keep feedback, and iterate toward better candidates.

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
Flow: explicit stages with cached outputs and downstream invalidation on failure (similar to Spark pipeline orchestration).

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
- Mostly optimized for fixed workflows, not open-ended search.

Best for:
- Product pipelines with expensive, restart-prone long runs.

### 3) Weighted Candidate Archive with Parallel Subagent Mutation (Chosen)
Flow: maintain an archive of candidates, select promising parents, generate variants from sampled issues, optionally pre-check, fully verify, and add accepted variants.

How it works:
- Keep all assessed candidates in an archive.
- Parent sampling weight = quality sigmoid * novelty bonus.
- Sample issue batches by issue type.
- Run multiple generator subagents in parallel per parent.
- Pass learning feedback from prior attempts (ancestor/neighborhood scope).
- Optional post-generation pre-check before full verification.

Pros:
- Tolerates noisy mutation and verification.
- Balances exploitation (high-score parents) with exploration (novelty).
- Naturally parallel.
- Generalizes across tasks where verifier returns structured issues.

Cons:
- More moving parts than linear loops.
- Requires careful stats/telemetry to tune.

Best for:
- Open-ended prompt/code/spec optimization where reliability comes from repeated selection.

### 4) Tournament Bracket + Bandit Routing
Flow: generators produce candidates, pairwise/tournament verifier compares candidates, bandit allocates budget to higher-yield generators.

How it works:
- Treat verifier as comparative judge rather than absolute scorer.
- Multi-armed bandit routes calls to generator strategies with best win-rate.
- Keep only top candidates per round.

Pros:
- Can reduce score calibration sensitivity.
- Adapts budget toward productive generators.

Cons:
- Harder to preserve rich failure diagnostics.
- Comparative judgments may be unstable/transitive issues.
- More complex to reason about for users.

Best for:
- Creative generation where ranking is easier than absolute scoring.

## Comparison Summary

| Option | Reliability under noise | Exploration | Operational complexity | Fit for generic generation+verification |
|---|---|---|---|---|
| 1. Single-path repair | Low-Medium | Low | Low | Medium |
| 2. Stage DAG + checkpoints | Medium-High | Low-Medium | High | Medium-High |
| 3. Weighted archive + parallel mutation | High | High | Medium-High | **High** |
| 4. Tournament + bandit | Medium | High | High | Medium |

## Selected Approach
**Option 3** is the best default framework.

Why:
- It captures the strongest part of the Darwinian-style algorithm (selection + parallel variation + retention of improvements) without domain-specific terminology.
- It cleanly incorporates Spark-like feedback loops: verifier diagnostics feed the next generation wave.
- It remains generic across domains as long as the verifier returns score + actionable issues.
- It supports pluggable subagents and optional post-generation checks.

## Implementation Shape
Implemented in this repo as a generic engine:
- neutral entities: **candidate**, **assessment**, **issue**, **feedback entry**, **generator subagent**.
- configurable knobs:
  - parent sampling (`sharpness`, midpoint strategy, novelty weight),
  - issue batching (`batchSize`, issue-type weights),
  - feedback visibility scope (`none`, `ancestors`, `neighborhood`),
  - optional post-generation verification gate,
  - generation/verification concurrency.
- outputs:
  - archive of candidates with lineage,
  - per-iteration snapshots,
  - aggregate stats,
  - post-check rejections log.

This provides a reusable, subagent-ready generation/verification optimization loop without Darwinian naming.
