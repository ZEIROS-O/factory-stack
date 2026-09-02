"use strict";
// Generic objective resolution — the fix for the ZEI-1 hardcoding.
//
// Before this module, the Reviewer loaded contracts/objectives/ZEI-1.json from
// disk and `factory promote` accepted only issues declared in
// factory.config.json. Both made a Hermes-created child (ZEI-2, ZEI-7, any id)
// unreviewable and unpromotable: the objective for such a child exists ONLY as
// the spec document `factory handoff` installed on the child issue.
//
// So the resolution path here reads that document and nothing else. Every test
// below uses an arbitrary identifier deliberately — if any of them can be made
// to pass by special-casing ZEI-1, the defect has come back.

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveObjectiveForIssue } = require("../../lib/objective");
const { renderObjectiveDocument, objectiveHash, objectiveCriteriaHash } = require("../../lib/contracts");

/** A complete, hash-consistent ObjectiveEnvelopeV1 for any identifier. */
function envelope(identifier, overrides = {}) {
  const base = {
    schemaVersion: "ObjectiveEnvelopeV1",
    objectiveId: identifier,
    issueIdentifier: identifier,
    revision: 1,
    objectiveHash: "sha256:" + "0".repeat(64),
    criteriaHash: "sha256:" + "0".repeat(64),
    title: `Bounded work for ${identifier}`,
    originalRequest: "Do the bounded thing.",
    repository: { path: "/tmp/repo", baseCommit: "3cb8238", branch: `paperclip/${identifier}` },
    permissions: { filesystem: { read: ["."], write: ["src/a.js"] }, network: "provider_only", externalEffects: [] },
    limits: { wallClockMinutes: 45, costCeilingUsd: 4, outerFactoryCostCeilingUsd: 5, maxReviewRounds: 2 },
    verificationLevel: "important",
    expectedOutputs: ["a.js behaves"],
    constraints: ["Consume the workspace Paperclip supplied."],
    acceptanceCriteria: [{
      id: `${identifier}-AC-01`,
      requirement: "The suite passes.",
      command: { argv: ["node", "--test"], cwd: "." },
    }],
    ...overrides,
  };
  base.criteriaHash = objectiveCriteriaHash(base);
  base.objectiveHash = objectiveHash(base);
  return base;
}

/** The minimal API surface the resolver uses: one document GET. */
function apiServing(documents) {
  return {
    get: async (p) => {
      if (p in documents) return documents[p];
      throw new Error(`unexpected GET ${p}`);
    },
  };
}

test("resolves a hash-verified objective for an arbitrary issue id", async () => {
  const objective = envelope("ZEI-2");
  const api = apiServing({
    "/api/issues/child-uuid/documents/spec": { body: renderObjectiveDocument(objective) },
  });

  const resolved = await resolveObjectiveForIssue({ api, issueId: "child-uuid", identifier: "ZEI-2" });

  assert.equal(resolved.objectiveId, "ZEI-2");
  assert.equal(resolved.objectiveHash, objective.objectiveHash);
  assert.deepEqual(resolved.acceptanceCriteria.map((c) => c.id), ["ZEI-2-AC-01"]);
});

test("refuses a spec document whose envelope hashes do not match its content", async () => {
  const objective = envelope("ZEI-2");
  const rendered = renderObjectiveDocument(objective);
  // Tamper AFTER rendering: the write set gains a path the objective never
  // granted, which is exactly the edit that would widen an agent's authority.
  const tampered = rendered.replace('"src/a.js"', '"src/a.js",\n          "/etc/passwd"');
  const api = apiServing({ "/api/issues/child-uuid/documents/spec": { body: tampered } });

  await assert.rejects(
    () => resolveObjectiveForIssue({ api, issueId: "child-uuid", identifier: "ZEI-2" }),
    /objectiveHash does not match/,
  );
});

test("refuses an objective bound to a different issue than the one being resolved", async () => {
  // A spec document copied onto the wrong issue is hash-consistent with
  // itself; only the identifier binding catches it.
  const objective = envelope("ZEI-9");
  const api = apiServing({
    "/api/issues/child-uuid/documents/spec": { body: renderObjectiveDocument(objective) },
  });

  await assert.rejects(
    () => resolveObjectiveForIssue({ api, issueId: "child-uuid", identifier: "ZEI-2" }),
    /belongs to ZEI-9, not ZEI-2/,
  );
});

test("refuses an issue that carries no spec document at all", async () => {
  const api = { get: async () => null };

  await assert.rejects(
    () => resolveObjectiveForIssue({ api, issueId: "child-uuid", identifier: "ZEI-2" }),
    /carries no spec document/,
  );
});
