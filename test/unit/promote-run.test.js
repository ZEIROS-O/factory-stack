"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { run, computeChangeSet, computeDiffHash } = require("../../lib/promote");
const { RECEIPT_BEGIN, RECEIPT_END, buildExecutionReceipt } = require("../../lib/execution-receipt");
const { hashValue } = require("../../lib/util");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promote-run-"));
  const primary = path.join(root, "primary");
  fs.mkdirSync(primary);
  const g = (...args) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(primary, "bin")); fs.writeFileSync(path.join(primary, "bin/view.py"), "base\n");
  g("add", "-A"); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(primary, "OPERATOR-WIP"), "untouched\n");
  const wt = path.join(root, "wt"); g("worktree", "add", "-q", "-b", "paperclip/ZEI-1", wt);
  fs.writeFileSync(path.join(wt, "bin/view.py"), "fixed\n");
  return { root, primary, wt, base, g, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("run validates evidence, commits exact paths, attaches receipt+commit, then approves", async () => {
  const f = fixture();
  try {
    const objective = {
      objectiveId: "ZEI-1", revision: 1, objectiveHash: "sha256:" + "a".repeat(64), criteriaHash: "sha256:" + "b".repeat(64),
      repository: { path: f.primary, baseCommit: f.base, branch: "paperclip/ZEI-1" },
      permissions: { filesystem: { write: ["bin/view.py"] } }, limits: { costCeilingUsd: 4 },
      acceptanceCriteria: [{ id: "AC-1", command: { argv: ["node", "--version"], cwd: "." } }],
    };
    // The goal gate the Engineer's runtime wrote for this run, on disk where
    // the adapter recorded the session: promotion now requires it.
    const goalGate = {
      schemaVersion: "EngineerGoalGateV1",
      runId: "engineer-run", taskId: "i1", sessionId: "omp-1", goalId: "goal-1",
      goalObjectiveHash: objective.objectiveHash,
      objectiveId: "ZEI-1", revision: 1,
      objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
      goalStatus: "complete", continuations: 1, terminal: true,
      observedAt: "2026-09-02T10:00:00.000Z",
    };
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-gate-"));
    fs.writeFileSync(path.join(sessionDir, "goal-gate-engineer-run.json"), JSON.stringify(goalGate));
    const cs = computeChangeSet(f.wt, f.base);
    const claims = {
      schemaVersion: "ExecutionReceiptClaimsV1",
      objective: { objectiveId: "ZEI-1", revision: 1, objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash },
      repository: { baseCommit: f.base, headCommit: f.base, branch: "paperclip/ZEI-1", diffHash: computeDiffHash(cs), paths: cs.paths },
      checks: [], observations: ["fixed"], conclusions: ["ready"], unresolvedConditions: [], warnings: [],
      terminal: { status: "ready_for_review", stopReason: "complete" },
    };
    const paperclipRun = {
      id: "engineer-run", agentId: "engineer", status: "succeeded",
      startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:01:00.000Z", sessionIdAfter: "omp-1",
      usageJson: { costStatus: "reported", costUsd: 1.5 },
      contextSnapshot: { issueId: "i1", paperclipWorkspace: { cwd: f.wt, worktreePath: f.wt, branchName: "paperclip/ZEI-1" } },
      resultJson: { summary: `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`, stopReason: "stop" },
      sessionParams: { sessionId: "omp-1", cwd: f.wt, sessionDir },
    };
    const executionReceipt = buildExecutionReceipt({ run: paperclipRun, issueId: "i1", objective, claims, goalGate });
    const assessment = {
      schemaVersion: "AssessmentV1", assessmentId: "assessment-reviewer-run",
      objective: executionReceipt.objective, executionRunId: "engineer-run", executionReceiptHash: hashValue(executionReceipt),
      reviewer: { agentName: "OMP Reviewer", modelFamily: "openai-codex" },
      repository: { baseCommit: f.base, headCommit: f.base, diffHash: computeDiffHash(cs), changedPaths: ["bin/view.py"] },
      deterministicResults: [{ criterionId: "AC-1", argv: ["node", "--version"], exitCode: 0, passed: true, outputHash: "sha256:" + "e".repeat(64) }],
      criteria: [{ criterionId: "AC-1", verdict: "PASS", evidenceRefs: ["check"], reasoning: "pass", uncertainty: null }],
      overallVerdict: "PASS", assessedAt: "2026-08-31T10:02:00.000Z",
    };
    let issue = {
      id: "i1", identifier: "ZEI-1", status: "in_review", assigneeUserId: "operator",
      executionState: { currentStageType: "approval", currentParticipant: { type: "user", userId: "operator" }, returnAssignee: { type: "agent", agentId: "engineer" } },
    };
    let promotionDoc = null; let products = [];
    const writes = [];
    const api = {
      health: async () => ({ status: "ok" }),
      getOptional: async (p) => p.includes("/documents/promotion-") ? promotionDoc : null,
      get: async (p) => {
        if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
        if (p === "/api/companies/c1/issues") return [{ id: "i1", identifier: "ZEI-1" }];
        if (p === "/api/issues/i1") return issue;
        if (p === "/api/issues/i1/documents/spec") return { body: "SPEC" };
        if (p === "/api/issues/i1/documents/assessment") return { body: JSON.stringify(assessment) };
        if (p === "/api/issues/i1/runs") return [{ runId: "engineer-run", agentId: "engineer", status: "succeeded" }];
        if (p === "/api/heartbeat-runs/engineer-run") return paperclipRun;
        if (p === "/api/issues/i1/work-products") return products;
        if (p.includes("/documents/promotion-")) return promotionDoc;
        throw new Error(`GET ${p}`);
      },
      mutate: async ({ readPath, writePath, method, body, expect }) => {
        writes.push({ method, path: writePath, body });
        if (method === "PUT") promotionDoc = { body: body.body, latestRevisionId: "rev-1" };
        else if (method === "POST") products.push({ id: "wp-1", ...body });
        else if (method === "PATCH") issue = { ...issue, status: "done", executionState: { status: "completed" } };
        const after = await api.get(readPath);
        for (const e of expect) assert.equal(e.compare ? e.compare(undefined, after) : after[e.path], e.compare ? true : e.value);
        return { before: null, after, verified: true };
      },
    };
    const cfg = {
      _root: path.join(f.root, "factory"), company: { name: "Local Factory" },
      issues: [{ identifier: "ZEI-1", objectiveDocument: { key: "spec", body: "SPEC", objective } }],
    };
    const code = await run(cfg, { _: ["promote", "ZEI-1"], flags: { assessment: hashValue(assessment) } }, {
      connect: () => api, requireHealthy: (x) => x.health(), C: { green: (x) => x, dim: (x) => x },
    });
    assert.equal(code, 0);
    assert.equal(issue.status, "done");
    assert.equal(fs.readFileSync(path.join(f.primary, "OPERATOR-WIP"), "utf8"), "untouched\n");
    assert.deepEqual(f.g("show", "paperclip/ZEI-1", "--name-only", "--format=").trim().split("\n"), ["bin/view.py"]);
    assert.deepEqual(writes.map((w) => w.method), ["PUT", "POST", "PATCH"]);
    assert.ok(fs.readdirSync(path.join(cfg._root, "receipts")).some((n) => n.startsWith("promotion-")));
  } finally { f.cleanup(); }
});

test("promotion refuses a run whose goal gate never completed, before any write", async () => {
  // The gate is the run's own proof. A gate whose goal settled ACTIVE is the
  // extension's honest record of an unfinished attempt, and promotion must
  // refuse on it BEFORE the assessment PUT, the work-product POST, the issue
  // PATCH, or any git command.
  const f = fixture();
  try {
    const objective = {
      objectiveId: "ZEI-1", revision: 1, objectiveHash: "sha256:" + "a".repeat(64), criteriaHash: "sha256:" + "b".repeat(64),
      repository: { path: f.primary, baseCommit: f.base, branch: "paperclip/ZEI-1" },
      permissions: { filesystem: { write: ["bin/view.py"] } }, limits: { costCeilingUsd: 4 },
      acceptanceCriteria: [{ id: "AC-1", command: { argv: ["node", "--version"], cwd: "." } }],
    };
    const cs = computeChangeSet(f.wt, f.base);
    const claims = {
      schemaVersion: "ExecutionReceiptClaimsV1",
      objective: { objectiveId: "ZEI-1", revision: 1, objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash },
      repository: { baseCommit: f.base, headCommit: f.base, branch: "paperclip/ZEI-1", diffHash: computeDiffHash(cs), paths: cs.paths },
      checks: [], observations: ["fixed"], conclusions: ["ready"], unresolvedConditions: [], warnings: [],
      terminal: { status: "ready_for_review", stopReason: "complete" },
    };
    const validGate = {
      schemaVersion: "EngineerGoalGateV1",
      runId: "engineer-run", taskId: "i1", sessionId: "omp-1", goalId: "goal-1",
      goalObjectiveHash: objective.objectiveHash,
      objectiveId: "ZEI-1", revision: 1,
      objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
      goalStatus: "complete", continuations: 1, terminal: true,
      observedAt: "2026-09-02T10:00:00.000Z",
    };
    // On disk, the goal never completed: the gate the control plane will
    // actually load says the attempt settled with its goal still active.
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-gate-"));
    fs.writeFileSync(path.join(sessionDir, "goal-gate-engineer-run.json"),
      JSON.stringify({ ...validGate, goalStatus: "active", terminal: false }));
    const paperclipRun = {
      id: "engineer-run", agentId: "engineer", status: "succeeded",
      startedAt: "2026-08-31T10:00:00.000Z", finishedAt: "2026-08-31T10:01:00.000Z", sessionIdAfter: "omp-1",
      usageJson: { costStatus: "reported", costUsd: 1.5 },
      contextSnapshot: { issueId: "i1", paperclipWorkspace: { cwd: f.wt, worktreePath: f.wt, branchName: "paperclip/ZEI-1" } },
      resultJson: { summary: `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`, stopReason: "stop" },
      sessionParams: { sessionId: "omp-1", cwd: f.wt, sessionDir },
    };
    // The assessment binds to the receipt a VALID gate would have produced;
    // promotion must still refuse, because the gate it loads is not complete.
    const executionReceipt = buildExecutionReceipt({ run: paperclipRun, issueId: "i1", objective, claims, goalGate: validGate });
    const assessment = {
      schemaVersion: "AssessmentV1", assessmentId: "assessment-reviewer-run",
      objective: executionReceipt.objective, executionRunId: "engineer-run", executionReceiptHash: hashValue(executionReceipt),
      reviewer: { agentName: "OMP Reviewer", modelFamily: "openai-codex" },
      repository: { baseCommit: f.base, headCommit: f.base, diffHash: computeDiffHash(cs), changedPaths: ["bin/view.py"] },
      deterministicResults: [{ criterionId: "AC-1", argv: ["node", "--version"], exitCode: 0, passed: true, outputHash: "sha256:" + "e".repeat(64) }],
      criteria: [{ criterionId: "AC-1", verdict: "PASS", evidenceRefs: ["check"], reasoning: "pass", uncertainty: null }],
      overallVerdict: "PASS", assessedAt: "2026-08-31T10:02:00.000Z",
    };
    const issue = {
      id: "i1", identifier: "ZEI-1", status: "in_review", assigneeUserId: "operator",
      executionState: { currentStageType: "approval", currentParticipant: { type: "user", userId: "operator" }, returnAssignee: { type: "agent", agentId: "engineer" } },
    };
    const writes = [];
    const api = {
      health: async () => ({ status: "ok" }),
      getOptional: async () => null,
      get: async (p) => {
        if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
        if (p === "/api/companies/c1/issues") return [{ id: "i1", identifier: "ZEI-1" }];
        if (p === "/api/issues/i1") return issue;
        if (p === "/api/issues/i1/documents/spec") return { body: "SPEC" };
        if (p === "/api/issues/i1/documents/assessment") return { body: JSON.stringify(assessment) };
        if (p === "/api/issues/i1/runs") return [{ runId: "engineer-run", agentId: "engineer", status: "succeeded" }];
        if (p === "/api/heartbeat-runs/engineer-run") return paperclipRun;
        throw new Error(`GET ${p}`);
      },
      mutate: async ({ method }) => { writes.push(method); throw new Error("no write may happen"); },
    };
    const cfg = {
      _root: path.join(f.root, "factory"), company: { name: "Local Factory" },
      issues: [{ identifier: "ZEI-1", objectiveDocument: { key: "spec", body: "SPEC", objective } }],
    };
    await assert.rejects(
      () => run(cfg, { _: ["promote", "ZEI-1"], flags: { assessment: hashValue(assessment) } }, {
        connect: () => api, requireHealthy: (x) => x.health(), C: { green: (x) => x, dim: (x) => x },
      }),
      /goal gate goalStatus contradicts/,
    );
    assert.deepEqual(writes, [], "promotion must not write anything for an unproven goal");
  } finally { f.cleanup(); }
});
