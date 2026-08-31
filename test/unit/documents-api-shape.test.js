"use strict";
// The issue-documents API renames its column on the way out.
//
//   node_modules/@paperclipai/server/dist/services/documents.js:48
//     ...(includeBody ? { body: row.latestBody } : {}),
//
// So the DATABASE column is `latestBody` and the JSON field is `body`. A GET
// never returns `latestBody` at all. Everything here pins the client to the
// shape the server actually emits, because the reconciler's entire guarantee is
// "compare against what the server really said" — and a comparison against a
// field the server never sends is not a comparison, it is a constant.
//
// This is the defect these tests were written to catch: the earlier fake server
// in apply.test.js returned `latestBody`, encoding the same wrong assumption as
// the code it was testing, so both agreed and both were wrong.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PaperclipApi } = require("../../lib/api");
const { applyPlan } = require("../../lib/apply");
const { planContractDocuments } = require("../../lib/plan");
const { hashText } = require("../../lib/util");

// A fake that mirrors services/documents.js: `body` on the wire, `latestBody`
// only in its own storage, a fresh revision id per write, and baseRevisionId
// REQUIRED on update (documents.js:291 — "Document update requires baseRevisionId").
function realisticServer({ existing = null } = {}) {
  const store = existing ? { ...existing } : null;
  const state = { doc: store, puts: [] };
  const wire = () => (state.doc === null ? null : {
    id: "doc-1", issueId: "issue-1", key: "spec",
    title: state.doc.title, format: state.doc.format,
    body: state.doc.latestBody,                    // <- the rename, as shipped
    latestRevisionId: state.doc.latestRevisionId,
    latestRevisionNumber: state.doc.latestRevisionNumber ?? 1,
  });
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (method === "GET") {
      const w = wire();
      return w
        ? { ok: true, status: 200, text: async () => JSON.stringify(w) }
        : { ok: false, status: 404, text: async () => JSON.stringify({ error: "Document not found" }) };
    }
    if (method === "PUT") {
      state.puts.push(body);
      if (state.doc) {
        if (!body.baseRevisionId) {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Document update requires baseRevisionId" }) };
        }
        if (body.baseRevisionId !== state.doc.latestRevisionId) {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Document was updated by someone else" }) };
        }
      }
      const n = state.puts.length;
      state.doc = {
        title: body.title, format: body.format, latestBody: body.body,
        latestRevisionId: `rev-${n}`, latestRevisionNumber: n,
      };
      // The update path echoes a STALE latestBody alongside the fresh body.
      // Nothing may depend on this response; the readback is a separate GET.
      return { ok: true, status: 200, text: async () => JSON.stringify({ ...wire(), latestBody: "STALE-ECHO" }) };
    }
    return { ok: false, status: 405, text: async () => "no" };
  };
  return { fetchImpl, state };
}

const DESIRED_BODY = "# ZEI-1 immutable objective\n";
function cfgAndSnap(live) {
  const cfg = {
    issues: [{
      identifier: "ZEI-1",
      objectiveDocument: {
        key: "spec", title: "ZEI-1 immutable objective (ObjectiveEnvelopeV1)",
        format: "markdown", body: DESIRED_BODY, bodyHash: hashText(DESIRED_BODY),
        changeSummary: "Install objective revision 1 (hash-bound)",
        objective: { revision: 1, objectiveHash: "sha256:" + "b".repeat(64), criteriaHash: "sha256:" + "c".repeat(64) },
      },
    }],
  };
  const snap = { issues: { "ZEI-1": { id: "issue-1" } }, issueDocuments: { "ZEI-1": live ? { spec: live } : {} } };
  return { cfg, snap };
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "factory-doc-"));
const planOf = (actions) => ({
  version: 1, planHash: "sha256:" + "0".repeat(64), configFile: "x", company: "ZEIROS", actions, snapshot: null,
});

test("an already-correct document is recognised as correct and plans NO action", () => {
  // This is the shape a GET really returns: `body`, no `latestBody`.
  const live = {
    title: "ZEI-1 immutable objective (ObjectiveEnvelopeV1)", format: "markdown",
    body: DESIRED_BODY, latestRevisionId: "rev-7",
  };
  const { cfg, snap } = cfgAndSnap(live);
  const actions = [];
  planContractDocuments(cfg, snap, actions);
  assert.deepEqual(actions, [],
    "comparing against a field the server never sends makes every document look permanently drifted");
});

test("applying the objective document verifies the readback against the field the server actually returns", async () => {
  const server = realisticServer();               // document does not exist yet
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const { cfg, snap } = cfgAndSnap(null);
  const actions = [];
  planContractDocuments(cfg, snap, actions);

  const stored = await applyPlan(api, { _root: tempRoot() }, planOf(actions));
  assert.equal(stored.receipt.outcome, "applied");
  assert.equal(server.state.doc.latestBody, DESIRED_BODY);
});

test("an update carries baseRevisionId, which this API requires rather than merely honours", async () => {
  const live = { title: "old title", format: "markdown", body: "old body\n", latestRevisionId: "rev-1" };
  const server = realisticServer({ existing: { title: "old title", format: "markdown", latestBody: "old body\n", latestRevisionId: "rev-1" } });
  server.state.puts.length = 0;
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const { cfg, snap } = cfgAndSnap(live);
  const actions = [];
  planContractDocuments(cfg, snap, actions);
  assert.equal(actions.length, 1, "changed content must plan an action");

  const stored = await applyPlan(api, { _root: tempRoot() }, planOf(actions));
  assert.equal(stored.receipt.outcome, "applied");
  assert.equal(server.state.puts[0].baseRevisionId, "rev-1",
    "documents.js:291 rejects an update with no baseRevisionId outright");
});

test("a stale baseRevisionId surfaces as a failure, not as a silent overwrite", async () => {
  const live = { title: "old title", format: "markdown", body: "old body\n", latestRevisionId: "rev-STALE" };
  const server = realisticServer({ existing: { title: "old title", format: "markdown", latestBody: "old body\n", latestRevisionId: "rev-1" } });
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const { cfg, snap } = cfgAndSnap(live);
  const actions = [];
  planContractDocuments(cfg, snap, actions);

  await assert.rejects(() => applyPlan(api, { _root: tempRoot() }, planOf(actions)), /409/);
  assert.equal(server.state.doc.latestBody, "old body\n", "the concurrent content must survive");
});

// The agent-token path has a hazard beyond 200-and-do-nothing: routes/issues.js
// passes lockedDocumentStrategy "create_new_document" for agent actors, so a PUT
// against a LOCKED document succeeds while writing somewhere else entirely.
test("a write that the server redirects to another key is caught by the readback", async () => {
  const server = realisticServer({ existing: { title: "old", format: "markdown", latestBody: "old body\n", latestRevisionId: "rev-1" } });
  const redirecting = async (url, opts = {}) => {
    if ((opts.method ?? "GET") === "PUT") {
      // Accepted, reported OK, and written to `spec-2` — the original is untouched.
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: "spec-2", redirectedFromLockedDocument: true }) };
    }
    return server.fetchImpl(url, opts);
  };
  const api = new PaperclipApi("http://x", { fetch: redirecting });
  const live = { title: "old", format: "markdown", body: "old body\n", latestRevisionId: "rev-1" };
  const { cfg, snap } = cfgAndSnap(live);
  const actions = [];
  planContractDocuments(cfg, snap, actions);

  await assert.rejects(
    () => applyPlan(api, { _root: tempRoot() }, planOf(actions)),
    /did not persist/,
    "a 2xx that wrote to a different key must fail the same way a dropped field does",
  );
});
