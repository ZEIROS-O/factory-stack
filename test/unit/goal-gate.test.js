"use strict";
// lib/goal-gate.js — the goal gate the whole control plane refuses on.
//
// The gate is the only mechanically verifiable proof that an Engineer run
// ended with its own native goal completed against the canonical objective.
// Every way it can be missing, wrong, incomplete, or non-terminal is a
// refusal below, each named so a regression says which invariant broke.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  GOAL_GATE_FILENAME_PREFIX, goalGateFilename, loadGoalGate, assertGoalGate,
  canonicalGoalObjective, goalObjectiveTextMatchesSpec, objectiveFromSpecDocument,
  continuationDecision, DEFAULT_MAX_GOAL_CONTINUATIONS,
  DEFAULT_GOAL_CONTINUATION_WALL_CLOCK_MINUTES,
} = require("../../lib/goal-gate");
const { objectiveCriteriaHash, objectiveHash, renderObjectiveDocument } = require("../../lib/contracts");
const { buildExecutionReceipt } = require("../../lib/execution-receipt");
const { canonical, clone, FactoryError, hashText } = require("../../lib/util");

// ------------------------------------------------------------------ fixtures

const objective = {
  objectiveId: "ZEI-1", revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64), criteriaHash: "sha256:" + "b".repeat(64),
  repository: { baseCommit: "3cb8238", branch: "paperclip/ZEI-1" },
  limits: { costCeilingUsd: 4, wallClockMinutes: 60 },
};
const run = { id: "run-1", sessionIdAfter: "omp-session-1" };
const issueId = "issue-1";

/** A fully valid gate: complete, terminal, bound to the fixtures above. */
function validGate(overrides = {}) {
  return {
    schemaVersion: "EngineerGoalGateV1",
    runId: "run-1", taskId: "issue-1", sessionId: "omp-session-1", goalId: "goal-1",
    goalObjectiveHash: objective.objectiveHash,
    objectiveId: "ZEI-1", revision: 1,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
    goalStatus: "complete", continuations: 1, terminal: true,
    observedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

/** The one mismatch assertion used by every binding test: the error must name
 * the field and carry both values, so a regression identifies itself. */
function assertFieldRefused(field, gateOverrides, expected) {
  assert.throws(
    () => assertGoalGate({ gate: validGate(gateOverrides), run, issueId, objective }),
    (err) => err instanceof FactoryError
      && err.message.includes(`goal gate ${field} contradicts`)
      && err.message.includes(JSON.stringify(expected))
      && err.message.includes(JSON.stringify(validGate(gateOverrides)[field])),
    `${field} mismatch must be refused with the field named`,
  );
}

// ------------------------------------------------------- the canonicalization

// A real, hash-consistent envelope: every hash below is computed, never
// hard-coded, so the canonicalization tests prove the rule itself.
const envelope = {
  schemaVersion: "ObjectiveEnvelopeV1",
  objectiveId: "ZEI-1", issueIdentifier: "ZEI-1", revision: 1,
  title: "Fix the defrost heuristic", originalRequest: "defrost is wrong",
  repository: { path: "/repo", baseCommit: "3cb823840d5512e8ebcd0798a96dad7589782528", branch: "paperclip/ZEI-1" },
  permissions: { filesystem: { read: ["/repo"], write: ["/repo"] }, network: "none", externalEffects: [] },
  limits: { wallClockMinutes: 60, costCeilingUsd: 4, outerFactoryCostCeilingUsd: 8, maxReviewRounds: 2 },
  verificationLevel: "routine", expectedOutputs: ["a fixed bin/view.py"], constraints: ["no new deps"],
  acceptanceCriteria: [
    { id: "ZEI-1-AC-01", requirement: "it defrosts", command: { argv: ["node", "--version"], cwd: "." } },
  ],
};
envelope.criteriaHash = objectiveCriteriaHash(envelope);
envelope.objectiveHash = objectiveHash(envelope);

test("the canonical goal text is the envelope minus objectiveHash, canonically serialized", () => {
  const expected = clone(envelope);
  delete expected.objectiveHash;
  assert.equal(canonicalGoalObjective(envelope), canonical(expected));
});

test("the canonical goal text is the one text that hashes to the spec's objectiveHash", () => {
  const text = canonicalGoalObjective(envelope);
  assert.ok(goalObjectiveTextMatchesSpec({ goalObjectiveText: text, specObjective: envelope }));
  assert.equal(hashText(text), envelope.objectiveHash);
});

test("a paraphrase, the served pretty-printed fence, and a reordered object all fail the rule", () => {
  // The document body as Paperclip serves it: markdown with a pretty-printed
  // fence. Pretty-printing alone changes the bytes, so pasting the fence
  // verbatim must NOT satisfy the rule — canonical means canonical.
  const served = renderObjectiveDocument(envelope);
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(served)[1];
  assert.ok(!goalObjectiveTextMatchesSpec({ goalObjectiveText: fence, specObjective: envelope }));
  assert.ok(!goalObjectiveTextMatchesSpec({ goalObjectiveText: "fix defrost", specObjective: envelope }));
  assert.ok(!goalObjectiveTextMatchesSpec({ goalObjectiveText: JSON.stringify(envelope), specObjective: envelope }));
  assert.ok(!goalObjectiveTextMatchesSpec({ goalObjectiveText: "", specObjective: envelope }));
  assert.ok(!goalObjectiveTextMatchesSpec({ goalObjectiveText: null, specObjective: envelope }));
});

test("the spec document body yields the verified envelope; anything else refuses", () => {
  assert.deepEqual(objectiveFromSpecDocument(renderObjectiveDocument(envelope)), envelope);
  assert.throws(() => objectiveFromSpecDocument("no fence at all"), /no fenced json objective envelope/i);
  assert.throws(() => objectiveFromSpecDocument("```json\nnot json\n```"), /not valid JSON/i);
  assert.throws(() => objectiveFromSpecDocument(""), /no body/i);
  // A tampered envelope fails verifyObjectiveHashes inside the extractor: the
  // extension will not accept a goal against a spec that is not self-consistent.
  const tampered = clone(envelope);
  tampered.title = "something else entirely";
  assert.throws(() => objectiveFromSpecDocument(renderObjectiveDocument(tampered)), /objectiveHash does not match/i);
});

// ------------------------------------------------------------- the file name

test("the gate filename is per-run and prefixed", () => {
  assert.equal(GOAL_GATE_FILENAME_PREFIX, "goal-gate-");
  assert.equal(goalGateFilename("run-1"), "goal-gate-run-1.json");
  assert.throws(() => goalGateFilename(""), FactoryError);
  assert.throws(() => goalGateFilename(undefined), FactoryError);
});

// --------------------------------------------------------------- loadGoalGate

function withSessionDir(gate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-gate-test-"));
  if (gate) fs.writeFileSync(path.join(dir, "goal-gate-run-1.json"), JSON.stringify(gate));
  return dir;
}

test("loadGoalGate resolves the record from run.sessionParams.sessionDir and returns it", () => {
  const dir = withSessionDir(validGate());
  const seen = [];
  const loaded = loadGoalGate({
    run: { id: "run-1", sessionParams: { sessionId: "omp-session-1", cwd: "/wt", sessionDir: dir } },
    readFile: (p) => { seen.push(p); return fs.readFileSync(p, "utf8"); },
  });
  assert.deepEqual(seen, [path.join(dir, "goal-gate-run-1.json")]);
  assert.deepEqual(loaded.gate, validGate());
  assert.equal(loaded.path, path.join(dir, "goal-gate-run-1.json"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadGoalGate returns null for an absent file — absence is the caller's call", () => {
  const dir = withSessionDir(null);
  const loaded = loadGoalGate({
    run: { id: "run-1", sessionParams: { sessionDir: dir } },
    readFile: (p) => { const err = new Error("ENOENT"); err.code = "ENOENT"; throw err; },
  });
  assert.equal(loaded, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadGoalGate refuses a run with no sessionParams.sessionDir", () => {
  assert.throws(
    () => loadGoalGate({ run: { id: "run-1" }, readFile: () => "" }),
    /no sessionParams\.sessionDir/i,
  );
  assert.throws(
    () => loadGoalGate({ run: { id: "run-1", sessionParams: {} }, readFile: () => "" }),
    /no sessionParams\.sessionDir/i,
  );
});

test("a corrupt gate file is an error, not silence", () => {
  const dir = withSessionDir(null);
  fs.writeFileSync(path.join(dir, "goal-gate-run-1.json"), "{not json");
  assert.throws(
    () => loadGoalGate({ run: { id: "run-1", sessionParams: { sessionDir: dir } }, readFile: (p) => fs.readFileSync(p, "utf8") }),
    /not valid JSON/i,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ assertGoalGate

test("a missing gate is refused", () => {
  assert.throws(() => assertGoalGate({ gate: null, run, issueId, objective }), /no verified goal gate/i);
  assert.throws(() => assertGoalGate({ gate: undefined, run, issueId, objective }), /no verified goal gate/i);
  assert.throws(() => assertGoalGate({ run, issueId, objective }), /no verified goal gate/i);
});

test("a schema-invalid gate is refused", () => {
  // Missing a required field, an extra field, and a malformed hash: all three
  // are schema violations, and the gate must not be trusted on any of them.
  const { continuations, ...missingField } = validGate();
  assert.throws(() => assertGoalGate({ gate: missingField, run, issueId, objective }), /validation failed/i);
  assert.throws(
    () => assertGoalGate({ gate: validGate({ extra: 1 }), run, issueId, objective }),
    /validation failed/i,
  );
  assert.throws(
    () => assertGoalGate({ gate: validGate({ objectiveHash: "not-a-hash" }), run, issueId, objective }),
    /validation failed/i,
  );
});

test("a gate bound to another run is refused — runId", () => {
  assertFieldRefused("runId", { runId: "run-2" }, "run-1");
});

test("a gate bound to another issue is refused — taskId", () => {
  assertFieldRefused("taskId", { taskId: "issue-2" }, "issue-1");
});

test("a gate from another session is refused — sessionId", () => {
  assertFieldRefused("sessionId", { sessionId: "omp-session-2" }, "omp-session-1");
});

test("a gate bound to another objective is refused — objectiveId", () => {
  assertFieldRefused("objectiveId", { objectiveId: "ZEI-2" }, "ZEI-1");
});

test("a gate bound to another revision is refused — revision", () => {
  assertFieldRefused("revision", { revision: 2 }, 1);
});

test("a gate whose objectiveHash points at another spec is refused — objectiveHash", () => {
  assertFieldRefused("objectiveHash", { objectiveHash: "sha256:" + "c".repeat(64) }, objective.objectiveHash);
});

test("a gate whose criteriaHash points at another spec is refused — criteriaHash", () => {
  assertFieldRefused("criteriaHash", { criteriaHash: "sha256:" + "c".repeat(64) }, objective.criteriaHash);
});

test("a gate whose goal-text proof points at another spec is refused — goalObjectiveHash", () => {
  assertFieldRefused("goalObjectiveHash", { goalObjectiveHash: "sha256:" + "c".repeat(64) }, objective.objectiveHash);
});

for (const status of ["active", "paused", "budget-limited", "dropped"]) {
  test(`a gate whose goal never completed is refused — goalStatus ${JSON.stringify(status)}`, () => {
    assert.throws(
      () => assertGoalGate({ gate: validGate({ goalStatus: status }), run, issueId, objective }),
      (err) => err instanceof FactoryError && err.message.includes("goal gate goalStatus contradicts")
        && err.message.includes(JSON.stringify(status)),
      `goalStatus ${status} must be refused by name`,
    );
  });
}

test("terminal:false is refused even when the goal status is complete", () => {
  assert.throws(
    () => assertGoalGate({ gate: validGate({ terminal: false }), run, issueId, objective }),
    /goal gate terminal contradicts.*"complete".*false|goal gate terminal contradicts/s,
  );
});

test("a fully valid gate passes and is returned unchanged", () => {
  const gate = validGate();
  assert.deepEqual(assertGoalGate({ gate, run, issueId, objective }), gate);
});

// ------------------------------------------------- resume across heartbeats

test("a gate written by an earlier run is not found for a later run", () => {
  // The gate file is per-run by name: a later run in the same session
  // directory finds no file of its own, so absence — not a stale record — is
  // what the control plane sees.
  const dir = withSessionDir(validGate());
  const laterRun = { id: "run-2", sessionIdAfter: "omp-session-1", sessionParams: { sessionDir: dir } };
  const loaded = loadGoalGate({ run: laterRun, readFile: (p) => fs.readFileSync(p, "utf8") });
  assert.equal(loaded, null, "the earlier run's gate must not surface for a new run");
  assert.throws(
    () => assertGoalGate({ gate: loaded?.gate, run: { id: "run-2", sessionIdAfter: "omp-session-1" }, issueId, objective }),
    /no verified goal gate/i,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resumed session with a matching sessionId but a new runId is refused on runId", () => {
  const stale = validGate({ runId: "run-1" });
  const resumedRun = { id: "run-2", sessionIdAfter: "omp-session-1" };
  assert.throws(
    () => assertGoalGate({ gate: stale, run: resumedRun, issueId, objective }),
    (err) => err.message.includes("goal gate runId contradicts") && err.message.includes("run-2"),
  );
});

test("a timed-out attempt cannot produce a successful gate", () => {
  // A wall-clock-exhausted attempt settles with an active goal and a
  // non-terminal gate; neither the status nor the terminality may pass.
  const timedOut = validGate({ goalStatus: "active", terminal: false });
  assert.throws(() => assertGoalGate({ gate: timedOut, run, issueId, objective }), /goalStatus contradicts/);
});

test("a budget-limited attempt cannot produce a successful gate", () => {
  const limited = validGate({ goalStatus: "budget-limited", terminal: false });
  assert.throws(
    () => assertGoalGate({ gate: limited, run, issueId, objective }),
    (err) => err.message.includes("goalStatus") && err.message.includes("budget-limited"),
  );
});

// ------------------------------------------------------ bounded continuation

test("continuation continues while the goal is active and under both bounds", () => {
  const decision = continuationDecision({
    goalStatus: "active", continuations: 0,
    startedAtMs: 0, nowMs: 60_000, limits: { wallClockMinutes: 60 },
  });
  assert.equal(decision.action, "continue");
});

test("continuation stops at the hard count bound", () => {
  const decision = continuationDecision({
    goalStatus: "active", continuations: DEFAULT_MAX_GOAL_CONTINUATIONS,
    startedAtMs: 0, nowMs: 1, limits: { wallClockMinutes: 60 },
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /continuation budget/);
});

test("continuation stops at the wall-clock bound read from the objective's limits", () => {
  const decision = continuationDecision({
    goalStatus: "active", continuations: 0,
    startedAtMs: 0, nowMs: 61 * 60_000, limits: { wallClockMinutes: 1 },
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /wall-clock bound of 1 minutes/);
});

test("the wall clock runs on the objective's own limits while they remain", () => {
  const under = continuationDecision({
    goalStatus: "active", continuations: 0, startedAtMs: 0, nowMs: 30_000, limits: { wallClockMinutes: 1 },
  });
  assert.equal(under.action, "continue");
});

test("a missing wall clock in the objective falls back to the conservative default", () => {
  const boundary = DEFAULT_GOAL_CONTINUATION_WALL_CLOCK_MINUTES * 60_000;
  const under = continuationDecision({
    goalStatus: "active", continuations: 0, startedAtMs: 0, nowMs: boundary - 1, limits: {},
  });
  const over = continuationDecision({
    goalStatus: "active", continuations: 0, startedAtMs: 0, nowMs: boundary, limits: {},
  });
  assert.equal(under.action, "continue");
  assert.equal(over.action, "stop");
});

test("no usable clock stops rather than risking an unbounded loop", () => {
  const decision = continuationDecision({ goalStatus: "active", continuations: 0, limits: {} });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /no usable clock/);
});

for (const status of ["paused", "budget-limited", "dropped", "complete"]) {
  test(`continuation never fires for a ${JSON.stringify(status)} goal`, () => {
    const decision = continuationDecision({
      goalStatus: status, continuations: 0, startedAtMs: 0, nowMs: 0, limits: { wallClockMinutes: 60 },
    });
    assert.equal(decision.action, "stop");
    assert.match(decision.reason, new RegExp(`goal status is ${status}`));
  });
}

test("a missing goal never earns a continuation", () => {
  const decision = continuationDecision({
    goalStatus: undefined, continuations: 0, startedAtMs: 0, nowMs: 0, limits: { wallClockMinutes: 60 },
  });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /missing/);
});

// -------------------------------------------- premature receipt claims

const claims = {
  schemaVersion: "ExecutionReceiptClaimsV1",
  objective: { objectiveId: "ZEI-1", revision: 1, objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash },
  repository: {
    baseCommit: "3cb8238", headCommit: "3cb8238", branch: "paperclip/ZEI-1",
    diffHash: "sha256:" + "c".repeat(64),
    paths: [{ path: "bin/view.py", sha256: "sha256:" + "d".repeat(64) }],
  },
  checks: [], observations: ["implemented"], conclusions: ["ready"],
  unresolvedConditions: [], warnings: [],
  terminal: { status: "ready_for_review", stopReason: "completed" },
};
const receiptRun = {
  id: "run-1", status: "succeeded",
  startedAt: "2026-09-02T10:00:00.000Z", finishedAt: "2026-09-02T10:01:00.000Z",
  sessionIdAfter: "omp-session-1", usageJson: { costStatus: "reported", costUsd: 1.25 },
  contextSnapshot: { issueId: "issue-1", paperclipWorkspace: { cwd: "/tmp/wt", worktreePath: "/tmp/wt", branchName: "paperclip/ZEI-1" } },
  resultJson: { stopReason: "stop" },
};

test("a ready-for-review receipt is refused without a verified gate", () => {
  assert.throws(
    () => buildExecutionReceipt({ run: receiptRun, issueId: "issue-1", objective, claims }),
    /no verified goal gate/i,
  );
  assert.throws(
    () => buildExecutionReceipt({ run: receiptRun, issueId: "issue-1", objective, claims, goalGate: null }),
    /no verified goal gate/i,
  );
});

test("a ready-for-review receipt is refused when the gate is not the run's own proof", () => {
  assert.throws(
    () => buildExecutionReceipt({
      run: receiptRun, issueId: "issue-1", objective, claims,
      goalGate: validGate({ goalStatus: "active", terminal: false }),
    }),
    /goalStatus contradicts/,
  );
});

test("a verified gate admits a ready-for-review receipt", () => {
  const receipt = buildExecutionReceipt({
    run: receiptRun, issueId: "issue-1", objective, claims, goalGate: validGate(),
  });
  assert.equal(receipt.terminal.status, "ready_for_review");
});

for (const status of ["blocked", "failed", "cancelled"]) {
  test(`a ${status} receipt remains reportable without any gate`, () => {
    // An attempt that legitimately blocks must still be able to report; the
    // gate is required only for the one status that hands work to the
    // Reviewer.
    const blockedClaims = { ...claims, terminal: { status, stopReason: "blocked" } };
    const receipt = buildExecutionReceipt({ run: receiptRun, issueId: "issue-1", objective, claims: blockedClaims });
    assert.equal(receipt.terminal.status, status);
  });
}

test("even a complete gate cannot upgrade a blocked receipt", () => {
  const blockedClaims = { ...claims, terminal: { status: "blocked", stopReason: "blocked" } };
  const receipt = buildExecutionReceipt({
    run: receiptRun, issueId: "issue-1", objective, claims: blockedClaims, goalGate: validGate(),
  });
  assert.equal(receipt.terminal.status, "blocked");
});
