"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  RECEIPT_BEGIN, RECEIPT_END, parseExecutionReceiptClaims, buildExecutionReceipt,
  loadExecutionReceiptForReview, knownRunCost,
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

// A ready-for-review receipt now requires the run's goal gate (the run's own
// runtime witness — see lib/goal-gate.js), so every fixture that builds one
// carries a fully valid gate.
const goalGate = {
  schemaVersion: "EngineerGoalGateV1",
  runId: "run-1", taskId: "issue-1", sessionId: "omp-session-1", goalId: "goal-1",
  goalObjectiveHash: objective.objectiveHash,
  objectiveId: "ZEI-1", revision: 1,
  objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  goalStatus: "complete", continuations: 1, terminal: true,
  observedAt: "2026-09-02T10:00:00.000Z",
};
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-receipt-"));
fs.writeFileSync(path.join(sessionDir, "goal-gate-run-1.json"), JSON.stringify(goalGate));
test.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

const run = {
  id: "run-1", status: "succeeded", startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:01:00.000Z",
  sessionIdAfter: "omp-session-1", usageJson: { costStatus: "reported", costUsd: 1.25 },
  contextSnapshot: { issueId: "issue-1", paperclipWorkspace: { cwd: "/tmp/wt", worktreePath: "/tmp/wt", branchName: "paperclip/ZEI-1" } },
  resultJson: { stopReason: "stop" },
  sessionParams: { sessionId: "omp-session-1", cwd: "/tmp/wt", sessionDir },
};

test("a framed Engineer output is parsed exactly once and composed with authoritative run facts", () => {
  const summary = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  const parsed = parseExecutionReceiptClaims(summary);
  const receipt = buildExecutionReceipt({ run, issueId: "issue-1", objective, claims: parsed, goalGate });

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
  // The gate is loaded from the run's own session directory and threaded
  // through, so the Reviewer path receives it without asking.
  assert.deepEqual(loaded.goalGate, goalGate);
  assert.equal(loaded.goalGatePath, path.join(sessionDir, "goal-gate-run-1.json"));
  // The receipt DOCUMENT is consulted first; this fixture has none, so the
  // loader falls back to the text frame in the run summary. Both paths must
  // work: the document is how receipts arrive now, the frame is how every run
  // before `paperclip_receipt` recorded itself.
  assert.deepEqual(calls, [
    "/api/issues/issue-1/runs",
    "/api/heartbeat-runs/run-1",
    "/api/issues/issue-1/documents/execution-receipt",
    "/api/issues/issue-1/documents/spec",
  ]);
});

test("a receipt document is preferred over the run summary's text frame", async () => {
  // The point of the tool: the Engineer never has to emit a byte-exact frame.
  const issue = { id: "issue-1", executionState: { returnAssignee: { type: "agent", agentId: "engineer-1" } } };
  const api = {
    get: async (path) => {
      if (path === "/api/issues/issue-1/runs") return [
        { runId: "run-1", agentId: "engineer-1", status: "succeeded", createdAt: "2026-08-31T10:00:00Z" },
      ];
      if (path === "/api/heartbeat-runs/run-1") {
        // A summary of prose with NO frame — the exact 2026-09-02 canary shape.
        return { ...run, resultJson: { ...run.resultJson, summary: "Fix landed, criterion passes." } };
      }
      throw new Error(path);
    },
    getOptional: async (path) => {
      if (path === "/api/issues/issue-1/documents/execution-receipt") {
        return { body: JSON.stringify({ runId: "run-1", claims }) };
      }
      if (path === "/api/issues/issue-1/documents/spec") {
        return { key: "spec", latestRevisionNumber: 1, updatedAt: "2026-08-31T09:00:00.000Z" };
      }
      return null;
    },
  };
  const loaded = await loadExecutionReceiptForReview({ api, issue, objective });
  assert.equal(loaded.receiptSource, "documents/execution-receipt");
  assert.equal(loaded.receipt.execution.runId, "run-1");
});

test("a receipt document from a DIFFERENT run is ignored, not read as this one's", async () => {
  // A stale receipt approving new work is the failure this guards.
  const framed = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  const issue = { id: "issue-1", executionState: { returnAssignee: { type: "agent", agentId: "engineer-1" } } };
  const api = {
    get: async (path) => {
      if (path === "/api/issues/issue-1/runs") return [
        { runId: "run-1", agentId: "engineer-1", status: "succeeded", createdAt: "2026-08-31T10:00:00Z" },
      ];
      if (path === "/api/heartbeat-runs/run-1") return { ...run, resultJson: { ...run.resultJson, summary: framed } };
      throw new Error(path);
    },
    getOptional: async (path) => {
      if (path === "/api/issues/issue-1/documents/execution-receipt") {
        return { body: JSON.stringify({ runId: "some-older-run", claims }) };
      }
      if (path === "/api/issues/issue-1/documents/spec") {
        return { key: "spec", latestRevisionNumber: 1, updatedAt: "2026-08-31T09:00:00.000Z" };
      }
      return null;
    },
  };
  const loaded = await loadExecutionReceiptForReview({ api, issue, objective });
  assert.equal(loaded.receiptSource, "resultJson.summary",
    "a receipt belonging to another run must not stand in for this run's account");
});

test("a malformed receipt document refuses rather than falling back", async () => {
  // Two disagreeing accounts of one run is worse than one missing account.
  const framed = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  const issue = { id: "issue-1", executionState: { returnAssignee: { type: "agent", agentId: "engineer-1" } } };
  const api = {
    get: async (path) => {
      if (path === "/api/issues/issue-1/runs") return [
        { runId: "run-1", agentId: "engineer-1", status: "succeeded", createdAt: "2026-08-31T10:00:00Z" },
      ];
      if (path === "/api/heartbeat-runs/run-1") return { ...run, resultJson: { ...run.resultJson, summary: framed } };
      throw new Error(path);
    },
    getOptional: async (path) =>
      path === "/api/issues/issue-1/documents/execution-receipt" ? { body: "{not json" } : null,
  };
  await assert.rejects(() => loadExecutionReceiptForReview({ api, issue, objective }), /not valid JSON/);
});

test("the review load reports an absent gate without refusing the run", async () => {
  // The gate file is per-run; a session directory without this run's gate
  // means the run's own runtime never proved its goal complete.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-receipt-nogate-"));
  const gatelessRun = { ...run, sessionParams: { ...run.sessionParams, sessionDir: emptyDir } };
  const framed = `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`;
  const issue = { id: "issue-1", executionState: { returnAssignee: { type: "agent", agentId: "engineer-1" } } };
  const api = {
    get: async (p) => {
      if (p === "/api/issues/issue-1/runs") return [{ runId: "run-1", agentId: "engineer-1", status: "succeeded", createdAt: "2026-08-31T10:00:00Z" }];
      if (p === "/api/heartbeat-runs/run-1") return { ...gatelessRun, resultJson: { ...gatelessRun.resultJson, summary: framed } };
      throw new Error(p);
    },
    getOptional: async () => null,
  };
  // ADVISORY: an absent gate no longer refuses the load.
  const loaded = await loadExecutionReceiptForReview({ api, issue, objective });
  assert.equal(loaded.goalGate, null, "the absent gate is reported as absent, not thrown on");
  assert.ok(loaded.receipt, "the receipt is still built so the Reviewer can judge the real evidence");
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test("every terminal status builds a receipt; the gate gates nothing", () => {
  // The new admissibility rule: only the status that hands work to the
  // Reviewer demands the run's own proof of goal completion. An attempt that
  // legitimately blocks must still be able to report, and a gate can never
  // upgrade a blocked receipt into a ready one.
  // CONTRACT CHANGED 2026-09-02: the goal gate is ADVISORY, not a refusal.
  // Downgraded once we established the Engineer's shell can write the same
  // path the extension writes, making it corroboration rather than proof. The
  // pipeline must not halt on it; the Reviewer's independent execution of the
  // acceptance commands and promotion's byte comparison are what admit work,
  // and both are asserted elsewhere.
  assert.ok(
    buildExecutionReceipt({ run, issueId: "issue-1", objective, claims }),
    "a ready-for-review receipt builds without a gate; the gate is recorded, not required",
  );
  for (const status of ["blocked", "failed", "cancelled"]) {
    const terminalClaims = { ...claims, terminal: { status, stopReason: "blocked" } };
    const receipt = buildExecutionReceipt({ run, issueId: "issue-1", objective, claims: terminalClaims });
    assert.equal(receipt.terminal.status, status);
  }
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
  const receipt = buildExecutionReceipt({ run: overRun, issueId: "issue-1", objective, claims, goalGate });
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
  const receipt = buildExecutionReceipt({ run, issueId: "issue-1", objective: abbrevObjective, claims: fullClaims, goalGate });
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

// ── knownRunCost against the REAL run-ledger shape ──────────────────────────
//
// Every fixture above invents `usageJson.costStatus: "reported"`. Paperclip
// never sets that field. It exists only in the receipts this module WRITES
// (`usage: { costStatus: "known", ... }`), so the reader was checking the run
// ledger against its own output schema, and the fixtures agreed with the reader
// because both were written from the same wrong belief — the failure mode
// apply.test.js already names: "a fake that emits X and a client that reads X
// are wrong together".
//
// Measured 2026-09-02 against the live instance: knownRunCost threw on all 24
// runs carrying usage, so `factory promote` could not promote anything.
//
// The invariant worth keeping is "promotion requires a KNOWN cost", not
// "requires a field only we produce". A usable number is the evidence; a
// costStatus that says otherwise still refuses.

const REAL_USAGE = {
  costUsd: 0.8923949999999999,
  cost_usd: 0.8923949999999999,
  billingType: "unknown",
  inputTokens: 24577,
  outputTokens: 2333,
  total_cost_usd: 0.8923949999999999,
  cachedInputTokens: 1399040,
  cache_read_input_tokens: 1399040,
};

test("knownRunCost accepts Paperclip's real usageJson, which carries no costStatus", () => {
  assert.equal(knownRunCost({ usageJson: REAL_USAGE }), 0.8923949999999999);
});

test("knownRunCost still accepts the shape the receipts themselves write", () => {
  assert.equal(knownRunCost({ usageJson: { costStatus: "reported", costUsd: 1.25 } }), 1.25);
});

test("a zero-cost run has a known cost — free is a number, not an absence", () => {
  assert.equal(knownRunCost({ usageJson: { costUsd: 0 } }), 0);
});

test("knownRunCost still refuses when the cost is genuinely absent", () => {
  assert.throws(() => knownRunCost({ usageJson: { inputTokens: 10 } }), /known cost/i);
  assert.throws(() => knownRunCost({ usageJson: {} }), /known cost/i);
  assert.throws(() => knownRunCost({}), /known cost/i);
});

test("knownRunCost refuses a cost the ledger itself marks unusable", () => {
  // If Paperclip ever does set costStatus, a value that means "not priced" must
  // still refuse — the number alone is not permission when the ledger disputes it.
  for (const costStatus of ["unpriced", "unknown", "estimated", "pending"]) {
    assert.throws(
      () => knownRunCost({ usageJson: { costStatus, costUsd: 1.25 } }),
      /known cost/i,
      `expected costStatus "${costStatus}" to refuse`);
  }
});

test("knownRunCost refuses a nonsense number rather than promoting on it", () => {
  for (const costUsd of [-1, NaN, Infinity, "1.25", null]) {
    assert.throws(() => knownRunCost({ usageJson: { costUsd } }), /known cost/i,
      `expected ${JSON.stringify(costUsd)} to refuse`);
  }
});
