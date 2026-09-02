"use strict";
// The full path of `factory handoff`: how a validated EngineerHandoffDraftV1
// becomes a runnable child, and — more importantly — everything the helper
// refuses to do.
//
// The invariants under test:
//   1. an invalid draft is refused with ZERO requests on the wire;
//   2. every derived identifier (child identifier, branch, criterion ids,
//      objective id) is mechanical, and authoring one is a defect;
//   3. the child blocks the parent and stays unassigned and non-runnable
//      until the single final activation mutation;
//   4. any failure leaves a diagnosed, non-deleted, non-runnable child;
//   5. re-running the same key with the same draft is a no-op, and after a
//      transient failure it completes.

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const handoff = require("../../lib/handoff");
const { validateContract } = require("../../lib/contracts");
const receipts = require("../../lib/receipts");
const { PaperclipApi } = require("../../lib/api");
const { FactoryError } = require("../../lib/util");

// ---- the repository the draft points at -----------------------------------
function fixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-repo-"));
  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "bin"));
  fs.writeFileSync(path.join(repo, "bin/view.py"), "base\n");
  g("add", "-A"); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();
  return { repo, base, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
const FIXTURE = fixtureRepo();
after(() => FIXTURE.cleanup());

function makeDraft(overrides = {}) {
  return {
    schemaVersion: "EngineerHandoffDraftV1",
    parentIssueIdentifier: "ZEI-1",
    idempotencyKey: "fix-bookmarks",
    title: "Fix the bookmarks snapshot",
    originalRequest: "The bookmarks snapshot crashes on empty input.",
    repository: { path: FIXTURE.repo, baseCommit: FIXTURE.base },
    permissions: {
      filesystem: { read: ["bin"], write: ["bin/view.py"] },
      network: "none",
      externalEffects: [],
    },
    limits: { wallClockMinutes: 45, costCeilingUsd: 4, outerFactoryCostCeilingUsd: 5, maxReviewRounds: 2 },
    verificationLevel: "important",
    expectedOutputs: ["bin/view.py handles empty input"],
    constraints: ["no new dependencies"],
    acceptanceCommands: [
      { requirement: "snapshot handles empty input", command: { argv: ["node", "--test", "test/unit/view.test.js"], cwd: "." } },
      { requirement: "snapshot stays deterministic", command: { argv: ["node", "--test", "test/unit/determinism.test.js"], cwd: "." } },
    ],
    ...overrides,
  };
}

const MEMBER = {
  id: "membership-1", principalType: "user", principalId: "user-1",
  email: "local@paperclip.local",
  user: { id: "user-1", email: "local@paperclip.local" },
};
const AGENTS = [
  { id: "agent-engineer", name: "OMP Engineer" },
  { id: "agent-reviewer", name: "OMP Reviewer" },
];
const PARENT = {
  id: "parent-1", identifier: "ZEI-1", companyId: "c1", parentId: null,
  status: "in_progress", assigneeAgentId: null,
  executionWorkspacePreference: "isolated_workspace",
  executionWorkspaceSettings: {
    mode: "isolated_workspace",
    workspaceStrategy: {
      type: "git_worktree", baseRef: "main",
      branchTemplate: "paperclip/{{issue.identifier}}",
      worktreeParentDir: "/tmp/paperclip-worktrees",
    },
  },
};

const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
const notFound = () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: "not found" }) });

// A Paperclip that behaves like the shipped one: `blockedBy` relation
// summaries on the parent row, `blockParentUntilDone` honored by the child
// creation endpoint, optimistic document revisions, and comments as their own
// endpoint (no implicit status change).
function server(options = {}) {
  const state = {
    options, children: [], documents: {}, comments: [], calls: [],
    specPutCount: 0, specGetAfterPut: 0, rev: 0, commentN: 0,
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const fullPath = url.replace(/^https?:\/\/[^/]+/, "");
    const [p, query] = fullPath.split("?");
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ method, path: p, body });

    if (p === "/api/health") return ok({ status: "ok" });
    if (p === "/api/companies" && method === "GET") return ok([{ id: "c1", name: "ZEIROS" }]);
    if (p === "/api/companies/c1/members") return ok({ members: [MEMBER] });
    if (p === "/api/companies/c1/agents") return ok({ agents: AGENTS });
    if (p === "/api/companies/c1/issues" && method === "GET") {
      if (query === "parentId=parent-1") return ok(state.children);
      return ok({ issues: [PARENT, ...state.children] });
    }

    const doc = /^\/api\/issues\/([^/]+)\/documents\/spec$/.exec(p);
    if (doc) {
      const issueId = doc[1];
      const docs = state.documents[issueId];
      if (method === "GET") {
        if (state.options.specPutStale && state.specPutCount > 0) {
          return ok({ key: "spec", title: "stale", format: "markdown", body: "", latestRevisionId: "rev-stale" });
        }
        const d = docs?.spec;
        if (!d) return notFound();
        if (state.options.tamperOnSecondGet && state.specGetAfterPut >= 1) {
          state.specGetAfterPut += 1;
          return ok({ ...d, body: d.body.replace('"node"', '"nodej"') });
        }
        if (state.specPutCount > 0) state.specGetAfterPut += 1;
        return ok(d);
      }
      if (method === "PUT") {
        state.specPutCount += 1;
        if (state.options.specPutStale) {
          return ok({ key: "spec", title: "stale", format: "markdown", body: "", latestRevisionId: "rev-stale" });
        }
        const existing = docs?.spec;
        if (existing && body.baseRevisionId !== existing.latestRevisionId) {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: "stale revision" }) };
        }
        const d = {
          key: "spec", title: body.title, format: body.format, body: body.body,
          latestRevisionId: `rev-${++state.rev}`,
        };
        state.documents[issueId] = { ...(docs ?? {}), spec: d };
        return ok(d);
      }
    }

    const com = /^\/api\/issues\/([^/]+)\/comments$/.exec(p);
    if (com) {
      const issueId = com[1];
      if (method === "GET") return ok(state.comments[issueId] ?? []);
      if (method === "POST") {
        state.comments[issueId] = [...(state.comments[issueId] ?? []),
          { id: `comment-${++state.commentN}`, body: body.body }];
        return ok(state.comments[issueId].at(-1));
      }
    }

    if (p === "/api/issues/parent-1/children" && method === "POST") {
      const n = state.children.length + 2;
      const child = {
        id: `child-${n}`, identifier: `ZEI-${n}`, companyId: "c1", parentId: "parent-1",
        title: body.title, description: body.description,
        status: body.status ?? "backlog",
        assigneeAgentId: null,
        responsibleUserId: state.options.dropResponsible ? null : body.responsibleUserId,
        executionWorkspacePreference: state.options.dropWorkspacePref
          ? null : body.executionWorkspacePreference,
        executionWorkspaceSettings: state.options.dropStrategy
          ? { mode: body.executionWorkspaceSettings?.mode } : clone(body.executionWorkspaceSettings),
        executionPolicy: state.options.dropExecutionPolicy ? null : clone(body.executionPolicy),
      };
      state.children.push(child);
      if (state.options.seedSpec) {
        state.documents[child.id] = {
          spec: { key: "spec", title: "seeded", format: "markdown",
                  body: "A DIFFERENT OBJECTIVE", latestRevisionId: "rev-seed" },
        };
      }
      return ok({ issue: child, parentBlockerAdded: body.blockParentUntilDone === true });
    }

    const iss = /^\/api\/issues\/([^/?]+)$/.exec(p);
    if (iss) {
      if (iss[1] === "parent-1" && method === "GET") {
        return ok({ ...PARENT, blockedBy:
          state.children.filter((c) => c.status !== "done")
            .map((c) => ({ id: c.id, identifier: c.identifier, title: c.title })) });
      }
      const row = state.children.find((c) => c.id === iss[1]);
      if (!row) return notFound();
      if (method === "GET") return ok(row);
      if (method === "PATCH") {
        if (body.assigneeAgentId !== undefined) row.assigneeAgentId = body.assigneeAgentId;
        if (body.status !== undefined) row.status = body.status;
        return ok(row);
      }
    }
    return notFound();
  };
  return { state, fetchImpl };
}

function harness(overrides = {}) {
  const s = overrides.server ?? server();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-root-"));
  const drafts = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-drafts-"));
  const api = new PaperclipApi("http://paperclip.test", { fetch: s.fetchImpl });
  const cfg = {
    _root: root, company: { name: "ZEIROS" },
    operator: { key: "operator", memberEmail: "local@paperclip.local" },
    agents: [
      { name: "Hermes Generalist", instructions: { bundle: "hermes", path: "AGENTS.md" } },
      { name: "OMP Engineer", instructions: { bundle: "engineer", path: "AGENTS.md" } },
      { name: "OMP Reviewer", instructions: { bundle: "reviewer", path: "AGENTS.md" } },
    ],
  };
  const run = (d = makeDraft()) => {
    const file = path.join(drafts, "draft.json");
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    return handoff.run(cfg, { _: ["handoff"], flags: { draft: file } }, {
      connect: () => api, requireHealthy: (x) => x.health(),
      C: { green: (x) => x, dim: (x) => x },
    });
  };
  return { s, cfg, run, root };
}

const writesOf = (s) => s.state.calls.filter((c) => c.method !== "GET");

// ---------------------------------------------------------------- cases ---

test("an invalid draft is refused with zero requests", async () => {
  const bad = [
    { name: "wrong schema version", draft: makeDraft({ schemaVersion: "EngineerHandoffDraftV2" }), re: /validation failed/ },
    { name: "empty write set", draft: makeDraft({
      permissions: { filesystem: { read: ["bin"], write: [] }, network: "none", externalEffects: [] } }),
      re: /no write authority/ },
    { name: "absolute write path", draft: makeDraft({
      permissions: { filesystem: { read: ["bin"], write: ["/etc/passwd"] }, network: "none", externalEffects: [] } }),
      re: /outside the objective's granted write set/ },
    { name: "escaping write path", draft: makeDraft({
      permissions: { filesystem: { read: ["bin"], write: ["bin/../../etc"] }, network: "none", externalEffects: [] } }),
      re: /outside the objective's granted write set/ },
    { name: "child cost above the outer bound", draft: makeDraft({
      limits: { wallClockMinutes: 45, costCeilingUsd: 6, outerFactoryCostCeilingUsd: 5, maxReviewRounds: 2 } }),
      re: /outerFactoryCostCeilingUsd/ },
    { name: "shell string acceptance command", draft: makeDraft({
      acceptanceCommands: [{ requirement: "r", command: { argv: ["sh -c 'make test'"], cwd: "." } }] }),
      re: /bare program name/ },
    { name: "missing repository", draft: makeDraft({
      repository: { path: "/no/such/directory", baseCommit: "3cb8238" } }),
      re: /does not exist/ },
    { name: "unresolvable base commit", draft: makeDraft({
      repository: { path: FIXTURE.repo, baseCommit: "decafbad" } }),
      re: /does not resolve/ },
    { name: "no constraints", draft: makeDraft({ constraints: [] }), re: /no constraints/ },
  ];
  for (const { name, draft, re } of bad) {
    const { s, run } = harness();
    await assert.rejects(() => run(draft), re, name);
    assert.equal(s.state.calls.length, 0, `${name}: a refused draft must make zero requests`);
  }
});

test("derived identifiers are mechanical, and authoring one is refused", () => {
  const draft = makeDraft();
  const child = { identifier: "ZEI-2" };
  const ids = handoff.deriveChildIdentifiers({ draft, child });
  assert.deepEqual(ids, {
    branch: "paperclip/ZEI-2",
    criterionIds: ["ZEI-2-AC-01", "ZEI-2-AC-02"],
    objectiveId: "ZEI-2",
  });
  const objective = handoff.buildObjectiveEnvelope({ draft, child, ids });
  assert.equal(objective.revision, 1);
  assert.equal(objective.issueIdentifier, "ZEI-2");
  assert.deepEqual(objective.acceptanceCriteria.map((c) => c.id), ids.criterionIds);

  assert.throws(
    () => handoff.buildObjectiveEnvelope({ draft, child, ids: { ...ids, criterionIds: ["ZEI-9-AC-01", "ZEI-2-AC-02"] } }),
    /derived/);
  assert.throws(
    () => handoff.buildObjectiveEnvelope({ draft, child, ids: { ...ids, branch: "feature/ZEI-2" } }),
    /derived/);
  assert.throws(
    () => handoff.buildObjectiveEnvelope({ draft, child, ids: { ...ids, objectiveId: "ZEI-9" } }),
    /derived/);
});

test("a valid handoff creates one blocking child, installs the spec, and writes a valid receipt", async () => {
  const { s, run, root } = harness();
  const code = await run();
  assert.equal(code, 0);

  assert.equal(s.state.children.length, 1);
  const child = s.state.children[0];
  assert.equal(child.identifier, "ZEI-2");
  assert.equal(child.parentId, "parent-1");
  assert.equal(child.status, "todo");
  assert.equal(child.assigneeAgentId, "agent-engineer");
  assert.equal(child.responsibleUserId, "user-1");
  assert.equal(child.executionWorkspacePreference, "isolated_workspace");
  assert.equal(child.executionWorkspaceSettings.workspaceStrategy.baseRef, FIXTURE.base);
  assert.equal(child.executionWorkspaceSettings.workspaceStrategy.worktreeParentDir,
    "/tmp/paperclip-worktrees");
  assert.equal(child.executionPolicy.commentRequired, true);
  assert.equal(child.executionPolicy.maxReviewRounds, 2);
  assert.equal(child.executionPolicy.stages.map((x) => x.type).join(","), "review,approval");
  assert.deepEqual(child.executionPolicy.stages[0].participants, [{ type: "agent", agentId: "agent-reviewer" }]);
  assert.deepEqual(child.executionPolicy.stages[1].participants, [{ type: "user", userId: "user-1" }]);

  // The blocking relation, proven from the server's own parent row.
  const parentRow = JSON.parse(await (await s.fetchImpl("http://x/api/issues/parent-1")).text());
  assert.ok(parentRow.blockedBy.some((b) => b.id === child.id));

  // The spec document stores the envelope verbatim, hash-bound.
  const spec = s.state.documents[child.id].spec;
  const stored = handoff.envelopeFromRenderedBody(spec.body);
  const objective = handoff.buildObjectiveEnvelope({
    draft: makeDraft(), child,
    ids: handoff.deriveChildIdentifiers({ draft: makeDraft(), child }),
  });
  assert.equal(stored.objectiveHash, objective.objectiveHash);
  assert.equal(stored.criteriaHash, objective.criteriaHash);
  assert.deepEqual(stored.acceptanceCriteria.map((c) => c.id), ["ZEI-2-AC-01", "ZEI-2-AC-02"]);
  assert.deepEqual(stored.limits, makeDraft().limits);

  // One receipt, valid, bound to the same hashes.
  const files = fs.readdirSync(path.join(root, "receipts"));
  assert.equal(files.length, 1);
  const receipt = receipts.read(root, files[0].replace(/\.json$/, ""));
  assert.equal(receipt.kind, "handoff");
  validateContract("EngineerHandoffReceiptV1", receipt.handoff);
  assert.equal(receipt.handoff.objectiveHash, objective.objectiveHash);
  assert.equal(receipt.handoff.criteriaHash, objective.criteriaHash);
  assert.equal(receipt.handoff.specRevisionId, spec.latestRevisionId);
  assert.deepEqual(receipt.handoff.activation, {
    assignedAgent: "OMP Engineer", status: "runnable", blocksParent: true,
  });
});

test("activation is the final mutation; no earlier body carries assignee or runnable status", async () => {
  const { s, run } = harness();
  await run();
  const writes = writesOf(s);
  assert.ok(writes.length >= 3, "create, spec install, and activation at minimum");

  const last = writes.at(-1);
  assert.equal(last.method, "PATCH");
  assert.equal(last.body.assigneeAgentId, "agent-engineer");
  assert.equal(last.body.status, "todo");

  for (const w of writes.slice(0, -1)) {
    assert.equal("assigneeAgentId" in (w.body ?? {}), false,
      `write ${w.method} ${w.path} must not carry an assignee`);
    assert.notEqual(w.body?.status, "todo",
      `write ${w.method} ${w.path} must not set a runnable status`);
  }
  // The child is created explicitly non-runnable.
  const create = writes.find((w) => w.method === "POST");
  assert.equal(create.body.status, "backlog");
});

test("an objective that reads back different from what was sent never reaches activation", async () => {
  const { s, run } = harness({ server: server({ tamperOnSecondGet: true }) });
  await assert.rejects(() => run(), (err) => {
    assert.ok(err instanceof FactoryError);
    assert.match(err.message, /read back byte-different|hashes or limits/);
    return true;
  });
  const child = s.state.children[0];
  assert.equal(child.assigneeAgentId, null, "a tampered objective must not be activated");
  assert.equal(child.status, "backlog");
  assert.ok(!writesOf(s).some((w) => w.method === "PATCH"), "no activation happened");
  const comments = s.state.comments[child.id] ?? [];
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /objective document/);
  assert.match(comments[0].body, /fix-bookmarks/);
});

test("re-running the same draft with the same key is a verified no-op", async () => {
  const { s, run, root } = harness();
  await run();
  const callsAfterFirst = s.state.calls.length;
  const code = await run();
  assert.equal(code, 0);
  assert.equal(s.state.children.length, 1, "no second child for the same key");
  const secondRun = s.state.calls.slice(callsAfterFirst);
  assert.ok(secondRun.length > 0, "the replay still verifies by reading");
  assert.ok(secondRun.every((c) => c.method === "GET"), "the replay must write nothing");
  assert.equal(fs.readdirSync(path.join(root, "receipts")).length, 1,
    "the replay returns the existing receipt, not a second record");
});

test("the same idempotency key with a different draft is refused before any write", async () => {
  const { s, run } = harness();
  await run();
  const callsAfterFirst = s.state.calls.length;
  await assert.rejects(
    () => run(makeDraft({ title: "A different objective entirely" })),
    /already bound to a different draft/);
  assert.ok(s.state.calls.slice(callsAfterFirst).every((c) => c.method === "GET"));
  assert.equal(s.state.children.length, 1);
});

test("an existing different spec document is a conflict, never an overwrite", async () => {
  const { s, run } = harness({ server: server({ seedSpec: true }) });
  await assert.rejects(() => run(), /already carries a spec document/);
  const child = s.state.children[0];
  assert.equal(child.assigneeAgentId, null);
  assert.equal(child.status, "backlog");
  assert.equal(s.state.documents[child.id].spec.body, "A DIFFERENT OBJECTIVE",
    "the installed objective was not silently overwritten");
  const comments = s.state.comments[child.id] ?? [];
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /objective document/);
});

test("a spec PUT the server accepts but does not persist fails the handoff", async () => {
  const { s, run } = harness({ server: server({ specPutStale: true }) });
  await assert.rejects(() => run(), /did not persist/);
  const child = s.state.children[0];
  assert.equal(child.assigneeAgentId, null);
  assert.equal(child.status, "backlog");
  const comments = s.state.comments[child.id] ?? [];
  assert.equal(comments.length, 1, "the 200-and-do-nothing failure leaves a diagnostic");
});

test("a readiness failure leaves the child diagnosed, unassigned, and intact", async () => {
  const { s, run } = harness({ server: server({ dropExecutionPolicy: true }) });
  await assert.rejects(() => run(), /execution policy/);
  const child = s.state.children[0];
  assert.equal(child.assigneeAgentId, null);
  assert.equal(child.status, "backlog");
  // Steps before the failure landed; nothing was rolled back or deleted.
  assert.ok(s.state.documents[child.id]?.spec, "the spec stays installed");
  assert.ok(s.state.calls.every((c) => c.method !== "DELETE"), "the child is never deleted");
  const [comment] = s.state.comments[child.id];
  assert.match(comment.body, /child readiness/);
  assert.match(comment.body, /Expected: /);
  assert.match(comment.body, /Observed: /);
  assert.match(comment.body, /fix-bookmarks/);
});

test("partial strategy, missing responsible user, and wrong workspace preference each refuse", async () => {
  const expected = {
    dropStrategy: /partial workspaceStrategy/,
    dropResponsible: /responsibleUserId/,
    dropWorkspacePref: /isolated_workspace/,
  };
  for (const [option, re] of Object.entries(expected)) {
    const { s, run } = harness({ server: server({ [option]: true }) });
    await assert.rejects(() => run(), (err) => {
      assert.ok(err instanceof FactoryError, option);
      assert.match(err.message, re, option);
      return true;
    });
    const child = s.state.children[0];
    assert.equal(child.assigneeAgentId, null, option);
    assert.equal(child.status, "backlog", option);
  }
});

test("re-running after a transient failure with the same key completes the handoff", async () => {
  const { s, run, root } = harness();
  s.state.options.specPutStale = true;
  await assert.rejects(() => run(), /did not persist/);
  s.state.options.specPutStale = false;

  const code = await run();
  assert.equal(code, 0);
  assert.equal(s.state.children.length, 1, "the re-run resumed the existing child");
  const child = s.state.children[0];
  assert.equal(child.assigneeAgentId, "agent-engineer");
  assert.equal(child.status, "todo");
  assert.ok(s.state.documents[child.id]?.spec, "the spec document is installed");

  const files = fs.readdirSync(path.join(root, "receipts"));
  assert.equal(files.length, 1, "one receipt for the completed handoff");
  const receipt = receipts.read(root, files[0].replace(/\.json$/, ""));
  validateContract("EngineerHandoffReceiptV1", receipt.handoff);
  assert.equal(receipt.handoff.childIssueIdentifier, child.identifier);
  assert.equal(receipt.handoff.activation.status, "runnable");
});
