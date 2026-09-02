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
  buildClaims, writeReceiptDocument, readReceiptDocument, receiptDocumentPath,
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
  checks: [{ name: "unit", command: "node --test test/add.test.js", exitCode: 0, passed: true }],
  terminal: { status: "ready_for_review", stopReason: "completed" },
  ...over,
});

// ---- the split ----------------------------------------------------------

test("the model supplies judgement only", () => {
  assert.deepEqual(SUPPLIED_KEYS.sort(),
    ["checks", "conclusions", "observations", "terminal", "unresolvedConditions", "warnings"]);
  for (const forbidden of ["objective", "repository", "schemaVersion"]) {
    assert.ok(!SUPPLIED_KEYS.includes(forbidden),
      `${forbidden} must be derived; a model that can supply it can supply it wrong`);
  }
});

test("claims assemble into the shape the reader already validates", () => {
  const claims = buildClaims({ supplied: supplied(), objective, repository });
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
  assert.throws(() => buildClaims({ supplied: supplied({ terminal: { status: "done", stopReason: "x" } }), objective, repository }),
    /ready_for_review, blocked, abandoned/);
  for (const status of ["ready_for_review", "blocked", "abandoned"]) {
    assert.doesNotThrow(() => buildClaims({
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
  assert.throws(() => buildClaims({ supplied: supplied({ terminal: { status: "blocked", stopReason: "  " } }), objective, repository }),
    /stopReason/);
});

test("a ready_for_review receipt asserting nothing observed or concluded is refused", () => {
  assert.throws(
    () => buildClaims({ supplied: supplied({ observations: [], conclusions: [] }), objective, repository }),
    /what you observed and what you concluded/);
});

test("the array fields must actually be arrays of strings", () => {
  for (const field of ["observations", "conclusions", "unresolvedConditions", "warnings"]) {
    assert.throws(() => buildClaims({ supplied: supplied({ [field]: "a string" }), objective, repository }),
      new RegExp(field));
    assert.throws(() => buildClaims({ supplied: supplied({ [field]: [{ not: "a string" }] }), objective, repository }),
      new RegExp(field));
  }
});

test("an empty unresolvedConditions is legal — it is a claim, not an omission", () => {
  assert.doesNotThrow(() => buildClaims({ supplied: supplied({ unresolvedConditions: [] }), objective, repository }));
});

test("derived state that failed to resolve refuses rather than writing a hollow receipt", () => {
  assert.throws(() => buildClaims({ supplied: supplied(), objective, repository: { paths: null } }),
    /repository state is incomplete/);
  assert.throws(() => buildClaims({ supplied: supplied(), objective: {}, repository }),
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
  const claims = buildClaims({ supplied: supplied(), objective, repository });
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
  const claims = buildClaims({ supplied: supplied(), objective, repository });
  await writeReceiptDocument({ api, issueId: "i1", runId: "run-1", claims });
  assert.equal(api.state.doc.latestRevisionId, "rev-1");
});

test("the document records which run it belongs to", async () => {
  const api = fakeApi();
  const claims = buildClaims({ supplied: supplied(), objective, repository });
  await writeReceiptDocument({ api, issueId: "i1", runId: "run-42", claims });
  assert.equal(JSON.parse(api.state.doc.body).runId, "run-42");
});

// ---- the read -----------------------------------------------------------

test("reading returns the claims for the matching run", async () => {
  const claims = buildClaims({ supplied: supplied(), objective, repository });
  const api = { getOptional: async () => ({ body: JSON.stringify({ runId: "run-1", claims }) }) };
  assert.deepEqual(await readReceiptDocument({ api, issueId: "i1", runId: "run-1" }), claims);
});

test("a receipt from another run reads as absent — a stale account must not approve new work", async () => {
  const claims = buildClaims({ supplied: supplied(), objective, repository });
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
