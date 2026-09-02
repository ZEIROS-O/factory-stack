"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECEIPT_BEGIN, RECEIPT_END, parseExecutionReceiptClaims, buildExecutionReceipt,
  loadExecutionReceiptForReview,
} = require("../../lib/execution-receipt");
const { hashValue } = require("../../lib/util");

const objective = {
  objectiveId: "ZEI-1", revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64), criteriaHash: "sha256:" + "b".repeat(64),
  repository: { baseCommit: "3cb8238", branch: "paperclip/ZEI-1" },
  limits: { costCeilingUsd: 4 },
};
const claims = {
  schemaVersion: "ExecutionReceiptClaimsV1",
  objective: { objectiveId: "ZEI-1", revision: 1, objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash },
  repository: {
    baseCommit: "3cb8238", headCommit: "3cb8238", branch: "paperclip/ZEI-1",
    diffHash: "sha256:" + "c".repeat(64),
    paths: [{ path: "bin/view.py", sha256: "sha256:" + "d".repeat(64) }],
  },
  checks: [], observations: ["implemented"], conclusions: ["ready"],
  unresolvedConditions: [], warnings: [], terminal: { status: "ready_for_review", stopReason: "completed" },
};
const run = {
  id: "run-1", status: "succeeded", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:01:00.000Z",
  sessionIdAfter: "omp-session-1", usageJson: { costStatus: "reported", costUsd: 1.25 },
  contextSnapshot: { issueId: "issue-1", paperclipWorkspace: { cwd: "/tmp/wt", worktreePath: "/tmp/wt", branchName: "paperclip/ZEI-1" } },
  resultJson: { stopReason: "stop" },
};

test("a framed Engineer output is parsed exactly once and composed with authoritative run facts", () => {
  const summary = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  const parsed = parseExecutionReceiptClaims(summary);
  const receipt = buildExecutionReceipt({ run, issueId: "issue-1", objective, claims: parsed });

  assert.equal(receipt.schemaVersion, "ExecutionReceiptV1");
  assert.equal(receipt.receiptId, "run-1");
  assert.equal(receipt.execution.runId, "run-1");
  assert.equal(receipt.execution.workspace, "/tmp/wt");
  assert.equal(receipt.execution.durationSeconds, 60);
  assert.deepEqual(receipt.usage, { costStatus: "known", costUsd: 1.25, costCeilingUsd: 4 });
  assert.match(hashValue(receipt), /^sha256:[0-9a-f]{64}$/);
});

test("review resolves the latest succeeded return-assignee run from the current issue", async () => {
  const framed = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  const issue = { id: "issue-1", executionState: { returnAssignee: { type: "agent", agentId: "engineer-1" } } };
  const calls = [];
  const api = { get: async (path) => {
    calls.push(path);
    if (path === "/api/issues/issue-1/runs") return [
      { runId: "reviewer-run", agentId: "reviewer-1", status: "running", createdAt: "2026-08-31T10:02:00Z" },
      { runId: "run-1", agentId: "engineer-1", status: "succeeded", createdAt: "2026-08-31T10:00:00Z" },
    ];
    if (path === "/api/heartbeat-runs/run-1") return { ...run, resultJson: { ...run.resultJson, summary: framed } };
    throw new Error(path);
  },
  // The objective document, read to settle the binding from the control plane
  // rather than from the agent's transcription of it.
  getOptional: async (path) => {
    calls.push(path);
    if (path === "/api/issues/issue-1/documents/spec") {
      return { key: "spec", latestRevisionNumber: 1, updatedAt: "2026-08-31T09:00:00.000Z" };
    }
    return null;
  } };

  const loaded = await loadExecutionReceiptForReview({ api, issue, objective });
  assert.equal(loaded.receipt.execution.runId, "run-1");
  assert.equal(loaded.receiptHash, hashValue(loaded.receipt));
  assert.equal(loaded.bindingSource, "receiptClaims", "a complete correct echo binds from the claims");
  assert.deepEqual(calls, [
    "/api/issues/issue-1/runs",
    "/api/heartbeat-runs/run-1",
    "/api/issues/issue-1/documents/spec",
  ]);
});

test("receipt composition refuses wrong issue, unknown cost, and duplicate frames", () => {
  const framed = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  assert.throws(() => parseExecutionReceiptClaims(`${framed}\n${framed}`), /exactly one/i);
  assert.throws(() => buildExecutionReceipt({ run, issueId: "other", objective, claims }), /issue/i);
  assert.throws(() => buildExecutionReceipt({ run: { ...run, usageJson: { costStatus: "unpriced" } }, issueId: "issue-1", objective, claims }), /known cost/i);
});

test("an over-ceiling run still produces a receipt; the ceiling is RECORDED, not enforced", () => {
  // The old behaviour threw here, which made an expensive run's receipt
  // unbuildable — so the Reviewer could not read it and the paid-for work became
  // unreachable. The spend has already happened by this point; refusing the
  // receipt cannot recover a dollar of it, it only guarantees nothing is
  // returned for it. Cost is reported for visibility and judged by a human.
  const overRun = { ...run, usageJson: { costStatus: "reported", costUsd: 4.01 } };
  const receipt = buildExecutionReceipt({ run: overRun, issueId: "issue-1", objective, claims });
  assert.deepEqual(receipt.usage, { costStatus: "known", costUsd: 4.01, costCeilingUsd: 4 });
  assert.ok(receipt.usage.costUsd > receipt.usage.costCeilingUsd,
    "the overage stays visible in the receipt rather than being erased");
});

test("an objective with no declared ceiling is still refused: the schema requires the field", () => {
  const noCeiling = { ...objective, limits: { ...objective.limits, costCeilingUsd: undefined } };
  assert.throws(
    () => buildExecutionReceipt({ run, issueId: "issue-1", objective: noCeiling, claims }),
    /no declared cost ceiling/i,
  );
});

test("an abbreviated objective baseCommit matches the full sha a run reports", () => {
  // ZEI-1 declares baseCommit "3cb8238"; the run reports the full 40-char sha.
  // Under strict equality those can never match, so no Engineer output could
  // satisfy the binding check.
  const full = "3cb823840d5512e8ebcd0798a96dad7589782528";
  const abbrevObjective = { ...objective, repository: { ...objective.repository, baseCommit: full.slice(0, 7) } };
  const fullClaims = { ...claims, repository: { ...claims.repository, baseCommit: full } };
  const receipt = buildExecutionReceipt({ run, issueId: "issue-1", objective: abbrevObjective, claims: fullClaims });
  assert.equal(receipt.execution.baseCommit, full);
});

test("commit matching does not accept a too-short or non-hex prefix", () => {
  const full = "3cb823840d5512e8ebcd0798a96dad7589782528";
  for (const bad of ["3cb", "zzz3cb8", "", "3cb8238-dirty"]) {
    assert.throws(
      () => buildExecutionReceipt({
        run, issueId: "issue-1",
        objective: { ...objective, repository: { ...objective.repository, baseCommit: bad } },
        claims: { ...claims, repository: { ...claims.repository, baseCommit: full } },
      }),
      /repository binding/i,
      `"${bad}" must not be accepted as a commit name`,
    );
  }
});

test("a genuinely different commit is still rejected", () => {
  assert.throws(
    () => buildExecutionReceipt({
      run, issueId: "issue-1",
      objective: { ...objective, repository: { ...objective.repository, baseCommit: "9999999" } },
      claims: { ...claims, repository: { ...claims.repository, baseCommit: "3cb823840d5512e8ebcd0798a96dad7589782528" } },
    }),
    /repository binding/i,
  );
});
