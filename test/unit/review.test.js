"use strict";
// The decision logic behind the Reviewer's single write-capable tool.
//
// This lives in lib/ rather than inside the OMP plugin on purpose: the plugin is
// an ESM adapter that OMP loads inside a sandbox, which node:test cannot drive.
// Every rule that decides whether work is approved is therefore here, where it
// can be probed directly.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveReviewContext,
  assertModelIndependence,
  runAcceptanceChecks,
  assertCriteriaCoverage,
  deriveOverallVerdict,
  deriveDisposition,
  resolveRound,
} = require("../../lib/review");
const { FactoryError } = require("../../lib/util");

const ENV = {
  PAPERCLIP_TASK_ID: "issue-uuid-1",
  PAPERCLIP_RUN_ID: "run-uuid-1",
  PAPERCLIP_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_API_KEY: "agent-jwt",
  PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/worktrees/ZEI-1",
  PAPERCLIP_WORKSPACE_BRANCH: "paperclip/ZEI-1",
};

// --------------------------------------------------------------- identity

test("the review context comes from the environment and cannot be aimed at another issue", () => {
  const ctx = deriveReviewContext(ENV);
  assert.equal(ctx.issueId, "issue-uuid-1");
  assert.equal(ctx.runId, "run-uuid-1");
  assert.equal(ctx.worktree, "/worktrees/ZEI-1");
  assert.equal(ctx.branch, "paperclip/ZEI-1");

  // The signature takes an environment, not an issue. A caller-supplied issue id
  // anywhere in the environment must not become the target: the tool reviews the
  // run it was dispatched for, or nothing.
  const spoofed = deriveReviewContext({
    ...ENV,
    issueId: "someone-elses-issue",
    PAPERCLIP_ISSUE_ID: "someone-elses-issue",
    PAPERCLIP_LINKED_ISSUE_IDS: "someone-elses-issue",
  });
  assert.equal(spoofed.issueId, "issue-uuid-1");
});

test("the review context fails closed when the run environment is incomplete", () => {
  for (const missing of [
    "PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_API_URL",
    "PAPERCLIP_API_KEY", "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
  ]) {
    const env = { ...ENV };
    delete env[missing];
    assert.throws(() => deriveReviewContext(env), (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, new RegExp(missing));
      return true;
    }, `missing ${missing} must refuse to build a context`);
  }
});

// ----------------------------------------------------------- independence

test("a reviewer of the same model family as the producer refuses the review", () => {
  assert.throws(
    () => assertModelIndependence({ engineerModel: "anthropic/claude-opus-5", reviewerModel: "anthropic/claude-sonnet-5" }),
    /same model family/,
    "two models from one family are one opinion, not two",
  );

  // A different transport in front of the same family is still the same family.
  assert.throws(
    () => assertModelIndependence({ engineerModel: "anthropic/claude-opus-5", reviewerModel: "openrouter/anthropic/claude-opus-5" }),
    /same model family/,
  );

  assert.doesNotThrow(
    () => assertModelIndependence({ engineerModel: "anthropic/claude-opus-5", reviewerModel: "openai-codex/gpt-5.6-sol" }),
  );
});

test("an unknown or absent reviewer model family is refused rather than assumed independent", () => {
  assert.throws(() => assertModelIndependence({ engineerModel: "anthropic/claude-opus-5", reviewerModel: "" }),
    /model identity/);
  assert.throws(() => assertModelIndependence({ engineerModel: "", reviewerModel: "openai-codex/gpt-5.6-sol" }),
    /model identity/);
});

// ------------------------------------------------------ acceptance checks

const OBJECTIVE = {
  objectiveId: "ZEI-1",
  acceptanceCriteria: [
    { id: "AC-01", command: { argv: ["python3", "-m", "pytest", "-q"], cwd: "." } },
    { id: "AC-02", command: { argv: ["python3", "-m", "pytest", "-q", "tests/x.py"], cwd: "." } },
  ],
};

// A recording exec that returns whatever the scenario dictates, so the test
// asserts what the verifier is ASKED to do, not what pytest happens to do.
function fakeExec(results) {
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
    const r = results[calls.length - 1] ?? { status: 0, stdout: "ok", stderr: "" };
    return r;
  };
  return { exec, calls };
}

test("each acceptance criterion is executed through the read-only verifier with its exact argv", () => {
  const { exec, calls } = fakeExec([{ status: 0, stdout: "2 passed", stderr: "" }, { status: 0, stdout: "1 passed", stderr: "" }]);
  const results = runAcceptanceChecks({
    objective: OBJECTIVE, worktree: "/worktrees/ZEI-1",
    verifierPath: "/factory/ops/omp-verify-bwrap.sh", exec,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, "/factory/ops/omp-verify-bwrap.sh");
  assert.deepEqual(calls[0].args, [
    "--worktree", "/worktrees/ZEI-1", "--cwd", ".", "--",
    "python3", "-m", "pytest", "-q",
  ], "the declared argv must reach the verifier unchanged and unjoined");
  assert.deepEqual(calls[1].args, [
    "--worktree", "/worktrees/ZEI-1", "--cwd", ".", "--",
    "python3", "-m", "pytest", "-q", "tests/x.py",
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].criterionId, "AC-01");
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].passed, true);
  assert.match(results[0].outputHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(results[0].argv, ["python3", "-m", "pytest", "-q"]);
});

test("a non-zero acceptance exit is recorded as failed, and its output is still hashed", () => {
  const { exec } = fakeExec([{ status: 1, stdout: "1 failed", stderr: "" }, { status: 0, stdout: "ok", stderr: "" }]);
  const results = runAcceptanceChecks({
    objective: OBJECTIVE, worktree: "/w", verifierPath: "/v", exec,
  });
  assert.equal(results[0].passed, false);
  assert.equal(results[0].exitCode, 1);
  assert.match(results[0].outputHash, /^sha256:/);
  assert.equal(results[1].passed, true);
});

test("a verifier that could not run at all is a failed check, never a passed one", () => {
  // spawnSync reports a spawn failure as status null with an error.
  const exec = () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") });
  const results = runAcceptanceChecks({ objective: OBJECTIVE, worktree: "/w", verifierPath: "/v", exec });
  assert.equal(results[0].passed, false, "an unrunnable verifier must not read as success");
  assert.equal(results[0].exitCode, null);
  assert.match(results[0].error, /ENOENT/);
});

test("a criterion whose command is not an argv array is refused before anything executes", () => {
  const bad = { objectiveId: "X", acceptanceCriteria: [{ id: "AC-01", command: "python3 -m pytest" }] };
  let called = false;
  assert.throws(
    () => runAcceptanceChecks({ objective: bad, worktree: "/w", verifierPath: "/v", exec: () => { called = true; return { status: 0 }; } }),
    /argv/,
  );
  assert.equal(called, false, "nothing may execute for a malformed command");
});

// ------------------------------------------------------------- verdicts

test("every objective criterion needs exactly one verdict — no gaps, no extras", () => {
  const ok = [{ criterionId: "AC-01", verdict: "PASS" }, { criterionId: "AC-02", verdict: "PASS" }];
  assert.doesNotThrow(() => assertCriteriaCoverage(OBJECTIVE, ok));

  assert.throws(() => assertCriteriaCoverage(OBJECTIVE, [ok[0]]), /AC-02/,
    "a silently unjudged criterion is how an unreviewed change gets approved");
  assert.throws(() => assertCriteriaCoverage(OBJECTIVE, [...ok, { criterionId: "AC-99", verdict: "PASS" }]), /AC-99/);
  assert.throws(() => assertCriteriaCoverage(OBJECTIVE, [ok[0], ok[0], ok[1]]), /twice|duplicate/i);
});

test("the overall verdict is derived from the criterion verdicts, worst case wins", () => {
  const v = (...verdicts) => verdicts.map((verdict, i) => ({ criterionId: `AC-${i}`, verdict }));
  assert.equal(deriveOverallVerdict(v("PASS", "PASS")), "PASS");
  assert.equal(deriveOverallVerdict(v("PASS", "FAIL")), "FAIL");
  assert.equal(deriveOverallVerdict(v("PASS", "BLOCKED")), "BLOCKED");
  assert.equal(deriveOverallVerdict(v("PASS", "UNCERTAIN")), "UNCERTAIN");
  // A FAIL outranks an UNCERTAIN: the strongest negative is the honest summary.
  assert.equal(deriveOverallVerdict(v("UNCERTAIN", "FAIL")), "FAIL");
  assert.equal(deriveOverallVerdict(v("BLOCKED", "FAIL")), "FAIL");
});

test("approval requires all criteria PASS AND every deterministic check passing", () => {
  const allPass = [{ criterionId: "AC-01", verdict: "PASS" }, { criterionId: "AC-02", verdict: "PASS" }];
  const checksPass = [{ criterionId: "AC-01", passed: true }, { criterionId: "AC-02", passed: true }];

  assert.equal(deriveDisposition({ criteria: allPass, deterministicResults: checksPass }).disposition, "approve");

  // The instructions are explicit: a failed deterministic check yields BLOCKED
  // however sound the implementation appears. A reviewer asserting PASS over a
  // red check must not be able to approve.
  const checksFail = [{ criterionId: "AC-01", passed: true }, { criterionId: "AC-02", passed: false }];
  const d = deriveDisposition({ criteria: allPass, deterministicResults: checksFail });
  assert.equal(d.disposition, "request_changes");
  assert.match(d.reason, /deterministic/i);

  for (const bad of ["FAIL", "BLOCKED", "UNCERTAIN"]) {
    const criteria = [{ criterionId: "AC-01", verdict: "PASS" }, { criterionId: "AC-02", verdict: bad }];
    assert.equal(deriveDisposition({ criteria, deterministicResults: checksPass }).disposition, "request_changes",
      `${bad} must not approve`);
  }
});

test("the only dispositions that exist are approve and request_changes", () => {
  const { DISPOSITIONS } = require("../../lib/review");
  assert.deepEqual([...DISPOSITIONS].sort(), ["approve", "request_changes"]);
});

// ------------------------------------------------------ round exhaustion

test("exhausting the review rounds escalates to the human instead of looping", () => {
  const limits = { maxReviewRounds: 2 };

  const first = resolveRound({ round: 1, limits, disposition: "request_changes" });
  assert.equal(first.action, "request_changes");
  assert.equal(first.escalate, false);

  const last = resolveRound({ round: 2, limits, disposition: "request_changes" });
  assert.equal(last.action, "escalate");
  assert.equal(last.escalate, true);
  assert.match(last.reason, /round/i);

  // Approving on the final round is still an approval — exhaustion only
  // constrains sending work back, it never blocks a clean pass.
  const approve = resolveRound({ round: 2, limits, disposition: "approve" });
  assert.equal(approve.action, "approve");
  assert.equal(approve.escalate, false);
});

test("round exhaustion never produces the blocked-and-reassign-to-engineer state the plan forbids", () => {
  const r = resolveRound({ round: 5, limits: { maxReviewRounds: 2 }, disposition: "request_changes" });
  assert.equal(r.action, "escalate");
  assert.notEqual(r.action, "request_changes");
  assert.equal(r.assignToEngineer, false, "an exhausted review must not bounce back to the producer");
});

test("independence collapses product suffixes, because one lab's two products are one opinion", () => {
  const { modelVendor } = require("../../lib/review");

  // Same lab, different product line: NOT independent.
  assert.throws(
    () => assertModelIndependence({ engineerModel: "openai/gpt-5", reviewerModel: "openai-codex/gpt-5.6-sol" }),
    /same model family/,
  );

  // But the recorded identity keeps the route that actually ran, so an
  // assessment says which product produced it rather than a normalisation.
  assert.equal(modelVendor("openai-codex/gpt-5.6-sol"), "openai-codex");
  assert.equal(modelVendor("openrouter/anthropic/claude-opus-5"), "anthropic",
    "a routing prefix names the broker, not the author of the weights");
});

// ── the branch the environment never carried ───────────────────────────────
//
// PAPERCLIP_WORKSPACE_BRANCH arrives empty on every run. Paperclip's
// contextSnapshot supplies `paperclipWorkspace.branchName`;
// @zhafron/paperclip-omp-adapter reads `workspace.branch`
// (dist/server/execute.js:327), which is undefined, and exports "". Every
// sibling key it reads matches — cwd, source, strategy, workspaceId, repoUrl,
// repoRef, worktreePath, agentHome — and only this one does not.
//
// submitReview compares the receipt's branch to this value, so the effect was
// total: every review refused with "ExecutionReceiptV1 does not match the
// current objective, run workspace, or live change set", a message naming three
// candidates and not the one that was wrong. Two canary runs died on it.

const REVIEW_ENV = {
  PAPERCLIP_TASK_ID: "issue-1",
  PAPERCLIP_RUN_ID: "run-1",
  PAPERCLIP_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_API_KEY: "tok",
  PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/wt",
};

test("an empty PAPERCLIP_WORKSPACE_BRANCH is derived from the worktree", () => {
  const { deriveReviewContext } = require("../../lib/review");
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    return { status: 0, stdout: "paperclip/ZEI-2\n" };
  };
  const ctx = deriveReviewContext({ ...REVIEW_ENV, PAPERCLIP_WORKSPACE_BRANCH: "" }, { exec });
  assert.equal(ctx.branch, "paperclip/ZEI-2");
  assert.deepEqual(calls[0], ["git", "-C", "/wt", "rev-parse", "--abbrev-ref", "HEAD"],
    "the branch must come from the worktree actually checked out");
});

test("a declared branch still wins — deriving is the fallback, not the rule", () => {
  const { deriveReviewContext } = require("../../lib/review");
  const exec = () => { throw new Error("must not shell out when the env carries the branch"); };
  const ctx = deriveReviewContext({ ...REVIEW_ENV, PAPERCLIP_WORKSPACE_BRANCH: "declared/branch" }, { exec });
  assert.equal(ctx.branch, "declared/branch");
});

test("a detached HEAD names no branch, and must not be compared as one", () => {
  const { deriveReviewContext } = require("../../lib/review");
  const exec = () => ({ status: 0, stdout: "HEAD\n" });
  assert.equal(deriveReviewContext({ ...REVIEW_ENV }, { exec }).branch, null);
});

test("a failed git call yields null rather than a fabricated branch", () => {
  const { deriveReviewContext } = require("../../lib/review");
  const exec = () => ({ status: 128, stdout: "", stderr: "not a git repository" });
  assert.equal(deriveReviewContext({ ...REVIEW_ENV }, { exec }).branch, null);
});

test("with no exec injected the branch is null, not a crash", () => {
  const { deriveReviewContext } = require("../../lib/review");
  assert.equal(deriveReviewContext({ ...REVIEW_ENV }).branch, null);
});

// ── a check that never ran is not a verdict ────────────────────────────────
//
// exitCode null means no exit status was ever obtained — a spawn failure or a
// signal — which is a different event from a test that ran and failed.
// AssessmentV1 cannot express the difference (deterministicResults is
// additionalProperties:false over criterionId/argv/exitCode/passed/outputHash),
// so it lands as `passed: false` and reads as a finding about the code.
//
// On 2026-09-03 that cost $2.67: the verifier was non-executable, every check
// recorded null, the stage returned changes_requested over the reviewer's own
// PASS, and the Engineer correctly worked out there was nothing to fix and
// filed ZEI-4 against the runner rather than fabricating a change.

test("submitReview refuses when a deterministic check never ran", async () => {
  const { submitReview } = require("../../lib/review");
  const api = {
    get: async () => { throw new Error("must refuse BEFORE any read-modify-write"); },
    getOptional: async () => { throw new Error("must refuse BEFORE any read-modify-write"); },
    mutate: async () => { throw new Error("must refuse BEFORE the first write"); },
  };
  const { buildExecutionReceipt } = require("../../lib/execution-receipt");
  const { objectiveHash, objectiveCriteriaHash } = require("../../lib/contracts");
  const objective = {
    schemaVersion: "ObjectiveEnvelopeV1",
    objectiveId: "ZEI-2", issueIdentifier: "ZEI-2", revision: 1,
    objectiveHash: "sha256:" + "0".repeat(64), criteriaHash: "sha256:" + "0".repeat(64),
    title: "canary", originalRequest: "fix add()",
    repository: { path: "/tmp/repo", baseCommit: "1e274df", branch: "paperclip/ZEI-2" },
    permissions: { filesystem: { read: ["."], write: ["src/add.js"] }, network: "provider_only", externalEffects: [] },
    limits: { wallClockMinutes: 15, costCeilingUsd: 3, outerFactoryCostCeilingUsd: 5, maxReviewRounds: 2 },
    verificationLevel: "important",
    expectedOutputs: ["sums"], constraints: ["one file"],
    acceptanceCriteria: [{
      id: "ZEI-2-AC-01", requirement: "passes",
      command: { argv: ["node", "--test", "test/add.test.js"], cwd: "." },
    }],
  };
  objective.criteriaHash = objectiveCriteriaHash(objective);
  objective.objectiveHash = objectiveHash(objective);
  const claims = {
    schemaVersion: "ExecutionReceiptClaimsV1",
    objective: { objectiveId: "ZEI-2", revision: 1, objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash },
    repository: {
      baseCommit: "1e274df", headCommit: "1e274df", branch: "paperclip/ZEI-2",
      diffHash: "sha256:" + "c".repeat(64),
      paths: [{ path: "src/add.js", sha256: "sha256:" + "d".repeat(64) }],
    },
    checks: [], observations: ["o"], conclusions: ["c"],
    unresolvedConditions: [], warnings: [],
    terminal: { status: "ready_for_review", stopReason: "done" },
  };
  const receipt = buildExecutionReceipt({
    run: {
      id: "run-1", agentId: "eng", status: "succeeded",
      startedAt: "2026-09-03T03:00:00.000Z", finishedAt: "2026-09-03T03:05:00.000Z",
      usageJson: { costUsd: 1 }, resultJson: { stopReason: "completed" },
      contextSnapshot: { issueId: "issue-1", paperclipWorkspace: { worktreePath: "/wt", branchName: "paperclip/ZEI-2" } },
    },
    issueId: "issue-1", objective, claims,
  });
  // A verifier that cannot be spawned: status null, error set.
  const exec = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }) });

  await assert.rejects(
    () => submitReview({
      env: { ...REVIEW_ENV, PAPERCLIP_WORKSPACE_BRANCH: "paperclip/ZEI-2" },
      api, objective, exec, verifierPath: "/verify.sh",
      reviewerModel: "google-antigravity/gemini-3.8-flash-high",
      engineerModel: "anthropic/claude-opus-5",
      summary: "looks right",
      criteria: [{ criterionId: "ZEI-2-AC-01", verdict: "PASS", reasoning: "r", evidenceRefs: ["src/add.js"], uncertainty: null }],
      changeSet: { baseCommit: "1e274df", headCommit: "1e274df", diffHash: "sha256:" + "c".repeat(64), changedPaths: ["src/add.js"], paths: [{ path: "src/add.js", sha256: "sha256:" + "d".repeat(64) }] },
      executionReceipt: receipt, goalGate: null,
    }),
    (err) => {
      assert.match(err.message, /never ran/, "name the condition");
      assert.match(err.message, /harness fault, not a finding about the change/,
        "the distinction is the whole point: a broken runner is not a verdict on the code");
      assert.match(err.message, /ZEI-2-AC-01/, "name which check");
      return true;
    });
});
