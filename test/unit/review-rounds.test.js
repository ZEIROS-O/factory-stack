"use strict";
// Round exhaustion is enforced by the SERVER, not by us — and the two knobs it
// reads are both easy to get wrong in a way that fails silently.
//
//   services/issue-execution-policy.js:336
//     resolveMaxReviewRounds(policy) reads policy.maxReviewRounds, defaulting to
//     DEFAULT_MAX_REVIEW_ROUNDS = 3 (line 9). It reads the EXECUTION POLICY, not
//     any issue-level limits object. A ceiling declared somewhere the server
//     never looks is not a ceiling.
//
//   services/issue-execution-policy.js:679-702
//     On exhaustion the stage is handed to reviewEscalationUserId(issue) =
//     responsibleUserId ?? createdByUserId ?? null. When that is NULL the
//     escalation branch is skipped entirely and execution falls through to
//     `patch.status = "in_progress"` reassigned to the return assignee — the
//     Engineer. That is precisely the loop the plan forbids, reached by
//     omission rather than by error.
//
// Both defects are invisible at apply time: the server accepts the issue, says
// 200, and behaves differently from what the config appears to declare.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { load } = require("../../lib/config");
const { planIssues } = require("../../lib/plan");

const CONFIG = path.resolve(__dirname, "../../factory.config.json");

test("the review-round ceiling is declared where the server actually reads it", () => {
  const cfg = load(CONFIG);
  const zei = cfg.issues.find((i) => i.identifier === "ZEI-1");

  assert.equal(zei.executionPolicy.maxReviewRounds, 2,
    "resolveMaxReviewRounds reads policy.maxReviewRounds; declaring it only under " +
    "issues[].limits leaves the server on its default of 3");

  // The promote-time gate keeps its own copy on purpose — one is a server
  // behaviour, the other is a refusal this factory performs itself — but they
  // must not disagree, or the system enforces two different numbers.
  assert.equal(zei.limits.maxReviewRounds, zei.executionPolicy.maxReviewRounds,
    "the server-enforced ceiling and the promote-time gate must be the same number");
});

test("the issue names a responsible human, without whom exhaustion silently loops back to the engineer", () => {
  const cfg = load(CONFIG);
  const zei = cfg.issues.find((i) => i.identifier === "ZEI-1");
  assert.equal(zei.responsibleUser, "operator",
    "reviewEscalationUserId returns null with no responsible user, and the escalation branch is skipped");
  assert.ok(cfg.operator?.key === "operator", "the responsible user must resolve to the declared operator");
});

test("reconciliation manages responsibleUserId, so the escalation target cannot drift away unnoticed", () => {
  const cfg = load(CONFIG);
  const snap = {
    issues: {
      "ZEI-1": {
        id: "issue-1", projectId: "p1", goalId: "g1",
        reviewPolicy: "not_creator", assigneeAgentId: "a1",
        responsibleUserId: null,                     // the silent-loop state
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: cfg.issues[0].executionWorkspaceSettings,
        executionPolicy: null,
        assigneeAdapterOverrides: cfg.issues[0].assigneeAdapterOverrides,
      },
    },
    projects: { "X-Bookmarks": { live: { id: "p1" } } },
    goals: { autonomy: { id: "g1" } },
    agents: { "OMP Engineer": { id: "a1" }, "OMP Reviewer": { id: "a2" } },
    operator: { userId: "user-operator" },
  };

  const actions = [];
  planIssues(cfg, snap, actions);
  assert.equal(actions.length, 1, "a missing responsible user must be planned as drift, not ignored");
  const a = actions[0];
  assert.ok(a.allow.includes("responsibleUserId"), "responsibleUserId must be writable by the reconciler");
  assert.equal(a.body.responsibleUserId, "user-operator");
  assert.ok(a.expect.some((e) => e.path === "responsibleUserId" && e.value === "user-operator"),
    "and must be verified by readback like every other managed field");
});
