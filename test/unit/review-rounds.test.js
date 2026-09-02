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

// This test previously asserted that the reconciler PATCHes responsibleUserId.
// It passed only because its fake server accepted every field. The real server
// cannot: `updateIssueSchema` explicitly omits responsibleUserId
// (packages/shared/src/validators/issue.ts:555), so the field is stripped from
// the payload and the request is answered 200 with the value unchanged. The
// escalation target is settable ONLY at issue creation.
//
// The invariant is unchanged — the escalation target must not drift away
// unnoticed — but it can only be enforced by refusing to plan, since no write
// exists that could carry it.
/**
 * A live snapshot mirroring EVERY declared issue, derived from the config
 * rather than hardcoded.
 *
 * This used to stub only ZEI-1, so adding a second issue to
 * factory.config.json crashed planIssues on the unstubbed project — a test
 * fixture failing for a reason that had nothing to do with what it asserts.
 * `responsibleUserId` is applied to the FIRST declared issue only, because
 * that is the one every assertion here is about; the rest carry the correct
 * operator id so they never mask the failure under test.
 */
function snapWithResponsible(cfg, responsibleUserId) {
  const issues = {};
  const issueDocuments = {};
  cfg.issues.forEach((declared, index) => {
    issues[declared.identifier] = {
      id: `issue-${index + 1}`, projectId: "p1", goalId: "g1",
      reviewPolicy: "not_creator", assigneeAgentId: "a1",
      responsibleUserId: index === 0 ? responsibleUserId : "user-operator",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: declared.executionWorkspaceSettings,
      executionPolicy: null,
      assigneeAdapterOverrides: declared.assigneeAdapterOverrides,
    };
    issueDocuments[declared.identifier] = {};
  });
  const projects = {};
  for (const project of cfg.projects) projects[project.name] = { live: { id: "p1" } };
  return {
    issues, issueDocuments, projects,
    goals: { autonomy: { id: "g1" } },
    agents: { "OMP Engineer": { id: "a1" }, "OMP Reviewer": { id: "a2" } },
    operator: { userId: "user-operator" },
  };
}

test("a NULL responsibleUserId — the silent-loop state — halts planning instead of planning a doomed PATCH", () => {
  const cfg = load(CONFIG);
  assert.throws(() => planIssues(cfg, snapWithResponsible(cfg, null), []), (err) => {
    assert.match(err.message, /settable only at issue creation/);
    assert.match(err.message, /Recreate the issue/);
    return true;
  }, "the escalation target must never be silently left null");
});

test("a responsibleUserId pointing at the WRONG principal also halts planning", () => {
  const cfg = load(CONFIG);
  // The membership-uuid bug produced exactly this shape: a plausible uuid that
  // is not a user. It must not be quietly tolerated.
  assert.throws(
    () => planIssues(cfg, snapWithResponsible(cfg, "43dc167f-8cb9-4d8e-b6dc-207a742bf87e"), []),
    /settable only at issue creation/,
  );
});

test("a correct responsibleUserId never appears in a PATCH body", () => {
  const cfg = load(CONFIG);
  const actions = [];
  planIssues(cfg, snapWithResponsible(cfg, "user-operator"), actions);
  for (const a of actions) {
    assert.ok(!("responsibleUserId" in (a.body ?? {})),
      "a field the server strips must never be written; it would fail readback every time");
    assert.ok(!(a.expect ?? []).some((e) => e.path === "responsibleUserId"),
      "and must not be asserted on readback of a write that never carried it");
  }
});
