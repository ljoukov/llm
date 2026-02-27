import { describe, expect, it, vi } from "vitest";

import {
  runCandidateEvolution,
  type CandidateAssessment,
  type CandidateIssue,
} from "../src/index.js";

type TestIssue = CandidateIssue & {
  readonly issueId: string;
  readonly issueType: string;
};

type TestAssessment = CandidateAssessment<TestIssue>;

function randomSequence(values: readonly number[], fallback = 0.5): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value ?? fallback;
  };
}

function issue(issueId: string, issueType: string): TestIssue {
  return {
    issueId,
    issueType,
    summary: `${issueType}:${issueId}`,
  };
}

describe("runCandidateEvolution", () => {
  it("supports mixed generator batching behavior", async () => {
    const assessments = new Map<string, TestAssessment>([
      ["seed", { score: 0.3, trainableIssues: [issue("i1", "logic"), issue("i2", "logic")] }],
      ["single-1", { score: 0.5, trainableIssues: [] }],
      ["batch-1", { score: 0.6, trainableIssues: [] }],
    ]);

    const assessCandidate = vi.fn(async ({ candidate }: { candidate: string }) => {
      const result = assessments.get(candidate);
      if (!result) {
        throw new Error(`Unknown candidate: ${candidate}`);
      }
      return result;
    });

    const seenIssueCounts: number[] = [];

    const result = await runCandidateEvolution<string, TestIssue, TestAssessment>({
      seedCandidate: "seed",
      assessCandidate,
      generators: [
        {
          name: "single",
          supportsIssueBatch: false,
          generate: async (input) => {
            seenIssueCounts.push(input.sampledIssues.length);
            return [{ candidate: "single-1", changeSummary: "single change" }];
          },
        },
        {
          name: "batch",
          supportsIssueBatch: true,
          generate: async (input) => {
            seenIssueCounts.push(input.sampledIssues.length);
            return [{ candidate: "batch-1", changeSummary: "batch change" }];
          },
        },
      ],
      iterations: 1,
      parentsPerIteration: 1,
      batchSize: 2,
      random: randomSequence([0.1, 0.1, 0.1, 0.1]),
    });

    expect(seenIssueCounts).toEqual([1, 2]);
    expect(result.archive).toHaveLength(3);
    expect(result.totalStats.assessmentCalls).toBe(3);
    expect(result.totalStats.generationCalls).toBe(2);
    expect(result.totalStats.issuesSupplied).toBe(3);
  });

  it("filters proposals via post-generation check before full assessment", async () => {
    const assessments = new Map<string, TestAssessment>([
      ["seed", { score: 0.2, trainableIssues: [issue("i1", "logic")] }],
      ["pass", { score: 0.9, trainableIssues: [] }],
    ]);

    const assessCandidate = vi.fn(async ({ candidate }: { candidate: string }) => {
      const result = assessments.get(candidate);
      if (!result) {
        throw new Error(`Unexpected assessment call for candidate '${candidate}'.`);
      }
      return result;
    });

    const result = await runCandidateEvolution<string, TestIssue, TestAssessment>({
      seedCandidate: "seed",
      assessCandidate,
      generators: [
        {
          name: "g",
          generate: async () => [
            { candidate: "pass", changeSummary: "good change" },
            { candidate: "blocked", changeSummary: "bad change" },
          ],
        },
      ],
      verifyGeneratedCandidate: async ({ proposal }) => proposal.candidate !== "blocked",
      iterations: 1,
      parentsPerIteration: 1,
      random: randomSequence([0.2, 0.2, 0.2]),
    });

    expect(assessCandidate).toHaveBeenCalledTimes(2);
    expect(result.archive.map((entry) => entry.candidate)).toEqual(["seed", "pass"]);
    expect(result.postCheckRejections).toHaveLength(1);
    expect(result.postCheckRejections[0]?.candidate).toBe("blocked");

    const iterationOne = result.snapshots.find((snapshot) => snapshot.iteration === 1);
    expect(iterationOne?.stats.postCheckCalls).toBe(2);
    expect(iterationOne?.stats.proposalsAfterPostCheck).toBe(1);
    expect(iterationOne?.stats.assessmentCalls).toBe(1);
  });

  it("supplies ancestor feedback entries to later generations", async () => {
    const assessments = new Map<string, TestAssessment>([
      ["seed", { score: 0.2, trainableIssues: [issue("seed-issue", "logic")] }],
      ["v1", { score: 0.9, trainableIssues: [issue("v1-issue", "logic")] }],
      ["v2", { score: 1.0, trainableIssues: [] }],
    ]);

    const assessCandidate = vi.fn(async ({ candidate }: { candidate: string }) => {
      const result = assessments.get(candidate);
      if (!result) {
        throw new Error(`Unknown candidate: ${candidate}`);
      }
      return result;
    });

    const seenFeedback: string[][] = [];
    let call = 0;

    const result = await runCandidateEvolution<string, TestIssue, TestAssessment>({
      seedCandidate: "seed",
      assessCandidate,
      generators: [
        {
          name: "g",
          generate: async (input) => {
            seenFeedback.push(input.feedbackEntries.map((entry) => entry.attemptedChange));
            call += 1;
            if (call === 1) {
              return [{ candidate: "v1", changeSummary: "change-v1" }];
            }
            return [{ candidate: "v2", changeSummary: "change-v2" }];
          },
        },
      ],
      iterations: 2,
      parentsPerIteration: 1,
      random: randomSequence([0.1, 0.1, 0.95, 0.1, 0.1]),
      feedbackScope: { mode: "ancestors" },
    });

    expect(result.archive.map((entry) => entry.candidate)).toEqual(["seed", "v1", "v2"]);
    expect(seenFeedback[0]).toEqual([]);
    expect(seenFeedback[1]).toContain("change-v1");
    expect(result.feedbackEntries.map((entry) => entry.attemptedChange)).toEqual([
      "change-v1",
      "change-v2",
    ]);
  });

  it("stops early when no eligible parents remain", async () => {
    const assessCandidate = vi.fn(async ({ candidate }: { candidate: string }) => {
      if (candidate !== "seed") {
        throw new Error("No additional candidates should be assessed.");
      }
      return {
        score: 1,
        trainableIssues: [],
      } satisfies TestAssessment;
    });

    const generator = vi.fn(async () => [{ candidate: "unexpected" }]);

    const result = await runCandidateEvolution<string, TestIssue, TestAssessment>({
      seedCandidate: "seed",
      assessCandidate,
      generators: [{ name: "g", generate: generator }],
      iterations: 3,
      parentsPerIteration: 1,
    });

    expect(generator).not.toHaveBeenCalled();
    expect(result.stoppedEarly).toBe(true);
    expect(result.archive).toHaveLength(1);
    expect(result.totalStats.assessmentCalls).toBe(1);
    expect(result.snapshots.map((snapshot) => snapshot.iteration)).toEqual([0, 1]);
  });
});
