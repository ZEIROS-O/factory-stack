"use strict";
// The ONE way any consumer gets an objective for a live issue.
//
// WHY THIS MODULE EXISTS
//   The Reviewer used to load contracts/objectives/ZEI-1.json from disk, and
//   `factory promote` used to accept only issues declared in
//   factory.config.json. Both assumed every objective is authored by the
//   operator ahead of time and committed to the repository. That assumption is
//   false the moment Hermes creates a child: `factory handoff` derives the
//   child's objective from the parent request and installs it as the child's
//   `spec` document, and nothing about it exists on disk or in the config.
//
//   So a ZEI-2 could be created, dispatched, and worked — then neither
//   reviewed nor promoted. The two hardcodings were the hard blockers on
//   every objective after the first.
//
// WHERE TRUTH LIVES
//   The spec document on the issue. `factory handoff` installs it, verifies a
//   byte-exact readback, and records its revision in the immutable handoff
//   receipt (lib/handoff.js). `factory apply` installs the same document for
//   declared issues. Either way the document is the objective of record, and
//   the envelope inside it is self-verifying: verifyObjectiveHashes recomputes
//   both hashes from the content, so a tampered document cannot resolve.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   Fall back to disk. A resolver that silently reads a committed file when
//   the document is missing would reintroduce exactly the coupling this module
//   removes, and would let a stale on-disk objective review live work.

const { FactoryError } = require("./util");
const { objectiveFromSpecDocument } = require("./goal-gate");

const SPEC_DOCUMENT_KEY = "spec";

/** The document body, whichever envelope shape the endpoint returns it in. */
function specBody(doc) {
  const body = doc?.document?.body ?? doc?.body ?? null;
  return typeof body === "string" && body.trim() ? body : null;
}

/**
 * resolveObjectiveForIssue({ api, issueId, identifier }) -> verified envelope
 *
 * `issueId` addresses the document; `identifier` is the human id the objective
 * must claim. Passing the identifier is what stops a spec document copied onto
 * the wrong issue from resolving: the envelope is hash-consistent with itself
 * either way, so self-verification alone cannot catch a misfiled objective.
 */
async function resolveObjectiveForIssue({ api, issueId, identifier = null }) {
  if (!issueId) throw new FactoryError("resolveObjectiveForIssue requires an issue id");
  const path = `/api/issues/${encodeURIComponent(issueId)}/documents/${SPEC_DOCUMENT_KEY}`;
  const body = specBody(await api.get(path));
  if (!body) {
    throw new FactoryError(
      `issue ${identifier ?? issueId} carries no spec document, so it has no objective to work, ` +
      `review, or promote against. A child issue gets one from \`factory handoff\`; a declared ` +
      `issue gets one from \`factory apply\`.`,
      { issueId, identifier },
    );
  }
  // Hash-verifies the envelope as a side effect; a tampered document throws.
  const objective = objectiveFromSpecDocument(body);
  if (identifier && objective.issueIdentifier !== identifier) {
    throw new FactoryError(
      `objective ${objective.objectiveId} belongs to ${objective.issueIdentifier}, not ${identifier}`,
      { objectiveId: objective.objectiveId, declared: objective.issueIdentifier, actual: identifier },
    );
  }
  return objective;
}

module.exports = { SPEC_DOCUMENT_KEY, resolveObjectiveForIssue };
