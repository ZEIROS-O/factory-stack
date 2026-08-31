"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PaperclipApi } = require("../../lib/api");
const { FactoryError, hashValue } = require("../../lib/util");
const { compareExecutionPolicy, compareWorkspaceStrategy } = require("../../lib/semdiff");
const { validate, expandVars, stripComments } = require("../../lib/config");
const { planContractDocuments, planAgentInstructions } = require("../../lib/plan");

// A fake Paperclip. `drop` names fields the server silently discards while still
// answering 200 — the exact behaviour this system exists to catch.
function fakeServer({ initial, drop = [], status = 200 }) {
  const state = { ...initial };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify(state) };
    }
    const body = JSON.parse(opts.body);
    for (const [k, v] of Object.entries(body)) {
      if (drop.includes(k)) continue;                 // silently dropped, no error
      state[k] = v;
    }
    // 200 and the full object back, exactly as the real server does.
    return { ok: status < 400, status, text: async () => JSON.stringify(state) };
  };
  return { fetchImpl, calls, state };
}

const api = (server) => new PaperclipApi("http://x", { fetch: server.fetchImpl });

test("HTTP 200 with the managed field silently dropped is a FAILURE, not a success", async () => {
  const server = fakeServer({
    initial: { id: "i1", executionWorkspacePreference: null },
    drop: ["executionWorkspacePreference"],
  });
  await assert.rejects(
    () => api(server).mutate({
      readPath: "/api/issues/i1",
      body: { executionWorkspacePreference: "isolated_workspace" },
      allow: ["executionWorkspacePreference"],
      expect: [{ path: "executionWorkspacePreference", value: "isolated_workspace" }],
    }),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /did not persist/);
      assert.match(err.message, /200-and-do-nothing/);
      assert.equal(err.details.failures[0].path, "executionWorkspacePreference");
      assert.equal(err.details.failures[0].actual, null);
      return true;
    },
  );
  // And the PATCH really was sent — this is a readback failure, not a skipped write.
  assert.ok(server.calls.some((c) => c.method === "PATCH"));
});

test("EVERY managed field dropped is still caught, and all failures are reported", async () => {
  const server = fakeServer({
    initial: { id: "i1", projectId: null, executionWorkspacePreference: null, executionWorkspaceSettings: null },
    drop: ["executionWorkspacePreference", "executionWorkspaceSettings"],
  });
  await assert.rejects(
    () => api(server).mutate({
      readPath: "/api/issues/i1",
      body: {
        projectId: "p1",
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      allow: ["projectId", "executionWorkspacePreference", "executionWorkspaceSettings"],
      expect: [
        { path: "projectId", value: "p1" },
        { path: "executionWorkspacePreference", value: "isolated_workspace" },
        { path: "executionWorkspaceSettings.mode", value: "isolated_workspace" },
      ],
    }),
    (err) => {
      // projectId landed; the two workspace fields vanished. Exactly the shape of
      // the real incident that produced this system.
      assert.equal(err.details.failures.length, 2);
      return true;
    },
  );
});

test("a write that fully persists verifies and returns before/after", async () => {
  const server = fakeServer({ initial: { id: "i1", reviewPolicy: null } });
  const out = await api(server).mutate({
    readPath: "/api/issues/i1",
    body: { reviewPolicy: "not_creator" },
    allow: ["reviewPolicy"],
    expect: [{ path: "reviewPolicy", value: "not_creator" }],
  });
  assert.equal(out.verified, true);
  assert.equal(out.before.reviewPolicy, null);
  assert.equal(out.after.reviewPolicy, "not_creator");
});

test("a body touching a non-allowlisted field is refused BEFORE any request", async () => {
  const server = fakeServer({ initial: { id: "i1" } });
  await assert.rejects(
    () => api(server).mutate({
      readPath: "/api/issues/i1",
      body: { reviewPolicy: "not_creator", status: "done" },
      allow: ["reviewPolicy"],
      expect: [],
    }),
    (err) => { assert.match(err.message, /non-allowlisted fields: status/); return true; },
  );
  assert.equal(server.calls.length, 0, "nothing may be sent when the body is out of bounds");
});

test("a non-2xx response raises rather than being read back as success", async () => {
  const server = fakeServer({ initial: { id: "i1" }, status: 500 });
  await assert.rejects(
    () => api(server).mutate({
      readPath: "/api/issues/i1", body: { reviewPolicy: "x" },
      allow: ["reviewPolicy"], expect: [],
    }),
    (err) => { assert.match(err.message, /HTTP 500/); return true; },
  );
});

// ---------------------------------------------------------------- strategy
test("PARTIAL strategy replacement is detected as drift, not accepted as close enough", () => {
  const full = {
    type: "git_worktree", baseRef: "feat/new-bookmarks-snapshot",
    branchTemplate: "paperclip/{{issue.identifier}}",
    worktreeParentDir: "/home/lucascoh/.paperclip/worktrees/X-Bookmarks",
  };
  // What ZEI-1 actually held: type + baseRef only. Because the server resolves
  // issue ?? project (execution-workspace-policy.js:275) rather than merging,
  // this silently loses branchTemplate and worktreeParentDir.
  const partial = { type: "git_worktree", baseRef: "feat/new-bookmarks-snapshot" };
  assert.equal(compareWorkspaceStrategy(full, partial).equal, false);
  assert.equal(compareWorkspaceStrategy(full, full).equal, true);
  assert.equal(compareWorkspaceStrategy(full, null).equal, false);
});

test("config load REFUSES a partial git_worktree strategy", () => {
  const base = {
    version: 1, api: {}, pins: {}, instance: {}, company: {}, projects: [], agents: [], operator: {},
    issues: [{
      identifier: "ZEI-1",
      executionWorkspaceSettings: {
        workspaceStrategy: { type: "git_worktree", baseRef: "x", branchTemplate: "t" },
      },
    }],
  };
  assert.throws(() => validate(base), /workspaceStrategy is partial \(missing worktreeParentDir\)/);
  base.issues[0].executionWorkspaceSettings.workspaceStrategy.worktreeParentDir = "/d";
  assert.doesNotThrow(() => validate(base));
});

test("config load REFUSES a hardcoded database UUID", () => {
  const base = {
    version: 1, api: {}, pins: {}, instance: {}, company: {}, projects: [], agents: [], issues: [],
    operator: { userId: "cc4fc719-ef7c-4e7a-bc3f-2124e021ef8d" },
  };
  assert.throws(() => validate(base), /hardcoded database UUID/);
});

// ---------------------------------------------------------------- policy
test("execution policy comparison tolerates server-minted ids but not real drift", () => {
  const desired = {
    mode: "normal",
    stages: [
      { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: "AGENT" }] },
      { type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId: "USER" }] },
    ],
  };
  const live = JSON.parse(JSON.stringify(desired));
  live.stages[0].id = "srv-1";
  live.stages[0].participants[0].id = "srv-2";
  live.stages[0].participants[0].userId = null;      // server materializes the unused side
  live.stages[1].id = "srv-3";
  live.stages[1].participants[0].id = "srv-4";
  live.stages[1].participants[0].agentId = null;
  assert.equal(compareExecutionPolicy(desired, live).equal, true, "server identity must not read as drift");

  const wrongAgent = JSON.parse(JSON.stringify(live));
  wrongAgent.stages[0].participants[0].agentId = "SOMEONE-ELSE";
  assert.equal(compareExecutionPolicy(desired, wrongAgent).equal, false);

  const missingApproval = JSON.parse(JSON.stringify(live));
  missingApproval.stages.pop();
  assert.equal(compareExecutionPolicy(desired, missingApproval).equal, false,
    "a dropped human approval stage must never compare equal");

  assert.equal(compareExecutionPolicy(desired, null).equal, false);
});

// ---------------------------------------------------------------- plan hash
test("the plan hash covers observed state, so a stale plan cannot be applied", () => {
  const mk = (before) => hashValue({
    version: 1,
    actions: [{ id: "issue:ZEI-1", kind: "update", method: "PATCH", writePath: "/api/issues/i1",
                allow: ["reviewPolicy"], body: { reviewPolicy: "not_creator" }, before, after: {} }],
  });
  assert.equal(mk({ reviewPolicy: null }), mk({ reviewPolicy: null }), "same state -> same hash");
  assert.notEqual(mk({ reviewPolicy: null }), mk({ reviewPolicy: "anyone" }),
    "live state moved -> hash must change so --plan-hash refuses");
});

test("config expansion resolves ${FACTORY_ROOT} and strips $comment before hashing", () => {
  const out = expandVars(stripComments({ a: "${FACTORY_ROOT}/x", $comment: "note", b: { $comment: "n", c: 1 } }),
    { FACTORY_ROOT: "/root" });
  assert.deepEqual(out, { a: "/root/x", b: { c: 1 } });
  assert.throws(() => expandVars({ a: "${NOPE}" }, {}), /unknown variable/);
});

test("objective document reconciliation plans an optimistic PUT with exact body readback", () => {
  const objectiveDocument = {
    key: "spec", title: "ZEI-1 immutable objective", format: "markdown",
    body: "# objective\n\nrevision 1\n", bodyHash: "sha256:" + "a".repeat(64),
    changeSummary: "Install objective revision 1",
    objective: {
      revision: 1, objectiveHash: "sha256:" + "b".repeat(64),
      criteriaHash: "sha256:" + "c".repeat(64),
    },
  };
  const cfg = { issues: [{ identifier: "ZEI-1", objectiveDocument }] };
  const snap = {
    issues: { "ZEI-1": { id: "issue-1" } },
    issueDocuments: { "ZEI-1": { spec: {
      title: "old", format: "markdown", body: "old", latestRevisionId: "revision-1",
    } } },
  };
  const actions = [];
  planContractDocuments(cfg, snap, actions);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].method, "PUT");
  assert.equal(actions[0].writePath, "/api/issues/issue-1/documents/spec");
  assert.equal(actions[0].body.baseRevisionId, "revision-1");
  // `body`, not `latestBody`: services/documents.js:48 maps `body: row.latestBody`
  // on the way out, so `body` is the only content field a readback ever sees.
  assert.deepEqual(actions[0].expect.map((x) => x.path), ["title", "format", "body", "latestRevisionId"]);
});

test("instruction reconciliation compares exact compiled bytes and plans no action on a hash match", () => {
  const compiled = "platform + doctrine + role\n";
  const cfg = { agents: [{ name: "OMP Engineer", instructions: { path: "AGENTS.md", content: compiled, sha256: "sha256:" + "b".repeat(64) } }] };
  const snap = { agents: { "OMP Engineer": { id: "agent-1" } }, agentInstructions: { "OMP Engineer": { path: "AGENTS.md", content: compiled } } };
  const actions = [];
  planAgentInstructions(cfg, snap, actions);
  assert.deepEqual(actions, []);
  snap.agentInstructions["OMP Engineer"].content = "stale";
  planAgentInstructions(cfg, snap, actions);
  assert.equal(actions[0].method, "PUT");
  assert.deepEqual(actions[0].expect.map((x) => x.path), ["path", "content"]);
});

test("document and instruction upserts fail on the broader 200-and-do-nothing API class", async () => {
  const state = { title: "old", format: "markdown", body: "old", latestRevisionId: "r1" };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    calls.push(method);
    return { ok: true, status: 200, text: async () => JSON.stringify(state) };
  };
  await assert.rejects(() => new PaperclipApi("http://x", { fetch: fetchImpl }).mutate({
    readPath: "/api/issues/i/documents/spec", writePath: "/api/issues/i/documents/spec", method: "PUT",
    body: { title: "new", format: "markdown", body: "new", changeSummary: "change", baseRevisionId: "r1" },
    allow: ["title", "format", "body", "changeSummary", "baseRevisionId"],
    expect: [{ path: "body", value: "new" }],
  }), /200-and-do-nothing/);
  assert.deepEqual(calls, ["GET", "PUT", "GET"]);
});
