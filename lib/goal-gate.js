"use strict";
// The goal gate: the mechanically verifiable record that an Engineer run
// ended with its OWN native goal completed against the canonical objective.
//
// TRUST MODEL (Contract C6). The Engineer model cannot forge this record:
// omp/worktree-guard.js blocks every agent write tool whose target lies
// outside the assigned worktree, while ops/omp-bwrap.sh binds
// ~/.omp/paperclip writable — so a factory-owned extension can write there
// and the Engineer cannot. The control plane therefore treats the gate's
// absence or inconsistency as disproof. Presence proves only what the record
// itself states, and every statement in it is re-checked below against the
// authoritative run, issue, and objective.
//
// The runtime extension (omp/plugins/paperclip-goal-guard) and this module
// share the exact objective-matching and continuation rules, so the runtime
// and the control plane cannot drift: the extension imports these functions
// through createRequire rather than restating them.

const path = require("node:path");
const { FactoryError, canonical, clone, deepEqual, hashText } = require("./util");
const { validateContract, verifyObjectiveHashes } = require("./contracts");

const GOAL_GATE_FILENAME_PREFIX = "goal-gate-";

// ---------------------------------------------------------------- the rule
//
// THE EXACT GOAL-OBJECTIVE CANONICALIZATION RULE.
//
// The spec document body is markdown wrapping a fenced ```json block whose
// content is the ObjectiveEnvelopeV1 (lib/contracts.js#renderObjectiveDocument).
// Once verifyObjectiveHashes has proved that envelope self-consistent, the
// one text the Engineer may put in the native goal's `objective` is:
//
//   canonicalGoalObjective(envelope)
//
// — the envelope with its `objectiveHash` member deleted, serialized as
// canonical JSON (keys sorted at every depth, no insignificant whitespace,
// undefined dropped — lib/util.js#canonical). That text is exactly the value
// whose sha256 the envelope records as objectiveHash:
//
//   hashText(goal.objective) === envelope.objectiveHash
//
// so the rule is checkable by text equality and by hash, and the two agree.
// The Engineer CAN satisfy it mechanically: the spec body it is handed
// contains the envelope; deleting one member and serializing canonically is a
// one-line node/jq command, and the result is what the native goal tool's
// `create` op takes as its objective. Anything else — a paraphrase, the
// pretty-printed fence exactly as served, a re-ordered object — hashes
// differently and fails the gate. A failed match is never redeemed later in
// the attempt: the FIRST goal must match, and every later observed goal must
// match too.

/** The one legal goal objective text: canonical JSON of the envelope minus
 * its own objectiveHash member. */
function canonicalGoalObjective(objective) {
  const hashable = clone(objective);
  delete hashable.objectiveHash;
  return canonical(hashable);
}

/** Does a goal's objective text satisfy the rule above? The specObjective
 * must already have passed verifyObjectiveHashes. */
function goalObjectiveTextMatchesSpec({ goalObjectiveText, specObjective }) {
  return typeof goalObjectiveText === "string"
    && hashText(goalObjectiveText) === specObjective.objectiveHash;
}

/** Extract and self-verify the ObjectiveEnvelopeV1 from a spec document body.
 * Throws FactoryError for anything that is not a hash-consistent envelope —
 * the extension treats that as "no acceptable spec", writes no gate, and the
 * control plane then refuses the run for the gate's absence. */
function objectiveFromSpecDocument(body) {
  if (typeof body !== "string" || !body.trim()) {
    throw new FactoryError("spec document has no body to derive an objective from");
  }
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!fence) {
    throw new FactoryError("spec document body carries no fenced json objective envelope");
  }
  let envelope;
  try { envelope = JSON.parse(fence[1]); }
  catch (err) { throw new FactoryError(`spec document objective envelope is not valid JSON: ${err.message}`); }
  return verifyObjectiveHashes(envelope);
}

// ------------------------------------------------------- bounded continuation
//
// The extension may schedule exactly ONE continuation per settle, and only
// while a validated goal is still active. Two hard bounds stop it from ever
// looping unbounded:
//   - a continuation COUNT bound: a constant, because ObjectiveEnvelopeV1
//     forbids extra keys in `limits`, so the envelope cannot carry one;
//   - a WALL-CLOCK bound: read from the objective's own
//     limits.wallClockMinutes when present, else a conservative default.
const DEFAULT_MAX_GOAL_CONTINUATIONS = 3;
const DEFAULT_GOAL_CONTINUATION_WALL_CLOCK_MINUTES = 30;

/** Pure decision: continue or stop? "stop" at either bound, and for every
 * non-active goal status. A missing or unusable clock stops rather than
 * risking an unbounded loop — the count bound alone is not enough proof of
 * termination when the host clock is the only witness to elapsed time. */
function continuationDecision({ goalStatus, continuations, startedAtMs, nowMs, limits }) {
  const count = Number.isInteger(continuations) && continuations > 0 ? continuations : 0;
  if (goalStatus !== "active") {
    return {
      action: "stop",
      reason: `goal status is ${goalStatus ?? "missing"}; a continuation is only ever scheduled for a validated active goal`,
    };
  }
  if (count >= DEFAULT_MAX_GOAL_CONTINUATIONS) {
    return {
      action: "stop",
      reason: `continuation budget of ${DEFAULT_MAX_GOAL_CONTINUATIONS} exhausted; the attempt must settle`,
    };
  }
  const minutes = Number.isFinite(limits?.wallClockMinutes) && limits.wallClockMinutes >= 1
    ? limits.wallClockMinutes
    : DEFAULT_GOAL_CONTINUATION_WALL_CLOCK_MINUTES;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)
    || typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return { action: "stop", reason: "no usable clock to bound a continuation; refusing rather than looping" };
  }
  const elapsedMs = nowMs - startedAtMs;
  if (elapsedMs >= minutes * 60000) {
    return {
      action: "stop",
      reason: `wall-clock bound of ${minutes} minutes exhausted; the attempt must settle`,
    };
  }
  return {
    action: "continue",
    reason: `goal active; ${DEFAULT_MAX_GOAL_CONTINUATIONS - count} continuations and `
      + `${Math.max(0, minutes * 60000 - elapsedMs)}ms of wall clock remain`,
  };
}

// ------------------------------------------------------------ the gate file

function goalGateFilename(runId) {
  if (typeof runId !== "string" || !runId) throw new FactoryError("a goal gate filename requires a run id");
  return `${GOAL_GATE_FILENAME_PREFIX}${runId}.json`;
}

/** Load a run's gate from run.sessionParams.sessionDir (the omp adapter
 * persists {sessionId, cwd, sessionDir} there — verified in its toResult).
 * Absence is NOT an error here: the caller decides whether a missing gate is
 * fatal. Everything else — a run with no sessionDir, an unreadable file, a
 * record that is not JSON — is, because each of those means the control plane
 * cannot establish what the run's own runtime recorded. */
function loadGoalGate({ run, readFile }) {
  if (typeof readFile !== "function") throw new FactoryError("loadGoalGate requires an injected readFile");
  const runId = run?.id;
  if (typeof runId !== "string" || !runId) throw new FactoryError("loadGoalGate requires a run with an id");
  const sessionDir = run?.sessionParams?.sessionDir;
  if (typeof sessionDir !== "string" || !sessionDir) {
    throw new FactoryError(
      `run ${runId} carries no sessionParams.sessionDir, so its goal-gate record cannot be located`,
      { runId },
    );
  }
  const gatePath = path.join(sessionDir, goalGateFilename(runId));
  let text;
  try { text = readFile(gatePath); }
  catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  if (text === null || text === undefined) return null;
  let gate;
  try { gate = JSON.parse(text); }
  catch (err) {
    throw new FactoryError(`goal gate record at ${gatePath} is not valid JSON: ${err.message}`, { path: gatePath });
  }
  return { gate, path: gatePath };
}

/** One failed invariant, named, with its expected and observed values. */
function gateMismatch(field, expected, observed) {
  return new FactoryError(
    `goal gate ${field} contradicts the authoritative ${field}: `
    + `expected ${JSON.stringify(expected ?? null)}, observed ${JSON.stringify(observed ?? null)}`,
    { field, expected: expected ?? null, observed: observed ?? null },
  );
}

/** Verify a gate against the authoritative run, issue, and objective.
 * Throws a FactoryError naming the exact failed invariant for every case in
 * Contract C8; returns the gate only when every check passes. Beyond C8's
 * list, goalObjectiveHash must also equal the authoritative objectiveHash —
 * that field is the gate's own proof that the goal text hashed to the spec,
 * and a gate whose proof points at a different spec is not this run's gate. */
function assertGoalGate({ gate, run, issueId, objective }) {
  if (!gate) {
    throw new FactoryError(
      "no verified goal gate: the run produced no goal-gate record proving its native goal complete, "
      + "so its ready-for-review work cannot be admitted",
      { runId: run?.id ?? null, issueId: issueId ?? null },
    );
  }
  validateContract("EngineerGoalGateV1", gate);
  if (gate.runId !== run.id) throw gateMismatch("runId", run.id, gate.runId);
  if (gate.taskId !== issueId) throw gateMismatch("taskId", issueId, gate.taskId);
  if (gate.sessionId !== run.sessionIdAfter) throw gateMismatch("sessionId", run.sessionIdAfter, gate.sessionId);
  const binding = {
    objectiveId: objective.objectiveId, revision: objective.revision,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  };
  for (const [field, expected] of Object.entries(binding)) {
    if (!deepEqual(gate[field], expected)) throw gateMismatch(field, expected, gate[field]);
  }
  if (!deepEqual(gate.goalObjectiveHash, objective.objectiveHash)) {
    throw gateMismatch("goalObjectiveHash", objective.objectiveHash, gate.goalObjectiveHash);
  }
  if (gate.goalStatus !== "complete") throw gateMismatch("goalStatus", "complete", gate.goalStatus);
  if (gate.terminal !== true) throw gateMismatch("terminal", true, gate.terminal);
  return gate;
}

module.exports = {
  GOAL_GATE_FILENAME_PREFIX, goalGateFilename, loadGoalGate, assertGoalGate,
  canonicalGoalObjective, goalObjectiveTextMatchesSpec, objectiveFromSpecDocument,
  continuationDecision, DEFAULT_MAX_GOAL_CONTINUATIONS,
  DEFAULT_GOAL_CONTINUATION_WALL_CLOCK_MINUTES,
};
