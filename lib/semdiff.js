"use strict";
// Semantic comparison for reconciliation.
//
// A literal deep-equal is the wrong test for most Paperclip objects, because the
// server mints identity for things the operator never wrote. `executionPolicy`
// is the sharp case: you POST two stages with participants and the server hands
// back the same two stages carrying fresh `id` uuids on the stage AND on each
// participant. A literal comparison of desired-vs-live would then report drift
// forever and re-PATCH on every single `factory apply`, which is worse than
// useless — it means `factory diff` can never reach empty and "no drift" stops
// being a meaningful gate.
//
// So comparison is by MEANING: server-generated identity is erased before
// comparing, and everything else must match exactly. Erasure is a fixed,
// explicit list, never a wildcard — a field is tolerated only because it is
// known to be server-minted, never because ignoring it makes a diff go away.

const { canonical, clone } = require("./util");

/** Field paths the server owns. Erased on both sides before comparison. */
const SERVER_OWNED = [
  "executionPolicy.stages[].id",
  "executionPolicy.stages[].participants[].id",
];

function stripServerIdentity(policy) {
  if (!policy || typeof policy !== "object") return policy ?? null;
  const out = clone(policy);
  if (Array.isArray(out.stages)) {
    out.stages = out.stages.map((stage) => {
      const s = { ...stage };
      delete s.id;
      if (Array.isArray(s.participants)) {
        s.participants = s.participants.map((p) => {
          const q = { ...p };
          delete q.id;
          // A participant carries exactly one of agentId/userId; the server
          // materializes the other as null. Drop nulls so {type,agentId} and
          // {type,agentId,userId:null} compare equal.
          for (const k of Object.keys(q)) if (q[k] === null) delete q[k];
          return q;
        });
      }
      for (const k of Object.keys(s)) if (s[k] === null) delete s[k];
      return s;
    });
  }
  return out;
}

/**
 * Compare desired against live for one named aspect.
 * Returns {equal, desired, live, normalizedDesired, normalizedLive}.
 */
function compareExecutionPolicy(desired, live) {
  const nd = stripServerIdentity(desired);
  const nl = stripServerIdentity(live);
  return {
    equal: canonical(nd) === canonical(nl),
    desired, live, normalizedDesired: nd, normalizedLive: nl,
  };
}

/**
 * Compare a plain object aspect where every field is operator-owned.
 * `keys` limits the comparison to the fields the factory manages, so unrelated
 * server-side fields on the same object never register as drift.
 */
function compareSubset(desired, live, keys) {
  const nd = {}, nl = {};
  for (const k of keys) {
    if (desired?.[k] !== undefined) nd[k] = desired[k];
    if (live?.[k] !== undefined && live[k] !== null) nl[k] = live[k];
    else if (live?.[k] === null && desired?.[k] === null) nl[k] = null;
  }
  return { equal: canonical(nd) === canonical(nl), normalizedDesired: nd, normalizedLive: nl };
}

/**
 * The workspace strategy is ATOMIC.
 *
 * `services/execution-workspace-policy.js:275` resolves it as
 *   issueSettings.workspaceStrategy ?? projectPolicy.workspaceStrategy ?? ...
 * `??` — not a merge. An issue-level strategy REPLACES the project one whole.
 * So a partial issue strategy such as `{type, baseRef}` silently discards the
 * project's branchTemplate and worktreeParentDir, and the run then lands on the
 * default branch name inside `<repo>/.paperclip/worktrees`. Comparing field by
 * field would call that "mostly right"; it is entirely wrong. Compare the whole
 * value or nothing.
 */
function compareWorkspaceStrategy(desired, live) {
  return { equal: canonical(desired ?? null) === canonical(live ?? null), desired, live };
}

module.exports = {
  SERVER_OWNED, stripServerIdentity, compareExecutionPolicy, compareSubset, compareWorkspaceStrategy,
};
