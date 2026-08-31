"use strict";
// apply/rollback integration over the upsert kinds: an upsert that found a
// prior object is revertible and rollback restores the exact prior bytes; an
// upsert that created the object is NOT revertible and rollback refuses it
// rather than deleting anything.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PaperclipApi } = require("../../lib/api");
const { applyPlan, rollback } = require("../../lib/apply");
const { planContractDocuments, planAgentInstructions } = require("../../lib/plan");
const receipts = require("../../lib/receipts");
const { FactoryError, hashText } = require("../../lib/util");

// A fake Paperclip with per-path state, 404 for unknown keys, and a server-side
// revision id minted on every document PUT — the optimistic-concurrency shape.
function fakeServer({ documents = {} } = {}) {
  const state = { documents: new Map(Object.entries(documents)) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const path_ = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path: path_, body: opts.body ? JSON.parse(opts.body) : undefined });
    const m = /^\/api\/issues\/([^/]+)\/documents\/(\S+)$/.exec(path_);
    if (!m) return { ok: false, status: 404, text: async () => "not found" };
    const [, issueId, key] = m;
    if (method === "GET") {
      const doc = state.documents.get(`${issueId}/${key}`);
      if (!doc) return { ok: false, status: 404, text: async () => "not found" };
      return { ok: true, status: 200, text: async () => JSON.stringify(doc) };
    }
    if (method === "PUT") {
      const id = `${issueId}/${key}`;
      const prior = state.documents.get(id);
      const body = calls[calls.length - 1].body;
      if (body.baseRevisionId && prior && body.baseRevisionId !== prior.latestRevisionId) {
        return { ok: false, status: 409, text: async () => "revision conflict" };
      }
      // `body` on the wire, matching services/documents.js:48 which maps
      // `body: row.latestBody`. A fake that emits `latestBody` agrees with a
      // client that reads `latestBody`, and both are wrong together.
      const doc = {
        title: body.title, format: body.format, body: body.body,
        latestRevisionId: `rev-${calls.filter((c) => c.method === "PUT").length}`,
      };
      state.documents.set(id, doc);
      return { ok: true, status: 200, text: async () => JSON.stringify(doc) };
    }
    return { ok: false, status: 405, text: async () => "no" };
  };
  return { fetchImpl, state, calls };
}

// Build the upsert action through the REAL planner so the applied action
// carries the planner-declared restore/restoreMutation, exercising the
// planner -> apply -> rollback pipeline rather than a hand-built shape.
function plannerUpsertActions({ live = null, desiredBody = "new body", desiredTitle = "new" } = {}) {
  const cfg = {
    issues: [{
      identifier: "ZEI-1",
      objectiveDocument: {
        key: "spec", title: desiredTitle, format: "markdown",
        body: desiredBody, bodyHash: hashText(desiredBody),
        changeSummary: "Install objective revision 1",
        objective: {
          revision: 1, objectiveHash: "sha256:" + "b".repeat(64),
          criteriaHash: "sha256:" + "c".repeat(64),
        },
      },
    }],
  };
  const snap = {
    issues: { "ZEI-1": { id: "issue-1" } },
    issueDocuments: { "ZEI-1": live ? { spec: live } : {} },
  };
  const actions = [];
  planContractDocuments(cfg, snap, actions);
  assert.equal(actions.length, 1, "planner must plan exactly one upsert action");
  return actions;
}

const upsertAction = (desired, live) => plannerUpsertActions({
  live, desiredBody: desired.body, desiredTitle: desired.title,
})[0];

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "factory-apply-"));
}

const planOf = (actions) => ({
  version: 1, planHash: "sha256:" + "0".repeat(64), configFile: "x", company: "ZEIROS",
  actions, snapshot: null,
});

const cfgOf = (root) => ({ _root: root });

test("apply of an upsert over an EXISTING document is revertible and records the exact prior state", async () => {
  const root = tempRoot();
  const live = { title: "old", format: "markdown", body: "old body", latestRevisionId: "rev-0" };
  const server = fakeServer({ documents: { "issue-1/spec": live } });
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const action = upsertAction({ title: "new", body: "new body" }, live);

  const stored = await applyPlan(api, cfgOf(root), planOf([action]));
  assert.equal(stored.receipt.outcome, "applied");
  const r = stored.receipt.actions[0];
  assert.equal(r.status, "applied");
  assert.equal(r.revertible, true, "an upsert that found a prior object must be revertible");
  assert.equal(r.reason_not_revertible, null);
  assert.deepEqual(r.restore, {
    title: "old", format: "markdown", body: "old body", latestRevisionId: "rev-0",
  });
  assert.equal(r.readback.body, "new body");
});

test("apply of a CREATING upsert (404 before) is applied but marked NOT revertible, and rollback refuses it", async () => {
  const root = tempRoot();
  const server = fakeServer();
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const action = upsertAction({ title: "new", body: "new body" }, null);

  const stored = await applyPlan(api, cfgOf(root), planOf([action]));
  const r = stored.receipt.actions[0];
  assert.equal(r.status, "applied");
  assert.equal(r.revertible, false, "a creating upsert must never be auto-rolled-back");
  assert.match(r.reason_not_revertible, /deletion is destructive/);
  // The object really was created server-side.
  assert.equal(server.state.documents.get("issue-1/spec").body, "new body");

  await assert.rejects(
    () => rollback(api, cfgOf(root), stored.receipt.id),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /non-revertible/);
      return true;
    },
  );
  // And the refusal deleted nothing.
  assert.equal(server.state.documents.get("issue-1/spec").body, "new body");
});

test("rollback restores the exact prior document bytes and independently verifies them", async () => {
  const root = tempRoot();
  const live = { title: "old", format: "markdown", body: "old body", latestRevisionId: "rev-0" };
  const server = fakeServer({ documents: { "issue-1/spec": live } });
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const action = upsertAction({ title: "new", body: "new body" }, live);

  const applied = await applyPlan(api, cfgOf(root), planOf([action]));
  assert.equal(server.state.documents.get("issue-1/spec").body, "new body");

  const rolled = await rollback(api, cfgOf(root), applied.receipt.id);
  assert.equal(rolled.receipt.outcome, "restored");
  assert.ok(rolled.receipt.verification.length > 0);
  assert.ok(rolled.receipt.verification.every((v) => v.ok));
  const doc = server.state.documents.get("issue-1/spec");
  assert.equal(doc.body, "old body");
  assert.equal(doc.title, "old");
  assert.equal(doc.format, "markdown");
  // A restoring PUT mints a NEW server revision id (append-only revisions);
  // what must come back exactly is the CONTENT, not the minted identity.
  assert.notEqual(doc.latestRevisionId, "rev-0");
  assert.notEqual(doc.latestRevisionId, "rev-1");
});

test("apply stops at the first failed action and the receipt records the failure", async () => {
  const root = tempRoot();
  // Server accepts the PUT but never persists — the 200-and-do-nothing class.
  const calls = [];
  const live = { title: "old", format: "markdown", body: "old body", latestRevisionId: "rev-0" };
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    calls.push(method);
    return { ok: true, status: 200, text: async () => JSON.stringify(live) };
  };
  const api = new PaperclipApi("http://x", { fetch: fetchImpl });
  const actions = [
    upsertAction({ title: "new", body: "new body" }, live),
    upsertAction({ title: "later", body: "later body" }, live),
  ];
  await assert.rejects(
    () => applyPlan(api, cfgOf(root), planOf(actions)),
    (err) => { assert.match(err.message, /did not persist/); return true; },
  );
  // Read the receipt apply wrote before failing: first action failed, second never attempted.
  const written = receipts.list(root);
  assert.equal(written.length, 1);
  assert.equal(written[0].outcome, "failed");
  assert.equal(written[0].actions[0].status, "failed");
  assert.equal(written[0].actions.length, 1, "fail-fast: no action after the failure");
});

test("rollback refuses to clobber a document written concurrently after the apply", async () => {
  const root = tempRoot();
  const live = { title: "old", format: "markdown", body: "old body", latestRevisionId: "rev-0" };
  const server = fakeServer({ documents: { "issue-1/spec": live } });
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });
  const action = upsertAction({ title: "new", body: "new body" }, live);

  const applied = await applyPlan(api, cfgOf(root), planOf([action]));
  assert.equal(applied.receipt.actions[0].readback.latestRevisionId, "rev-1");

  // A THIRD PARTY writes the same document between apply and rollback. The
  // restoring PUT must be bound to the revision the apply actually produced, so
  // this concurrent write makes rollback conflict instead of silently
  // overwriting someone else's content.
  await server.fetchImpl("http://x/api/issues/issue-1/documents/spec", {
    method: "PUT",
    body: JSON.stringify({ title: "concurrent", format: "markdown", body: "concurrent body" }),
  });
  assert.equal(server.state.documents.get("issue-1/spec").body, "concurrent body");

  await assert.rejects(
    () => rollback(api, cfgOf(root), applied.receipt.id),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /rollback failed/);
      return true;
    },
  );
  assert.equal(
    server.state.documents.get("issue-1/spec").body, "concurrent body",
    "a conflicting rollback must leave the concurrent write intact, not clobber it",
  );
});

// The instruction-bundle upsert takes apply's GENERIC restore path (restore
// derived from allow ∩ before), not the document path's declared
// restoreMutation. It needs its own proof.
function fakeBundleServer({ files = {} } = {}) {
  const state = { files: new Map(Object.entries(files)) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const path_ = url.replace(/^https?:\/\/[^/]+/, "");
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, path: path_, body });
    const m = /^\/api\/agents\/([^/]+)\/instructions-bundle\/file/.exec(path_);
    if (!m) return { ok: false, status: 404, text: async () => "not found" };
    const agentId = m[1];
    if (method === "GET") {
      const key = new URL(url).searchParams.get("path");
      const file = state.files.get(`${agentId}/${key}`);
      if (!file) return { ok: false, status: 404, text: async () => "not found" };
      return { ok: true, status: 200, text: async () => JSON.stringify(file) };
    }
    if (method === "PUT") {
      const file = { path: body.path, content: body.content };
      state.files.set(`${agentId}/${body.path}`, file);
      return { ok: true, status: 200, text: async () => JSON.stringify(file) };
    }
    return { ok: false, status: 405, text: async () => "no" };
  };
  return { fetchImpl, state, calls };
}

test("rollback of an instruction-bundle upsert restores the exact prior file content", async () => {
  const root = tempRoot();
  const priorFile = { path: "AGENTS.md", content: "# prior engineer instructions\n" };
  const server = fakeBundleServer({ files: { "agent-1/AGENTS.md": priorFile } });
  const api = new PaperclipApi("http://x", { fetch: server.fetchImpl });

  const desiredContent = "# new engineer instructions\n";
  const cfg = {
    agents: [{
      name: "OMP Engineer",
      instructions: { path: "AGENTS.md", bundle: "engineer", content: desiredContent, sha256: hashText(desiredContent) },
    }],
  };
  const snap = {
    agents: { "OMP Engineer": { id: "agent-1" } },
    agentInstructions: { "OMP Engineer": priorFile },
  };
  const actions = [];
  planAgentInstructions(cfg, snap, actions);
  assert.equal(actions.length, 1, "planner must plan exactly one instruction upsert");

  const applied = await applyPlan(api, cfgOf(root), planOf(actions));
  const r = applied.receipt.actions[0];
  assert.equal(r.revertible, true);
  assert.deepEqual(r.restore, { path: "AGENTS.md", content: priorFile.content });
  assert.equal(server.state.files.get("agent-1/AGENTS.md").content, desiredContent);

  const rolled = await rollback(api, cfgOf(root), applied.receipt.id);
  assert.equal(rolled.receipt.outcome, "restored");
  assert.ok(rolled.receipt.verification.length > 0);
  assert.ok(rolled.receipt.verification.every((v) => v.ok));
  assert.equal(server.state.files.get("agent-1/AGENTS.md").content, priorFile.content);
});
