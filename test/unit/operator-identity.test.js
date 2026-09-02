"use strict";
// The operator is a USER id, never a membership id.
//
// A Paperclip membership row carries both, under different keys, and it has no
// `userId` key at all:
//
//   { id: "<membership uuid>", principalType: "user", principalId: "local-board",
//     user: { id: "local-board", email: "local@paperclip.local" } }
//
// `hit.userId ?? hit.id` therefore resolved to the MEMBERSHIP uuid. That value
// went live as the approval stage's participants[].userId. The server validates
// a participant's shape but not that its userId resolves to anyone, so it stored
// it and answered 200 — and the approval stage became unsatisfiable. Five runs
// on ZEI-1 reported `succeeded` and the issue still ended `blocked`.
//
// These tests pin the resolution AND pin that it fails loudly rather than
// guessing when no user id is present.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Resolver } = require("../../lib/resolve");
const { FactoryError } = require("../../lib/util");
const { resolveExecutionPolicy, planIssues } = require("../../lib/plan");

const MEMBERSHIP_ID = "43dc167f-8cb9-4d8e-b6dc-207a742bf87e";
const USER_ID = "local-board";
const EMAIL = "local@paperclip.local";

// A membership row shaped exactly as the live instance returns it.
function membersApi(row) {
  return {
    get: async (path) => {
      if (path.endsWith("/members")) return { members: [row] };
      throw new Error(`unexpected GET ${path}`);
    },
  };
}
const LIVE_ROW = {
  id: MEMBERSHIP_ID,
  companyId: "c8a26e3d-a16a-4973-abbe-cc87f8ed2836",
  principalType: "user",
  principalId: USER_ID,
  membershipRole: "owner",
  user: { id: USER_ID, email: EMAIL, name: "Board" },
};

test("member() resolves the USER id, not the membership id", async () => {
  const r = new Resolver(membersApi(LIVE_ROW));
  const m = await r.member("c1", EMAIL);
  assert.equal(m.userId, USER_ID);
  assert.notEqual(m.userId, MEMBERSHIP_ID, "the membership uuid is not a principal");
  assert.equal(m.membershipId, MEMBERSHIP_ID, "the membership id is still reported, separately");
});

test("member() falls back to principalId when the user object is absent", async () => {
  const { user, ...noUser } = LIVE_ROW;
  const r = new Resolver(membersApi({ ...noUser, email: EMAIL }));
  assert.equal((await r.member("c1", EMAIL)).userId, USER_ID);
});

test("member() REFUSES to guess when no user id is resolvable", async () => {
  const r = new Resolver(membersApi({ id: MEMBERSHIP_ID, email: EMAIL }));
  await assert.rejects(() => r.member("c1", EMAIL), (err) => {
    assert.ok(err instanceof FactoryError);
    assert.match(err.message, /no resolvable user id/);
    assert.match(err.message, /Refusing to fall back to the membership id/);
    return true;
  });
});

test("member() rejects a non-user principal", async () => {
  const r = new Resolver(membersApi({ ...LIVE_ROW, principalType: "agent" }));
  await assert.rejects(() => r.member("c1", EMAIL), /is a agent principal, not a user/);
});

test("the approval stage participant carries the user id the operator can act as", () => {
  const policy = resolveExecutionPolicy(
    {
      mode: "normal",
      stages: [
        { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agent: "OMP Reviewer" }] },
        { type: "approval", approvalsNeeded: 1, participants: [{ type: "user", user: "operator" }] },
      ],
    },
    { agents: { "OMP Reviewer": { id: "f5231bf2-486e-4ed8-b8d2-1cb8a27db7e6" } },
      operator: { userId: USER_ID, membershipId: MEMBERSHIP_ID } },
  );
  const approval = policy.stages.find((s) => s.type === "approval");
  assert.equal(approval.participants[0].userId, USER_ID);
  assert.notEqual(approval.participants[0].userId, MEMBERSHIP_ID,
    "an approval stage naming a membership uuid can never be satisfied");
});

// -------------------------------------------------- responsibleUserId is create-only

test("a responsibleUserId difference is a PLAN-TIME ERROR, not a doomed PATCH", () => {
  // updateIssueSchema omits responsibleUserId, so a PATCH is stripped and 200'd.
  const cfg = {
    issues: [{
      identifier: "ZEI-1", project: "P", goal: "g", reviewPolicy: "not_creator",
      assignee: "A", responsibleUser: "operator",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
    }],
  };
  const snap = {
    operator: { userId: USER_ID, membershipId: MEMBERSHIP_ID },
    goals: { g: { id: "g1" } },
    agents: { A: { id: "a1" } },
    projects: { P: { live: { id: "p1" } } },
    issues: { "ZEI-1": { id: "i1", responsibleUserId: "somebody-else" } },
    issueDocuments: { "ZEI-1": {} },
  };
  assert.throws(() => planIssues(cfg, snap, []), (err) => {
    assert.ok(err instanceof FactoryError);
    assert.match(err.message, /settable only at issue creation/);
    assert.match(err.message, /silently dropped/);
    return true;
  });
});

test("a matching responsibleUserId plans no write for it at all", () => {
  const cfg = {
    issues: [{
      identifier: "ZEI-1", project: "P", goal: "g", reviewPolicy: "not_creator",
      assignee: "A", responsibleUser: "operator",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
    }],
  };
  const snap = {
    operator: { userId: USER_ID, membershipId: MEMBERSHIP_ID },
    goals: { g: { id: "g1" } },
    agents: { A: { id: "a1" } },
    projects: { P: { live: { id: "p1" } } },
    issues: {
      "ZEI-1": {
        id: "i1", responsibleUserId: USER_ID, projectId: "p1", goalId: "g1",
        reviewPolicy: "not_creator", assigneeAgentId: "a1",
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
      },
    },
    issueDocuments: { "ZEI-1": {} },
  };
  const actions = [];
  planIssues(cfg, snap, actions);
  for (const a of actions) {
    assert.ok(!("responsibleUserId" in (a.body ?? {})),
      "responsibleUserId must never appear in a PATCH body");
  }
});

// -------------------------------------------------- live stages own assignment

// While an execution stage is open the server owns assigneeAgentId (it points at
// the current stage participant) and executionWorkspacePreference (it becomes
// "reuse_existing" so the reviewer reads the Engineer's worktree). Reconciling
// those back to the declared values mid-review reassigns the issue away from the
// reviewer and detaches it from the worktree.
function issueCfg() {
  return {
    issues: [{
      identifier: "ZEI-1", project: "P", goal: "g", reviewPolicy: "not_creator",
      assignee: "ENG", responsibleUser: "operator",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
    }],
  };
}
function issueSnap(live) {
  return {
    operator: { userId: USER_ID, membershipId: MEMBERSHIP_ID },
    goals: { g: { id: "g1" } },
    agents: { ENG: { id: "eng" }, REV: { id: "rev" } },
    projects: { P: { live: { id: "p1" } } },
    issueDocuments: { "ZEI-1": {} },
    issues: {
      "ZEI-1": {
        id: "i1", projectId: "p1", goalId: "g1", reviewPolicy: "not_creator",
        responsibleUserId: USER_ID,
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
        ...live,
      },
    },
  };
}

test("a live review stage keeps its assignment: no reassignment is planned", () => {
  const actions = [];
  planIssues(issueCfg(), issueSnap({
    assigneeAgentId: "rev",
    executionWorkspacePreference: "reuse_existing",
    executionState: { currentStageType: "review", currentStageId: "s1" },
  }), actions);
  for (const a of actions) {
    assert.ok(!("assigneeAgentId" in (a.body ?? {})), "must not reassign away from the live stage participant");
    assert.ok(!("executionWorkspacePreference" in (a.body ?? {})), "must not detach the reviewer from the worktree");
  }
});

test("with NO live stage, assignment and workspace preference are reconciled normally", () => {
  const actions = [];
  planIssues(issueCfg(), issueSnap({
    assigneeAgentId: "someone-else",
    executionWorkspacePreference: "reuse_existing",
    executionState: null,
  }), actions);
  const body = actions[0]?.body ?? {};
  assert.equal(body.assigneeAgentId, "eng", "outside a stage the declared assignee is authoritative");
  assert.equal(body.executionWorkspacePreference, "isolated_workspace");
});
