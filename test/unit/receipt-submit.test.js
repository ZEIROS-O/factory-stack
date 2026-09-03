"use strict";
// The receipt, submitted as a tool call rather than typed.
//
// The 2026-09-02 canary died because the Engineer had to remember a byte-exact
// text frame around JSON it assembled by hand. It did the work correctly and
// wrote prose. The Reviewer had nothing to bind to and declined — correctly,
// and $1.33 bought nothing.
//
// The fix is a split, not a louder instruction: the model supplies judgement,
// the tool derives every mechanical field. These tests hold that line. If a
// hash or a commit ever becomes something a model can supply, the fix has been
// undone and the failure mode is back.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClaims, deriveChecks, writeReceiptDocument, readReceiptDocument, receiptDocumentPath,
  SUPPLIED_KEYS,
} = require("../../lib/receipt-submit");
const { FactoryError } = require("../../lib/util");

const objective = {
  objectiveId: "ZEI-2", revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64),
  criteriaHash: "sha256:" + "b".repeat(64),
};
const repository = {
  baseCommit: "1e274df", headCommit: "3cb8238", branch: "paperclip/ZEI-2",
  diffHash: "sha256:" + "c".repeat(64),
  paths: [{ path: "src/add.js", sha256: "sha256:" + "d".repeat(64) }],
};
const supplied = (over = {}) => ({
  observations: ["src/add.js returned a - b"],
  conclusions: ["the criterion now passes"],
  unresolvedConditions: [],
  warnings: [],
  terminal: { status: "ready_for_review", stopReason: "completed" },
  ...over,
});
// Derived, never supplied — ExecutionReceiptV1's exact check shape.
const CHECKS = [{
  criterionId: "ZEI-2-AC-01",
  argv: ["node", "--test", "test/add.test.js"],
  cwd: "/home/lucascoh/.paperclip/worktrees/canary/paperclip/ZEI-2",
  exitCode: 0,
  stdoutHash: "sha256:" + "e".repeat(64),
  stderrHash: "sha256:" + "f".repeat(64),
}];

// ---- the split ----------------------------------------------------------

test("the model supplies judgement only", () => {
  assert.deepEqual(SUPPLIED_KEYS.sort(),
    ["conclusions", "observations", "terminal", "unresolvedConditions", "warnings"]);
  for (const forbidden of ["objective", "repository", "schemaVersion", "checks"]) {
    assert.ok(!SUPPLIED_KEYS.includes(forbidden),
      `${forbidden} must be derived; a model that can supply it can supply it wrong`);
  }
});

test("claims assemble into the shape the reader already validates", () => {
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  assert.equal(claims.schemaVersion, "ExecutionReceiptClaimsV1");
  assert.deepEqual(claims.objective, {
    objectiveId: "ZEI-2", revision: 1,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  });
  assert.deepEqual(claims.repository, repository);

  // The real reader must accept what this builds — otherwise the two halves
  // agree only in this test file.
  const { parseExecutionReceiptClaims, RECEIPT_BEGIN, RECEIPT_END } =
    require("../../lib/execution-receipt");
  assert.deepEqual(
    parseExecutionReceiptClaims(`${RECEIPT_BEGIN}\n${JSON.stringify(claims)}\n${RECEIPT_END}`),
    claims);
});

test("a model that tries to supply a derived field is refused, not silently overridden", () => {
  // Overriding quietly would let a wrong objective binding look accepted.
  assert.throws(
    () => buildClaims({ supplied: { ...supplied(), objective: { objectiveId: "OTHER" } }, objective, repository }),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /derives objective and repository/);
      return true;
    });
  assert.throws(
    () => buildClaims({ supplied: { ...supplied(), repository: { paths: [] } }, objective, repository }),
    /unexpected field/);
});

// ---- validation happens while the model can still act on it -------------

test("an invalid terminal status is refused, and the legal ones are named", () => {
  assert.throws(() => buildClaims({ supplied: supplied({ terminal: { status: "done", stopReason: "x" } }), objective, repository, checks: CHECKS }),
    /ready_for_review, blocked, abandoned/);
  for (const status of ["ready_for_review", "blocked", "abandoned"]) {
    assert.doesNotThrow(() => buildClaims({
      checks: CHECKS,
      supplied: supplied({
        terminal: { status, stopReason: "x" },
        // blocked/abandoned need no conclusions
        conclusions: status === "ready_for_review" ? ["done"] : [],
      }),
      objective, repository,
    }));
  }
});

test("a stopReason is required — 'why you stopped' is the point of a disposition", () => {
  assert.throws(() => buildClaims({ supplied: supplied({ terminal: { status: "blocked", stopReason: "  " } }), objective, repository, checks: CHECKS }),
    /stopReason/);
});

test("a ready_for_review receipt asserting nothing observed or concluded is refused", () => {
  assert.throws(
    () => buildClaims({ supplied: supplied({ observations: [], conclusions: [] }), objective, repository, checks: CHECKS }),
    /what you observed and what you concluded/);
});

test("the array fields must actually be arrays of strings", () => {
  for (const field of ["observations", "conclusions", "unresolvedConditions", "warnings"]) {
    assert.throws(() => buildClaims({ supplied: supplied({ [field]: "a string" }), objective, repository, checks: CHECKS }),
      new RegExp(field));
    assert.throws(() => buildClaims({ supplied: supplied({ [field]: [{ not: "a string" }] }), objective, repository, checks: CHECKS }),
      new RegExp(field));
  }
});

test("an empty unresolvedConditions is legal — it is a claim, not an omission", () => {
  assert.doesNotThrow(() => buildClaims({ supplied: supplied({ unresolvedConditions: [] }), objective, repository, checks: CHECKS }));
});

test("derived state that failed to resolve refuses rather than writing a hollow receipt", () => {
  assert.throws(() => buildClaims({ supplied: supplied(), objective, repository: { paths: null }, checks: CHECKS }),
    /repository state is incomplete/);
  assert.throws(() => buildClaims({ supplied: supplied(), objective: {}, repository, checks: CHECKS }),
    /objective could not be resolved/);
});

// ---- the write ----------------------------------------------------------

function fakeApi({ existing = null } = {}) {
  const state = { doc: existing };
  const calls = [];
  return {
    calls, state,
    getOptional: async (p) => { calls.push(["getOptional", p]); return state.doc; },
    mutate: async (args) => {
      calls.push(["mutate", args.readPath, args.method]);
      state.doc = { body: args.body.body, latestRevisionId: "rev-1" };
      return { verified: true };
    },
  };
}

test("the receipt is written as an issue document, with readback", async () => {
  const api = fakeApi();
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  const { docPath } = await writeReceiptDocument({ api, issueId: "i1", runId: "run-1", claims });
  assert.equal(docPath, receiptDocumentPath("i1"));
  const mutate = api.calls.find((c) => c[0] === "mutate");
  assert.equal(mutate[2], "PUT");
  // A 200 that did not persist must be an error, so the write must assert on
  // the body it sent.
  assert.ok(JSON.parse(api.state.doc.body).claims);
});

test("a second write carries the prior revision id, so a concurrent edit conflicts", async () => {
  const api = fakeApi({ existing: { body: "{}", latestRevisionId: "rev-0" } });
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  await writeReceiptDocument({ api, issueId: "i1", runId: "run-1", claims });
  assert.equal(api.state.doc.latestRevisionId, "rev-1");
});

test("the document records which run it belongs to", async () => {
  const api = fakeApi();
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  await writeReceiptDocument({ api, issueId: "i1", runId: "run-42", claims });
  assert.equal(JSON.parse(api.state.doc.body).runId, "run-42");
});

// ---- the read -----------------------------------------------------------

test("reading returns the claims for the matching run", async () => {
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  const api = { getOptional: async () => ({ body: JSON.stringify({ runId: "run-1", claims }) }) };
  assert.deepEqual(await readReceiptDocument({ api, issueId: "i1", runId: "run-1" }), claims);
});

test("a receipt from another run reads as absent — a stale account must not approve new work", async () => {
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  const api = { getOptional: async () => ({ body: JSON.stringify({ runId: "older", claims }) }) };
  assert.equal(await readReceiptDocument({ api, issueId: "i1", runId: "run-1" }), null);
});

test("no document reads as absent, not as an error", async () => {
  assert.equal(await readReceiptDocument({ api: { getOptional: async () => null }, issueId: "i1" }), null);
  assert.equal(await readReceiptDocument({ api: { getOptional: async () => ({ body: "  " }) }, issueId: "i1" }), null);
});

test("a malformed document throws — a corrupted account is not a missing one", async () => {
  const api = { getOptional: async () => ({ body: "{not json" }) };
  await assert.rejects(() => readReceiptDocument({ api, issueId: "i1" }), /not valid JSON/);
});

test("a rejected write reports the server's reason, not just the status code", async () => {
  // "HTTP 403" is not actionable by the agent or by whoever reads the run log.
  const { FactoryError } = require("../../lib/util");
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  const api = {
    getOptional: async () => null,
    mutate: async () => {
      const err = new FactoryError("PUT /api/issues/i1/documents/execution-receipt -> HTTP 403");
      err.details = { status: 403, body: '{"error":"Agent cannot mutate another agent\'s issue"}' };
      throw err;
    },
  };
  await assert.rejects(
    () => writeReceiptDocument({ api, issueId: "i1", runId: "run-1", claims }),
    /HTTP 403 — .*Agent cannot mutate/);
});

test("a 403 names the ordering mistake, because the server's message does not", async () => {
  // The canary lost a $1.19 run to this: the Engineer set the disposition
  // first, which reassigned the issue, and the receipt write came back
  // "Agent cannot mutate another agent's issue". That reads like a permissions
  // problem and is a sequencing one, so the tool has to say which.
  const { FactoryError } = require("../../lib/util");
  const claims = buildClaims({ supplied: supplied(), objective, repository, checks: CHECKS });
  const api = {
    getOptional: async () => null,
    mutate: async () => {
      const err = new FactoryError("PUT … -> HTTP 403");
      err.details = { status: 403, body: '{"error":"Agent cannot mutate another agent\'s issue"}' };
      throw err;
    },
  };
  await assert.rejects(
    () => writeReceiptDocument({ api, issueId: "i1", runId: "run-1", claims }),
    /BEFORE the disposition/);
});

// ── the test that should have existed ──────────────────────────────────────
//
// "claims assemble into the shape the reader already validates" checked
// parseExecutionReceiptClaims, which validates the TOP-LEVEL key set and
// nothing inside it. So a `checks` array of the wrong shape passed, and the
// real validation — buildExecutionReceipt against ExecutionReceiptV1, with
// additionalProperties false — was never exercised from this side.
//
// The cost: the canary's Reviewer read the diff, reached a correct PASS,
// called paperclip_review, and got "ExecutionReceiptV1 validation failed:
// /checks/0 must have required property 'criterionId'". It diagnosed the
// mismatch and reported it accurately. A $1.50 Engineer run produced a receipt
// nothing could accept.
//
// Validating against the neighbouring module is the point. A contract asserted
// only against its own producer is not a contract.

test("claims pass the REAL receipt validation, not just the frame parser", () => {
  const { buildExecutionReceipt } = require("../../lib/execution-receipt");
  const { objectiveHash, objectiveCriteriaHash } = require("../../lib/contracts");

  const full = {
    schemaVersion: "ObjectiveEnvelopeV1",
    objectiveId: "ZEI-2", issueIdentifier: "ZEI-2", revision: 1,
    objectiveHash: "sha256:" + "0".repeat(64), criteriaHash: "sha256:" + "0".repeat(64),
    title: "canary", originalRequest: "fix add()",
    repository: { path: "/tmp/repo", baseCommit: "1e274df", branch: "paperclip/ZEI-2" },
    permissions: { filesystem: { read: ["."], write: ["src/add.js"] }, network: "provider_only", externalEffects: [] },
    limits: { wallClockMinutes: 15, costCeilingUsd: 3, outerFactoryCostCeilingUsd: 5, maxReviewRounds: 2 },
    verificationLevel: "important",
    expectedOutputs: ["add sums"], constraints: ["single file"],
    acceptanceCriteria: [{
      id: "ZEI-2-AC-01", requirement: "add(2,3) === 5",
      command: { argv: ["node", "--test", "test/add.test.js"], cwd: "." },
    }],
  };
  full.criteriaHash = objectiveCriteriaHash(full);
  full.objectiveHash = objectiveHash(full);

  const claims = buildClaims({
    supplied: supplied(), objective: full,
    repository: {
      baseCommit: "1e274df", headCommit: "1e274df", branch: "paperclip/ZEI-2",
      diffHash: "sha256:" + "c".repeat(64),
      paths: [{ path: "src/add.js", sha256: "sha256:" + "d".repeat(64) }],
    },
    checks: CHECKS,
  });

  const run = {
    id: "run-1", agentId: "eng", status: "succeeded",
    startedAt: "2026-09-03T01:55:00.000Z", finishedAt: "2026-09-03T01:58:00.000Z",
    usageJson: { costUsd: 1.5 },
    resultJson: { stopReason: "completed" },
    contextSnapshot: {
      issueId: "i1",
      paperclipWorkspace: {
        worktreePath: "/home/lucascoh/.paperclip/worktrees/canary/paperclip/ZEI-2",
        branchName: "paperclip/ZEI-2",
      },
    },
  };
  // Throws if any part of the claims violates ExecutionReceiptV1.
  const receipt = buildExecutionReceipt({ run, issueId: "i1", objective: full, claims });
  assert.equal(receipt.checks[0].criterionId, "ZEI-2-AC-01");
  assert.deepEqual(receipt.checks[0].argv, ["node", "--test", "test/add.test.js"]);
});

// ── deriving the checks ────────────────────────────────────────────────────

const objectiveWithCriteria = {
  objectiveId: "ZEI-2", revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64), criteriaHash: "sha256:" + "b".repeat(64),
  acceptanceCriteria: [{
    id: "ZEI-2-AC-01", requirement: "passes",
    command: { argv: ["node", "--test", "test/add.test.js"], cwd: "." },
  }],
};

test("checks are produced by RUNNING the objective's commands", () => {
  const calls = [];
  const exec = (file, args, opts) => {
    calls.push([file, args, opts.cwd]);
    return { status: 0, stdout: "# pass 1\n", stderr: "" };
  };
  const checks = deriveChecks({ objective: objectiveWithCriteria, cwd: "/wt", exec });
  assert.equal(checks.length, 1);
  assert.deepEqual(calls[0], ["node", ["--test", "test/add.test.js"], "/wt"]);
  assert.equal(checks[0].criterionId, "ZEI-2-AC-01");
  assert.equal(checks[0].exitCode, 0);
  assert.match(checks[0].stdoutHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(checks[0].stderrHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(checks[0].cwd.startsWith("/"), "cwd must be absolute; the schema requires it");
});

test("a real failure is recorded as a failure, not smoothed over", () => {
  const exec = () => ({ status: 1, stdout: "# fail 1\n", stderr: "boom" });
  const checks = deriveChecks({ objective: objectiveWithCriteria, cwd: "/wt", exec });
  assert.equal(checks[0].exitCode, 1,
    "a derived exit code cannot be optimistic — that is the reason for deriving it");
});

test("a command that could not launch records that, rather than throwing", () => {
  // A receipt saying "this check did not run" is useful. One that does not
  // exist because the runner threw is not.
  const exec = () => ({ status: null, error: new Error("ENOENT") });
  const checks = deriveChecks({ objective: objectiveWithCriteria, cwd: "/wt", exec });
  assert.equal(checks[0].exitCode, -1);
  assert.match(checks[0].stderrHash, /^sha256:/);
});

test("an objective with no acceptance commands yields no checks, not an error", () => {
  assert.deepEqual(deriveChecks({ objective: { acceptanceCriteria: [] }, cwd: "/wt", exec: () => ({}) }), []);
  assert.deepEqual(deriveChecks({ objective: {}, cwd: "/wt", exec: () => ({}) }), []);
});
