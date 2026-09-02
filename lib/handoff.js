"use strict";
// `factory handoff` — the only path by which a Hermes handoff becomes an
// OMP Engineer objective in Paperclip.
//
// WHAT THIS COMMAND IS
//   Hermes has no repository write authority and no Paperclip authority. It
//   composes an EngineerHandoffDraftV1: facts that exist before Paperclip is
//   involved — parent issue, repository base, permissions, limits, acceptance
//   commands. Everything the draft cannot carry — child identifier, branch,
//   criterion ids, objective id, revision, hashes — is DERIVED here from what
//   Paperclip actually creates. The draft schema rejects any attempt to author
//   one, and so does every function below.
//
// ORDERING IS THE WHOLE POINT
//   Every refusal that can happen before a write, happens before the first
//   write. The ONLY mutation that makes the child dispatchable — assignee and
//   runnable status, together — is the LAST one. A failure at any step leaves
//   an unassigned, non-runnable child carrying a diagnostic comment: never a
//   delete, never a rollback, never a silent repair. The child is the evidence.
//
// THE BLOCKING RELATION, from the shipped server sources (not guessed):
//   `POST /api/issues/:id/children` with `blockParentUntilDone: true`
//   — route: @paperclipai/server/dist/routes/issues.js:6745
//   — schema flag: @paperclipai/shared/dist/validators/issue.js:419-427
//   creates the child with parentId set, then ADDS the child to the parent's
//   blockers:
//   — createChild: @paperclipai/server/dist/services/issues.js:5020
//   — blocker sync: services/issues.js:5060-5065 (syncBlockedByIssueIds, which
//     UNIONS with the parent's existing blockers rather than replacing them)
//   — relation row shape {issueId: blocker, relatedIssueId: blocked,
//     type: "blocks"}: services/issues.js:3813-3817
//   `GET /api/issues/:id` returns the relation summaries as `blockedBy`
//   (routes/issues.js:4954), which is how "blocks the parent" is verified by
//   readback instead of assumed from a 200.

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { FactoryError, hashValue, hashText, deepEqual } = require("./util");
const { Resolver, asArray } = require("./resolve");
const {
  validateContract, objectiveCriteriaHash, objectiveHash,
  verifyObjectiveHashes, renderObjectiveDocument,
} = require("./contracts");
const { BRANCH_PREFIX, assertAllowedPaths } = require("./promote");
const { compareExecutionPolicy } = require("./semdiff");
const receipts = require("./receipts");

const SPEC_DOCUMENT_KEY = "spec";

// Step labels for the failure diagnostic. A failure is reported with the step
// it failed at, what that step expected, and what was observed instead.
const STEP_CREATE = Object.freeze({
  name: "child creation",
  expected: "an unassigned backlog child that blocks its parent until done",
});
const STEP_SPEC = Object.freeze({
  name: "objective document",
  expected: "the immutable spec document stored byte-identical under its recomputed hashes",
});
const STEP_READINESS = Object.freeze({
  name: "child readiness",
  expected: "an isolated workspace with a complete strategy, limits matching the draft, " +
    "the resolved operator as responsible user, and the review-then-approval execution policy",
});
const STEP_ACTIVATE = Object.freeze({
  name: "activation",
  expected: "assignee and runnable status set together, in the final mutation only",
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The part of the child marker that identifies the handoff REQUEST. */
function handoffKeyToken(key) {
  return `factory-handoff idempotency-key=${key}`;
}

/** The full marker: request identity plus the exact draft content it binds. */
function handoffMarker(key, draftHash) {
  return `${handoffKeyToken(key)} draft-hash=${draftHash}`;
}

function loadDraft(draftPath) {
  let text;
  try { text = fs.readFileSync(draftPath, "utf8"); }
  catch (err) { throw new FactoryError(`cannot read handoff draft ${draftPath}: ${err.message}`); }
  try { return JSON.parse(text); }
  catch (err) { throw new FactoryError(`handoff draft ${draftPath} is not valid JSON: ${err.message}`); }
}

/**
 * Schema validation plus every semantic check the schema cannot express.
 * Runs entirely offline: a refused draft must leave ZERO requests on the wire.
 */
function validateDraft(draft) {
  validateContract("EngineerHandoffDraftV1", draft);

  let stat;
  try { stat = fs.statSync(draft.repository.path); }
  catch { throw new FactoryError(`handoff refused: repository path ${draft.repository.path} does not exist`); }
  if (!stat.isDirectory()) {
    throw new FactoryError(`handoff refused: repository path ${draft.repository.path} is not a directory`);
  }
  try {
    git(draft.repository.path, ["rev-parse", "--verify", `${draft.repository.baseCommit}^{commit}`]);
  } catch {
    throw new FactoryError(
      `handoff refused: base commit ${draft.repository.baseCommit} does not resolve in ${draft.repository.path}`);
  }

  const write = draft.permissions.filesystem.write ?? [];
  if (!write.length) {
    throw new FactoryError(
      "handoff refused: the draft grants no write authority; an Engineer objective with an " +
      "empty write set can only produce nothing");
  }
  // Reuse promote's containment checker against itself: every granted path must
  // be relative and free of '..' segments. assertAllowedPaths rejects absolute
  // paths and any '..' component outright, which is exactly the containment
  // rule the Engineer's worktree guard will later enforce against changes.
  assertAllowedPaths(write, write);

  if (draft.limits.costCeilingUsd > draft.limits.outerFactoryCostCeilingUsd) {
    throw new FactoryError(
      "handoff refused: costCeilingUsd exceeds outerFactoryCostCeilingUsd; the child alone " +
      "would out-cost the whole factory loop");
  }
  if (!(draft.constraints ?? []).length) {
    throw new FactoryError(
      "handoff refused: the draft carries no constraints, and an ObjectiveEnvelopeV1 requires " +
      "at least one; an objective with no hard rules cannot be reviewed against any");
  }
  for (const [i, ac] of draft.acceptanceCommands.entries()) {
    const argv0 = ac.command.argv[0];
    // A bare program name only: no separators, no whitespace, no shell syntax.
    // A shell string here means quoting and injection differ between the
    // caller and the executor, and the acceptance command stops proving
    // anything about what actually ran.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(argv0)) {
      throw new FactoryError(
        `handoff refused: acceptance command ${i} argv[0] ${JSON.stringify(argv0)} is not a bare ` +
        `program name; shell strings are not argv`);
    }
  }
  return draft;
}

/**
 * Every identifier the objective needs, derived from the child Paperclip
 * actually created. Nothing is authored, nothing is guessed.
 */
function deriveChildIdentifiers({ draft, child }) {
  const identifier = child?.identifier;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(String(identifier ?? "")) || !draft?.acceptanceCommands?.length) {
    throw new FactoryError(
      "cannot derive identifiers: the child carries no Paperclip issue identifier, " +
      "or the draft declares no acceptance commands");
  }
  return {
    branch: BRANCH_PREFIX + identifier,
    criterionIds: draft.acceptanceCommands.map(
      (_ac, i) => `${identifier}-AC-${String(i + 1).padStart(2, "0")}`),
    objectiveId: identifier,
  };
}

/**
 * The full ObjectiveEnvelopeV1, hashes computed with the existing helpers and
 * verified before it leaves the room. Any ids value that was authored rather
 * than derived is refused — a wrong criterion id is a defect, not a shortcut.
 */
function buildObjectiveEnvelope({ draft, child, ids }) {
  const expected = deriveChildIdentifiers({ draft, child });
  if (ids?.objectiveId !== expected.objectiveId) {
    throw new FactoryError(
      `objective id ${JSON.stringify(ids?.objectiveId)} was authored, not derived; it must be ` +
      `the child identifier ${expected.objectiveId}`);
  }
  if (ids?.branch !== expected.branch) {
    throw new FactoryError(
      `branch ${JSON.stringify(ids?.branch)} was authored, not derived; it must be ` +
      `"paperclip/" + the child identifier (${expected.branch})`);
  }
  const criterionIds = ids?.criterionIds ?? [];
  if (criterionIds.length !== expected.criterionIds.length
      || criterionIds.some((id, i) => id !== expected.criterionIds[i])) {
    throw new FactoryError(
      "criterion ids were authored, not derived from the child identifier; expected " +
      `${JSON.stringify(expected.criterionIds)}, got ${JSON.stringify(criterionIds)}`);
  }
  const objective = {
    schemaVersion: "ObjectiveEnvelopeV1",
    objectiveId: expected.objectiveId,
    issueIdentifier: child.identifier,
    revision: 1,
    title: draft.title,
    originalRequest: draft.originalRequest,
    repository: {
      path: draft.repository.path,
      baseCommit: draft.repository.baseCommit,
      branch: expected.branch,
    },
    permissions: draft.permissions,
    limits: draft.limits,
    verificationLevel: draft.verificationLevel,
    expectedOutputs: draft.expectedOutputs,
    constraints: draft.constraints,
    acceptanceCriteria: draft.acceptanceCommands.map((ac, i) => ({
      id: expected.criterionIds[i],
      requirement: ac.requirement,
      command: ac.command,
    })),
  };
  objective.criteriaHash = objectiveCriteriaHash(objective);
  objective.objectiveHash = objectiveHash(objective);
  return verifyObjectiveHashes(objective);
}

/** Pull the ObjectiveEnvelopeV1 JSON block back out of a rendered document. */
function envelopeFromRenderedBody(body) {
  const m = /```json\n([\s\S]*?)\n```/.exec(String(body ?? ""));
  let parsed = null;
  try { parsed = m ? JSON.parse(m[1]) : null; }
  catch { parsed = null; }
  if (!parsed) {
    throw new FactoryError("stored objective document has no parsable ObjectiveEnvelopeV1 block");
  }
  return verifyObjectiveHashes(parsed);
}

/** The first successful receipt for this key and child, if one was recorded. */
function replayedHandoffReceipt(root, draft, child) {
  try {
    const rows = receipts.list(root);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row?.kind === "handoff" && row?.handoff?.schemaVersion === "EngineerHandoffReceiptV1"
          && row?.handoff?.idempotencyKey === draft.idempotencyKey
          && row?.handoff?.childIssueId === child.id) {
        return row.handoff;
      }
    }
  } catch {
    // An unreadable store is not a handoff failure; fall through and derive
    // the receipt from the live state that was just verified.
  }
  return null;
}

/**
 * The failure diagnostic. THE CHILD IS THE EVIDENCE: it stays, unassigned and
 * non-runnable, with a comment naming the failed step. The only write this
 * performs is the comment itself, through api.mutate like every other write.
 */
async function postDiagnosticComment(api, childId, draft, step, err) {
  if (!childId) return;
  const comment =
    `factory handoff ${draft.idempotencyKey} failed at ${step.name}. ` +
    `Expected: ${step.expected}. Observed: ${err?.message ?? String(err)}. ` +
    `The child is deliberately left unassigned and non-runnable. Fix the cause and re-run ` +
    `factory handoff with the same idempotency key; do not delete this child and do not ` +
    `create a second one for the same work.`;
  const commentsPath = `/api/issues/${encodeURIComponent(childId)}/comments`;
  await api.mutate({
    readPath: commentsPath, writePath: commentsPath, method: "POST",
    body: { body: comment },
    allow: ["body"],
    expect: [{ path: "", compare: (_actual, after) =>
      Array.isArray(after) && after.some((c) => String(c?.body ?? "").includes(draft.idempotencyKey)) }],
  });
}

async function run(cfg, args, { connect, requireHealthy, C }) {
  const draftPath = args?.flags?.draft;
  if (typeof draftPath !== "string") {
    throw new FactoryError("usage: factory handoff --draft <path-to-EngineerHandoffDraftV1.json>");
  }
  // BEFORE any request: a draft that cannot become a valid objective must be
  // refused with zero writes AND zero reads on the control plane.
  const draft = validateDraft(loadDraft(draftPath));
  const draftHash = hashValue(draft);
  const marker = handoffMarker(draft.idempotencyKey, draftHash);
  const keyToken = handoffKeyToken(draft.idempotencyKey);

  const api = connect(cfg);
  await requireHealthy(api);
  const resolver = new Resolver(api);
  const company = await resolver.company(cfg.company.name);
  // The escalation target. A null responsible user makes round exhaustion fall
  // through to reassigning the Engineer (issue-execution-policy.js:681) — the
  // loop the architecture forbids. member() resolves a USER id, never a
  // membership id, and refuses rather than guessing.
  const operator = await resolver.member(company.id, cfg.operator.memberEmail);

  const engineerDecl = (cfg.agents ?? []).find((a) => a.instructions?.bundle === "engineer");
  const reviewerDecl = (cfg.agents ?? []).find((a) => a.instructions?.bundle === "reviewer");
  if (!engineerDecl || !reviewerDecl) {
    throw new FactoryError(
      "config declares no engineer and/or reviewer agent bundle; a handoff child's policy " +
      "and assignment can only be built mechanically from both");
  }
  const engineer = await resolver.agent(company.id, engineerDecl.name);
  const reviewer = await resolver.agent(company.id, reviewerDecl.name);

  // ---- step 1 (network half): the parent boundary, before any write ------
  const parent = await resolver.issue(company.id, draft.parentIssueIdentifier);
  if (parent.companyId !== company.id) {
    throw new FactoryError(`handoff refused: parent ${parent.identifier} belongs to another company`);
  }
  if (parent.parentId) {
    throw new FactoryError(
      `handoff refused: parent ${parent.identifier} is itself a child of ${parent.parentId}; ` +
      `a handoff child must never spawn handoff children`);
  }

  // The child's workspace strategy is DERIVED, never authored: the operator's
  // layout (type, branchTemplate, worktreeParentDir) comes from the parent's
  // live complete strategy, and the base from the draft. A parent with a
  // partial strategy cannot donate one without reproducing the silent-replace
  // hazard (execution-workspace-policy.js:275 resolves with `??`, not a merge).
  const parentStrategy = parent.executionWorkspaceSettings?.workspaceStrategy;
  if (!parentStrategy || !parentStrategy.type || !parentStrategy.worktreeParentDir
      || !parentStrategy.branchTemplate) {
    throw new FactoryError(
      `handoff refused: parent ${parent.identifier} carries no complete workspaceStrategy to ` +
      `derive the child's from; a partial strategy would silently replace the project's`);
  }
  if (!String(parentStrategy.branchTemplate).includes("{{issue.identifier}}")) {
    throw new FactoryError(
      `handoff refused: parent ${parent.identifier} branchTemplate ` +
      `${JSON.stringify(parentStrategy.branchTemplate)} has no {{issue.identifier}} ` +
      `placeholder, so the child would not get its own branch`);
  }
  const childStrategy = {
    type: parentStrategy.type,
    baseRef: draft.repository.baseCommit,
    branchTemplate: parentStrategy.branchTemplate,
    worktreeParentDir: parentStrategy.worktreeParentDir,
  };
  const childPolicy = {
    mode: "normal",
    commentRequired: true,
    maxReviewRounds: draft.limits.maxReviewRounds,
    stages: [
      { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewer.id }] },
      { type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId: operator.userId }] },
    ],
  };

  // Idempotency: look for an existing child of this parent carrying this key
  // BEFORE creating anything. The marker lives on the first description line,
  // so the list projection's truncated description preview still contains it.
  const childrenPath = `/api/companies/${encodeURIComponent(company.id)}/issues?parentId=${encodeURIComponent(parent.id)}`;
  const keyMatch = (row) => row?.parentId === parent.id && String(row?.description ?? "").includes(keyToken);
  const existing = asArray(await api.get(childrenPath), "issues").find(keyMatch) ?? null;
  if (existing) {
    const stored = / draft-hash=(sha256:[0-9a-f]{64})/.exec(String(existing.description ?? ""));
    if (stored?.[1] !== draftHash) {
      throw new FactoryError(
        `handoff refused: idempotency key ${JSON.stringify(draft.idempotencyKey)} is already bound ` +
        `to a different draft (stored ${stored?.[1] ?? "(none)"}, this run ${draftHash}). ` +
        `Author a new draft with a new key.`);
    }
    if (existing.status === "done" || existing.status === "cancelled") {
      throw new FactoryError(
        `handoff refused: the child for idempotency key ${JSON.stringify(draft.idempotencyKey)} ` +
        `is already ${existing.status}; its key is spent`);
    }
  }

  let child = null;
  let step = STEP_CREATE;
  try {
    // ---- step 2: the idempotent, unassigned, parent-blocking child ---------
    if (!existing) {
      const childBody = {
        title: draft.title,
        description: `${marker}\n\n${draft.originalRequest}`,
        status: "backlog",
        responsibleUserId: operator.userId,
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: childStrategy },
        executionPolicy: childPolicy,
        blockParentUntilDone: true,
      };
      const created = await api.mutate({
        readPath: childrenPath,
        writePath: `/api/issues/${encodeURIComponent(parent.id)}/children`,
        method: "POST",
        body: childBody,
        allow: ["title", "description", "status", "responsibleUserId",
                "executionWorkspacePreference", "executionWorkspaceSettings",
                "executionPolicy", "blockParentUntilDone"],
        expect: [{ path: "", compare: (_actual, after) =>
          Array.isArray(after) && after.some((row) => keyMatch(row) && String(row.description).includes(marker)) }],
        unwrap: (x) => asArray(x, "issues"),
      });
      const row = created.after.find((r) => keyMatch(r) && String(r.description ?? "").includes(marker));
      if (!row) throw new FactoryError("handoff failed: the created child could not be identified by its marker");
      child = await api.get(`/api/issues/${encodeURIComponent(row.id)}`);
    } else {
      child = await api.get(`/api/issues/${encodeURIComponent(existing.id)}`);
    }

    // The blocking relation is read back, not assumed: `blockedBy` on the
    // parent row is the server's own relation summary (routes/issues.js:4954).
    const parentNow = await api.get(`/api/issues/${encodeURIComponent(parent.id)}`);
    if (!(parentNow.blockedBy ?? []).some((b) => b.id === child.id)) {
      throw new FactoryError(
        `handoff failed: child ${child.identifier} does not block parent ${parent.identifier} ` +
        `(blockParentUntilDone did not persist)`);
    }

    // ---- steps 3-4: derive ids, install the immutable spec document --------
    step = STEP_SPEC;
    const ids = deriveChildIdentifiers({ draft, child });
    const objective = buildObjectiveEnvelope({ draft, child, ids });
    const specPath = `/api/issues/${encodeURIComponent(child.id)}/documents/${SPEC_DOCUMENT_KEY}`;
    const body = renderObjectiveDocument(objective);
    const prior = await api.getOptional(specPath);
    if (prior && prior.body !== body) {
      throw new FactoryError(
        `handoff refused: issue ${child.identifier} already carries a spec document with a ` +
        `different body; an installed objective is never silently overwritten`);
    }
    let specRevisionId = prior?.latestRevisionId ?? null;
    if (!prior) {
      const put = {
        title: `${objective.objectiveId} immutable objective (ObjectiveEnvelopeV1)`,
        format: "markdown",
        body,
        changeSummary: `Install objective revision 1 (hash-bound) from handoff ${draft.idempotencyKey}`,
      };
      // documents.js:291 rejects an update with no baseRevisionId outright;
      // a create has no prior revision to bind, hence allowMissingBefore.
      const stored = await api.mutate({
        readPath: specPath, writePath: specPath, method: "PUT", body: put,
        allow: ["title", "format", "body", "changeSummary", "baseRevisionId"],
        expect: [
          { path: "title", value: put.title },
          { path: "format", value: put.format },
          { path: "body", value: body },
          { path: "latestRevisionId", compare: (actual) => typeof actual === "string" && actual.length > 0 },
        ],
        allowMissingBefore: true,
      });
      specRevisionId = stored.after?.latestRevisionId ?? null;
    }
    if (!specRevisionId) {
      throw new FactoryError("handoff failed: the spec document carries no revision id");
    }
    // INDEPENDENT re-read. api.mutate already re-GETs, but a server can serve
    // the fresh write to the immediate readback and stale bytes to everyone
    // after. HTTP success is not proof; this second GET is the check.
    const readback = await api.get(specPath);
    if (!readback || readback.body !== body) {
      throw new FactoryError(
        "handoff failed: the spec document read back byte-different from the objective that " +
        "was sent; the stored hashes do not bind to this handoff");
    }
    const documentBodyHash = hashText(readback.body);
    if (documentBodyHash !== hashText(body)) {
      throw new FactoryError("handoff failed: the stored document body does not hash to the sent body");
    }
    const storedEnvelope = envelopeFromRenderedBody(readback.body);
    if (storedEnvelope.objectiveHash !== objective.objectiveHash
        || storedEnvelope.criteriaHash !== objective.criteriaHash
        || !deepEqual(storedEnvelope.limits, draft.limits)) {
      throw new FactoryError(
        "handoff failed: the stored objective's hashes or limits do not match the recomputed " +
        "envelope; the child would run against an objective other than the one handed off");
    }

    // ---- step 5: readiness, asserted on the child by reading it back ------
    step = STEP_READINESS;
    const live = await api.get(`/api/issues/${encodeURIComponent(child.id)}`);
    if (live.executionWorkspacePreference !== "isolated_workspace") {
      throw new FactoryError(
        `handoff refused: child ${child.identifier} executionWorkspacePreference is ` +
        `${JSON.stringify(live.executionWorkspacePreference)}, not isolated_workspace`);
    }
    const liveSettings = live.executionWorkspaceSettings ?? {};
    const liveStrategy = liveSettings.workspaceStrategy;
    for (const field of ["type", "baseRef", "branchTemplate", "worktreeParentDir"]) {
      if (!liveStrategy || liveStrategy[field] === undefined || liveStrategy[field] === null) {
        throw new FactoryError(
          `handoff refused: child ${child.identifier} carries a partial workspaceStrategy ` +
          `(no ${field}); a partial strategy silently REPLACES the complete one and the run ` +
          `lands on an uncontrolled branch`);
      }
    }
    if (liveSettings.mode !== "isolated_workspace" || !deepEqual(liveStrategy, childStrategy)) {
      throw new FactoryError(
        `handoff refused: child ${child.identifier} workspace settings do not match the ` +
        `derived strategy`);
    }
    if (!live.responsibleUserId || live.responsibleUserId !== operator.userId) {
      throw new FactoryError(
        `handoff refused: child ${child.identifier} responsibleUserId is ` +
        `${JSON.stringify(live.responsibleUserId)}, not the resolved operator user ` +
        `${operator.userId}; a null escalation target silently reassigns exhausted reviews ` +
        `to the Engineer`);
    }
    if (!compareExecutionPolicy(childPolicy, live.executionPolicy).equal) {
      throw new FactoryError(
        `handoff refused: child ${child.identifier} execution policy is not review (Reviewer ` +
        `agent) then approval (operator) with commentRequired and the draft's maxReviewRounds`);
    }

    // ---- step 6: activation, the FINAL mutation, and nothing earlier ------
    step = STEP_ACTIVATE;
    let replayed = false;
    if (live.assigneeAgentId === engineer.id && live.status === "todo") {
      // A previous run of this same key and draft already activated the child.
      // Re-verified end to end above; now a strict no-op.
      replayed = true;
    } else if (live.assigneeAgentId == null && live.status === "backlog") {
      await api.mutate({
        readPath: `/api/issues/${encodeURIComponent(child.id)}`,
        writePath: `/api/issues/${encodeURIComponent(child.id)}`,
        method: "PATCH",
        body: { assigneeAgentId: engineer.id, status: "todo" },
        allow: ["assigneeAgentId", "status"],
        expect: [
          { path: "assigneeAgentId", value: engineer.id },
          { path: "status", value: "todo" },
        ],
      });
    } else {
      throw new FactoryError(
        `handoff refused: child ${child.identifier} is in status ${JSON.stringify(live.status)} ` +
        `with assignee ${JSON.stringify(live.assigneeAgentId)}; it has moved beyond a fresh ` +
        `handoff and will not be clobbered`);
    }

    // ---- success: an EngineerHandoffReceiptV1, validated and stored --------
    const now = new Date().toISOString();
    const stored = replayed ? replayedHandoffReceipt(cfg._root, draft, child) : null;
    const receipt = stored ?? {
      schemaVersion: "EngineerHandoffReceiptV1",
      parentIssueId: parent.id,
      parentIssueIdentifier: parent.identifier,
      childIssueId: child.id,
      childIssueIdentifier: child.identifier,
      idempotencyKey: draft.idempotencyKey,
      objectiveId: objective.objectiveId,
      revision: objective.revision,
      objectiveHash: objective.objectiveHash,
      criteriaHash: objective.criteriaHash,
      specRevisionId,
      activation: { assignedAgent: engineer.name, status: "runnable", blocksParent: true },
      readback: { verified: true, documentBodyHash, checkedAt: now },
    };
    validateContract("EngineerHandoffReceiptV1", receipt);
    if (!stored) {
      const receiptId = receipts.newId("handoff");
      receipts.write(cfg._root, {
        id: receiptId, kind: "handoff", outcome: "handed_off",
        startedAt: now, finishedAt: new Date().toISOString(),
        draftHash, handoff: receipt,
      });
      console.log(C.green(`handoff ${draft.idempotencyKey}: ${parent.identifier} -> ${child.identifier} (activated)`));
      console.log(C.dim(`receipt ${receiptId}  document body ${documentBodyHash}`));
    } else {
      // A verified no-op replays the EXISTING receipt: same payload, no second
      // local record, zero writes on the control plane.
      console.log(C.green(`handoff ${draft.idempotencyKey}: ${parent.identifier} -> ${child.identifier} (replayed)`));
      console.log(C.dim(`existing receipt replayed  document body ${documentBodyHash}`));
    }
    return 0;
  } catch (err) {
    // FAILURE DISCIPLINE. The child stays — unassigned, non-runnable, carrying
    // a diagnostic. It is never deleted, partial state is never rolled back,
    // and nothing is silently repaired. Then the original failure re-raises.
    try { await postDiagnosticComment(api, child?.id, draft, step, err); }
    catch { /* the original failure is the signal; a lost comment is secondary */ }
    throw err;
  }
}

module.exports = {
  run, validateDraft, deriveChildIdentifiers, buildObjectiveEnvelope,
  loadDraft, handoffMarker, envelopeFromRenderedBody,
};
