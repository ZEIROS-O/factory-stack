"use strict";
// `factory promote` must work for an objective it has never seen before.
//
// THE DEFECT THIS FILE PINS. promote.js used to begin with
//
//     const declared = (cfg.issues ?? []).find((i) => i.identifier === identifier);
//     if (!declared?.objectiveDocument?.objective) throw ... `no declared objective`
//
// so the ONLY promotable issues were the ones an operator had hand-written into
// factory.config.json. A Hermes-created child's objective exists only as the
// spec document `factory handoff` installed on it, so every such child died at
// the approval step with its work already reviewed and passing.
//
// ZEI-2 below is declared NOWHERE: `cfg.issues` is empty on purpose. If this
// test can be made to pass by adding a config entry, it is testing the wrong
// thing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { run, computeChangeSet, computeDiffHash } = require("../../lib/promote");
const { RECEIPT_BEGIN, RECEIPT_END, buildExecutionReceipt } = require("../../lib/execution-receipt");
const { renderObjectiveDocument, objectiveHash, objectiveCriteriaHash } = require("../../lib/contracts");
const { hashValue } = require("../../lib/util");

function fixture(branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promote-arb-"));
  const primary = path.join(root, "primary");
  fs.mkdirSync(primary);
  const g = (...args) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(primary, "src"));
  fs.writeFileSync(path.join(primary, "src/a.js"), "base\n");
  g("add", "-A"); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();
  const wt = path.join(root, "wt");
  g("worktree", "add", "-q", "-b", branch, wt);
  fs.writeFileSync(path.join(wt, "src/a.js"), "fixed\n");
  return { root, primary, wt, base, g, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A complete, hash-consistent envelope — the shape `factory handoff` derives. */
function envelope(identifier, { primary, base }) {
  const o = {
    schemaVersion: "ObjectiveEnvelopeV1",
    objectiveId: identifier,
    issueIdentifier: identifier,
    revision: 1,
    objectiveHash: "sha256:" + "0".repeat(64),
    criteriaHash: "sha256:" + "0".repeat(64),
    title: `Hermes-derived child work for ${identifier}`,
    originalRequest: "Make src/a.js say fixed.",
    repository: { path: primary, baseCommit: base, branch: `paperclip/${identifier}` },
    permissions: {
      filesystem: { read: ["."], write: ["src/a.js"] },
      network: "provider_only", externalEffects: [],
    },
    limits: { wallClockMinutes: 45, costCeilingUsd: 4, outerFactoryCostCeilingUsd: 5, maxReviewRounds: 2 },
    verificationLevel: "important",
    expectedOutputs: ["src/a.js says fixed"],
    constraints: ["Consume the workspace Paperclip supplied."],
    acceptanceCriteria: [{
      id: `${identifier}-AC-01`,
      requirement: "The suite passes.",
      command: { argv: ["node", "--version"], cwd: "." },
    }],
  };
  o.criteriaHash = objectiveCriteriaHash(o);
  o.objectiveHash = objectiveHash(o);
  return o;
}

test("promotes a Hermes-created child that no config declares", async () => {
  const f = fixture("paperclip/ZEI-2");
  try {
    const objective = envelope("ZEI-2", { primary: f.primary, base: f.base });
    const goalGate = {
      schemaVersion: "EngineerGoalGateV1",
      runId: "engineer-run", taskId: "child-uuid", sessionId: "omp-2", goalId: "goal-2",
      goalObjectiveHash: objective.objectiveHash,
      objectiveId: "ZEI-2", revision: 1,
      objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
      goalStatus: "complete", continuations: 1, terminal: true,
      observedAt: "2026-09-02T10:00:00.000Z",
    };
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-arb-gate-"));
    fs.writeFileSync(path.join(sessionDir, "goal-gate-engineer-run.json"), JSON.stringify(goalGate));

    const cs = computeChangeSet(f.wt, f.base);
    const claims = {
      schemaVersion: "ExecutionReceiptClaimsV1",
      objective: {
        objectiveId: "ZEI-2", revision: 1,
        objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
      },
      repository: {
        baseCommit: f.base, headCommit: f.base, branch: "paperclip/ZEI-2",
        diffHash: computeDiffHash(cs), paths: cs.paths,
      },
      checks: [], observations: ["fixed"], conclusions: ["ready"],
      unresolvedConditions: [], warnings: [],
      terminal: { status: "ready_for_review", stopReason: "complete" },
    };
    const paperclipRun = {
      id: "engineer-run", agentId: "engineer", status: "succeeded",
      startedAt: "2026-09-02T10:00:00.000Z", finishedAt: "2026-09-02T10:01:00.000Z",
      sessionIdAfter: "omp-2",
      usageJson: { costStatus: "reported", costUsd: 0.4 },
      contextSnapshot: {
        issueId: "child-uuid",
        paperclipWorkspace: { cwd: f.wt, worktreePath: f.wt, branchName: "paperclip/ZEI-2" },
      },
      resultJson: { summary: `${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`, stopReason: "stop" },
      sessionParams: { sessionId: "omp-2", cwd: f.wt, sessionDir },
    };
    const executionReceipt = buildExecutionReceipt({
      run: paperclipRun, issueId: "child-uuid", objective, claims, goalGate,
    });
    const assessment = {
      schemaVersion: "AssessmentV1", assessmentId: "assessment-reviewer-run",
      objective: executionReceipt.objective,
      executionRunId: "engineer-run", executionReceiptHash: hashValue(executionReceipt),
      reviewer: { agentName: "OMP Reviewer", modelFamily: "openai-codex" },
      repository: {
        baseCommit: f.base, headCommit: f.base,
        diffHash: computeDiffHash(cs), changedPaths: ["src/a.js"],
      },
      deterministicResults: [{
        criterionId: "ZEI-2-AC-01", argv: ["node", "--version"],
        exitCode: 0, passed: true, outputHash: "sha256:" + "e".repeat(64),
      }],
      criteria: [{
        criterionId: "ZEI-2-AC-01", verdict: "PASS",
        evidenceRefs: ["check"], reasoning: "pass", uncertainty: null,
      }],
      overallVerdict: "PASS", assessedAt: "2026-09-02T10:02:00.000Z",
    };

    let issue = {
      id: "child-uuid", identifier: "ZEI-2", status: "in_review",
      executionState: {
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "operator" },
        returnAssignee: { type: "agent", agentId: "engineer" },
      },
    };
    let promotionDoc = null; let products = [];
    const writes = [];
    const api = {
      health: async () => ({ status: "ok" }),
      getOptional: async (p) => (p.includes("/documents/promotion-") ? promotionDoc : null),
      get: async (p) => {
        if (p === "/api/companies") return [{ id: "c1", name: "Local Factory" }];
        if (p === "/api/companies/c1/issues") return [{ id: "child-uuid", identifier: "ZEI-2" }];
        if (p === "/api/issues/child-uuid") return issue;
        // The objective of record: installed by `factory handoff`, on the issue.
        if (p === "/api/issues/child-uuid/documents/spec") {
          return { body: renderObjectiveDocument(objective) };
        }
        if (p === "/api/issues/child-uuid/documents/assessment") return { body: JSON.stringify(assessment) };
        if (p === "/api/issues/child-uuid/runs") {
          return [{ runId: "engineer-run", agentId: "engineer", status: "succeeded" }];
        }
        if (p === "/api/heartbeat-runs/engineer-run") return paperclipRun;
        if (p === "/api/issues/child-uuid/work-products") return products;
        if (p.includes("/documents/promotion-")) return promotionDoc;
        throw new Error(`GET ${p}`);
      },
      mutate: async ({ readPath, writePath, method, body, expect }) => {
        writes.push({ method, path: writePath, body });
        if (method === "PUT") promotionDoc = { body: body.body, latestRevisionId: "rev-1" };
        else if (method === "POST") products.push({ id: "wp-1", ...body });
        else if (method === "PATCH") issue = { ...issue, status: "done", executionState: { status: "completed" } };
        const after = await api.get(readPath);
        for (const e of expect) {
          assert.equal(e.compare ? e.compare(undefined, after) : after[e.path], e.compare ? true : e.value);
        }
        return { before: null, after, verified: true };
      },
    };

    // DECLARED NOWHERE. This is the whole point of the test.
    const cfg = {
      _root: path.join(f.root, "factory"),
      company: { name: "Local Factory" },
      issues: [],
    };

    const code = await run(
      cfg,
      { _: ["promote", "ZEI-2"], flags: { assessment: hashValue(assessment) } },
      { connect: () => api, requireHealthy: (x) => x.health(), C: { green: (x) => x, dim: (x) => x } },
    );

    assert.equal(code, 0);
    assert.equal(issue.status, "done");
    assert.deepEqual(
      f.g("show", "paperclip/ZEI-2", "--name-only", "--format=").trim().split("\n"),
      ["src/a.js"],
    );
    assert.deepEqual(writes.map((w) => w.method), ["PUT", "POST", "PATCH"]);
  } finally { f.cleanup(); }
});
