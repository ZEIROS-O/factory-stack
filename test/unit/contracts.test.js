"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  loadContract,
  validateContract,
  verifyObjectiveHashes,
} = require("../../lib/contracts");

const ROOT = path.resolve(__dirname, "../..");

test("ObjectiveEnvelopeV1 validates the committed ZEI-1 objective and its independent hashes", () => {
  const objective = loadContract(path.join(ROOT, "contracts/objectives/ZEI-1.json"), "ObjectiveEnvelopeV1");
  assert.equal(objective.repository.baseCommit, "3cb8238");
  assert.equal(objective.limits.wallClockMinutes, 45);
  assert.equal(objective.limits.costCeilingUsd, 4);
  assert.equal(objective.limits.outerFactoryCostCeilingUsd, 5);
  assert.deepEqual(objective.acceptanceCriteria.map((c) => c.id), [
    "ZEI-1-AC-01", "ZEI-1-AC-02", "ZEI-1-AC-03",
    "ZEI-1-AC-04", "ZEI-1-AC-05", "ZEI-1-AC-06",
  ]);
  assert.ok(objective.acceptanceCriteria.every((c) => Array.isArray(c.command.argv)));
  assert.doesNotThrow(() => verifyObjectiveHashes(objective));
});

test("ObjectiveEnvelopeV1 rejects shell-string acceptance commands", () => {
  const objective = loadContract(path.join(ROOT, "contracts/objectives/ZEI-1.json"), "ObjectiveEnvelopeV1");
  objective.acceptanceCriteria[0].command = "python3 -m pytest -q";
  assert.throws(() => validateContract("ObjectiveEnvelopeV1", objective), /acceptanceCriteria/);
});

test("ExecutionReceiptV1 supports an uncommitted handoff only with exact diff and path hashes", () => {
  const receipt = {
    schemaVersion: "ExecutionReceiptV1",
    receiptId: "attempt-001",
    objective: {
      objectiveId: "ZEI-1", revision: 1,
      objectiveHash: "sha256:" + "1".repeat(64),
      criteriaHash: "sha256:" + "2".repeat(64),
    },
    execution: {
      sessionId: "session-001", sessionPath: "/tmp/session-001",
      workspace: "/worktrees/ZEI-1", branch: "paperclip/ZEI-1",
      baseCommit: "3cb8238", headCommit: "3cb8238",
      startedAt: "2026-08-31T12:00:00.000Z", finishedAt: "2026-08-31T12:10:00.000Z",
      durationSeconds: 600,
    },
    changes: {
      committed: false,
      diffHash: "sha256:" + "3".repeat(64),
      paths: [{ path: "bin/view.py", sha256: "sha256:" + "4".repeat(64) }],
    },
    checks: [{
      criterionId: "ZEI-1-AC-01", argv: ["python3", "-m", "pytest", "-q"],
      cwd: "/worktrees/ZEI-1", exitCode: 0,
      stdoutHash: "sha256:" + "5".repeat(64), stderrHash: "sha256:" + "6".repeat(64),
    }],
    observations: ["head equals base because the sandbox cannot write shared Git objects"],
    conclusions: ["the worktree diff is ready for review"],
    unresolvedConditions: [], warnings: [],
    usage: { costStatus: "known", costUsd: 1.25 },
    terminal: { status: "ready_for_review", stopReason: "acceptance checks passed" },
  };
  assert.doesNotThrow(() => validateContract("ExecutionReceiptV1", receipt));
  delete receipt.changes.paths[0].sha256;
  assert.throws(() => validateContract("ExecutionReceiptV1", receipt), /changes/);
});

test("ExecutionReceiptV1 represents unknown cost explicitly rather than as zero", () => {
  const receipt = {
    schemaVersion: "ExecutionReceiptV1", receiptId: "attempt-002",
    objective: { objectiveId: "ZEI-1", revision: 1, objectiveHash: "sha256:" + "1".repeat(64), criteriaHash: "sha256:" + "2".repeat(64) },
    execution: { sessionId: "s", sessionPath: "/tmp/s", workspace: "/w", branch: "paperclip/ZEI-1", baseCommit: "3cb8238", headCommit: "3cb8238", startedAt: "2026-08-31T12:00:00.000Z", finishedAt: "2026-08-31T12:00:01.000Z", durationSeconds: 1 },
    changes: { committed: false, diffHash: "sha256:" + "3".repeat(64), paths: [] },
    checks: [], observations: [], conclusions: [], unresolvedConditions: [], warnings: [],
    usage: { costStatus: "unknown", costUsd: null },
    terminal: { status: "blocked", stopReason: "provider did not report cost" },
  };
  assert.doesNotThrow(() => validateContract("ExecutionReceiptV1", receipt));
  receipt.usage.costUsd = 0;
  assert.throws(() => validateContract("ExecutionReceiptV1", receipt), /usage/);
});

test("AssessmentV1 requires one structured criterion verdict and argv results", () => {
  const assessment = {
    schemaVersion: "AssessmentV1", assessmentId: "assessment-001",
    objective: { objectiveId: "ZEI-1", revision: 1, objectiveHash: "sha256:" + "1".repeat(64), criteriaHash: "sha256:" + "2".repeat(64) },
    executionReceiptHash: "sha256:" + "3".repeat(64),
    reviewer: { agentName: "OMP Reviewer", modelFamily: "openai-codex" },
    repository: { baseCommit: "3cb8238", headCommit: "3cb8238", diffHash: "sha256:" + "4".repeat(64), changedPaths: ["bin/view.py"] },
    deterministicResults: [{ criterionId: "ZEI-1-AC-01", argv: ["python3", "-m", "pytest", "-q"], exitCode: 0, passed: true, outputHash: "sha256:" + "5".repeat(64) }],
    criteria: [{ criterionId: "ZEI-1-AC-01", verdict: "PASS", evidenceRefs: ["check:ZEI-1-AC-01"], reasoning: "The independent command passed.", uncertainty: null }],
    overallVerdict: "PASS", assessedAt: "2026-08-31T12:30:00.000Z",
  };
  assert.doesNotThrow(() => validateContract("AssessmentV1", assessment));
  delete assessment.criteria[0].verdict;
  assert.throws(() => validateContract("AssessmentV1", assessment), /criteria/);
});
