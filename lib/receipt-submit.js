"use strict";
// The Engineer's execution receipt, submitted as a TOOL CALL rather than typed.
//
// WHY THIS EXISTS. The receipt used to be a byte-exact text frame the Engineer
// had to remember to emit around JSON it had to assemble by hand — objective
// hashes, base and head commits, a diff hash, a sha256 per changed path. On
// 2026-09-02 the canary died on exactly that: the Engineer did the work
// correctly, fixed src/add.js, verified it, and wrote 500 characters of good
// prose with no frame in it. The Reviewer had nothing machine-readable to bind
// to and declined, which was the right call and a wasted $1.33.
//
// That is the same shape of problem as the goal gate: demanding byte-exact
// formatting from a model as a hard gate. Asking more loudly does not fix it —
// it lowers the failure rate and keeps the failure mode.
//
// SO THE SPLIT MOVED. The model supplies only what it is the authority on: what
// it observed, what it concluded, what remains unresolved, and how it is
// leaving the issue. Everything mechanical — the commits, the diff hash, the
// per-path digests, the objective binding — is DERIVED here from the worktree
// and the spec document, where it can be computed correctly every time. A hash
// a model transcribes is a hash that can be wrong; a hash the tool computes
// cannot be.
//
// The result is written as an issue document rather than left in the run
// summary. The summary is a lossy channel — the adapter truncates it, and
// lib/execution-receipt.js already carries a whole fallback path for reading
// the run log when it does. A document is durable, addressable, survives
// worktree teardown, and is readable through the same API the Reviewer already
// uses.

const { FactoryError, hashValue } = require("./util");

const RECEIPT_DOCUMENT_KEY = "execution-receipt";

/** The judgement half — the only half a model is the authority on. */
const SUPPLIED_KEYS = ["observations", "conclusions", "unresolvedConditions", "warnings", "checks", "terminal"];

const TERMINAL_STATUSES = ["ready_for_review", "blocked", "abandoned"];

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new FactoryError(`execution receipt: ${field} must be an array of strings`);
  }
  return value;
}

/**
 * Assemble ExecutionReceiptClaimsV1 from the model's judgement plus derived
 * facts. Shape errors are raised HERE, where the tool can report them back to
 * the model in the same turn — not later, in a reader, after the run has ended
 * and the money is spent.
 */
function buildClaims({ supplied, objective, repository }) {
  const extras = Object.keys(supplied ?? {}).filter((k) => !SUPPLIED_KEYS.includes(k));
  if (extras.length) {
    throw new FactoryError(
      `execution receipt: unexpected field(s) ${extras.join(", ")}. The tool derives objective and ` +
      `repository itself; supply only ${SUPPLIED_KEYS.join(", ")}.`);
  }
  const terminal = supplied?.terminal;
  if (!terminal || typeof terminal !== "object" || !TERMINAL_STATUSES.includes(terminal.status)) {
    throw new FactoryError(
      `execution receipt: terminal.status must be one of ${TERMINAL_STATUSES.join(", ")}`);
  }
  if (typeof terminal.stopReason !== "string" || !terminal.stopReason.trim()) {
    throw new FactoryError("execution receipt: terminal.stopReason must be a non-empty string");
  }
  if (!Array.isArray(supplied.checks)) {
    throw new FactoryError("execution receipt: checks must be an array");
  }
  for (const field of ["observations", "conclusions", "unresolvedConditions", "warnings"]) {
    assertStringArray(supplied[field], field);
  }
  // A ready-for-review terminal with nothing observed and nothing concluded is
  // a receipt that asserts completion while carrying no account of it.
  if (terminal.status === "ready_for_review" && !supplied.observations.length && !supplied.conclusions.length) {
    throw new FactoryError(
      "execution receipt: a ready_for_review receipt must record what you observed and what you concluded");
  }
  if (!repository || !Array.isArray(repository.paths)) {
    throw new FactoryError("execution receipt: derived repository state is incomplete");
  }
  if (!objective?.objectiveId) {
    throw new FactoryError("execution receipt: the issue's objective could not be resolved");
  }

  return {
    schemaVersion: "ExecutionReceiptClaimsV1",
    objective: {
      objectiveId: objective.objectiveId,
      revision: objective.revision,
      objectiveHash: objective.objectiveHash,
      criteriaHash: objective.criteriaHash,
    },
    repository,
    checks: supplied.checks,
    observations: supplied.observations,
    conclusions: supplied.conclusions,
    unresolvedConditions: supplied.unresolvedConditions,
    warnings: supplied.warnings,
    terminal: { status: terminal.status, stopReason: terminal.stopReason },
  };
}

function receiptDocumentPath(issueId) {
  return `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(RECEIPT_DOCUMENT_KEY)}`;
}

/**
 * Write the claims as an issue document, with the same readback discipline
 * every other write here uses: a 200 that did not persist is an error.
 */
async function writeReceiptDocument({ api, issueId, runId, claims }) {
  const docPath = receiptDocumentPath(issueId);
  const live = await api.getOptional(docPath);
  const body = JSON.stringify({ runId, claims }, null, 2);
  const put = {
    title: `${claims.objective.objectiveId} execution receipt (ExecutionReceiptClaimsV1)`,
    format: "markdown",
    body,
    changeSummary: `Execution receipt for run ${runId}: ${claims.terminal.status}`,
  };
  if (live?.latestRevisionId) put.baseRevisionId = live.latestRevisionId;

  try {
    await api.mutate({
      readPath: docPath, writePath: docPath, method: "PUT", body: put,
      allow: ["title", "format", "body", "changeSummary", "baseRevisionId"],
      expect: [{ path: "body", value: body }],
      allowMissingBefore: live === null,
    });
  } catch (err) {
    // SURFACE WHY, NOT JUST THAT. lib/api.js captures the server's response
    // body in err.details, and a tool that reports only "HTTP 403" throws that
    // away — the agent cannot act on it, and neither can whoever reads the run
    // log afterwards. This is the same "run diagnostics are unreachable" class
    // the audit flagged, reintroduced one layer up.
    //
    // Measured 2026-09-02: the canary's Engineer called this tool correctly and
    // the write returned 403. The reason was in the response body and was lost
    // here, which turned a one-line diagnosis into a source-reading exercise.
    const detail = err?.details?.body;
    if (detail) err.message = `${err.message} — ${String(detail).slice(0, 600)}`;
    // NAME THE ORDERING MISTAKE, because the server's own message does not.
    // Setting the disposition first reassigns the issue, and the write is then
    // refused as "another agent's issue" — which reads like a permissions
    // problem and is actually a sequencing one. The canary lost a $1.19 run to
    // exactly this: correct work, correct tool call, receipt discarded.
    if (err?.details?.status === 403) {
      err.message = `${err.message}\n\nIf you have already set this issue's disposition, that is the ` +
        `cause: it reassigned the issue and you are no longer the assignee. The receipt must be ` +
        `submitted BEFORE the disposition.`;
    }
    throw err;
  }
  return { docPath, body, claimsHash: hashValue(claims) };
}

/** Read a receipt document back. Absence returns null; a malformed one throws. */
async function readReceiptDocument({ api, issueId, runId }) {
  const raw = await api.getOptional(receiptDocumentPath(issueId));
  const body = raw?.body ?? raw?.latestBody;
  if (typeof body !== "string" || !body.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (err) {
    throw new FactoryError(`execution receipt document is not valid JSON: ${err.message}`, { issueId });
  }
  // A receipt from a DIFFERENT run must not be read as this run's account.
  // Silently accepting it would let a stale receipt approve new work.
  if (runId && parsed?.runId && parsed.runId !== runId) return null;
  return parsed?.claims ?? null;
}

module.exports = {
  RECEIPT_DOCUMENT_KEY, SUPPLIED_KEYS, TERMINAL_STATUSES,
  buildClaims, writeReceiptDocument, readReceiptDocument, receiptDocumentPath,
};
