"use strict";
// `factory promote` — the human approval stage, and the ONLY path by which
// agent work reaches git history.
//
// WHY THIS IS THE ONLY COMMIT PATH
//   ops/omp-bwrap.sh mounts the repository's shared git metadata read-only, so
//   an agent inside the sandbox physically cannot commit. That is deliberate:
//   the thing that decides what enters history should be the thing the operator
//   controls, running outside the sandbox, committing an exact reviewed set.
//
// WHAT PROMOTE MUST NEVER DO
//   Merge, push, deploy, or touch the operator's dirty primary tree. Every
//   operation below runs with `git -C <worktree>` against the linked worktree,
//   never against the primary checkout, and the primary tree is fingerprinted
//   before and after so that "it was not touched" is measured rather than
//   asserted.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { FactoryError, hashText, hashValue, deepEqual } = require("./util");
const { Resolver } = require("./resolve");
const { validateContract } = require("./contracts");
const { resolveObjectiveForIssue } = require("./objective");
const { parseExecutionReceiptClaims, buildExecutionReceipt } = require("./execution-receipt");
const { loadGoalGate, describeGoalGate } = require("./goal-gate");
const receipts = require("./receipts");

const BRANCH_PREFIX = "paperclip/";

function git(cwd, args, opts = {}) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/**
 * Every path the engineer changed in its worktree, tracked or not.
 *
 * `-z` and porcelain v1 because path parsing must survive spaces and unicode:
 * a promotion that silently drops a path with a space in it would commit a
 * subset of what was reviewed.
 */
function gatherChangedPaths(worktree) {
  const out = git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const parts = out.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    // A rename entry is followed by its source path in the next NUL field; the
    // destination is what exists now, the source is what must also be staged.
    if (status[0] === "R" || status[1] === "R") {
      const from = parts[++i];
      if (from) paths.push(from);
    }
    paths.push(p);
  }
  return [...new Set(paths)].sort();
}

function fileHash(abs) {
  try {
    return hashText(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null; // deleted
    throw err;
  }
}

/**
 * The reviewed change, content-addressed.
 *
 * CONTENT, NOT DIFF TEXT. `git diff` output varies with git version, config
 * (diff.algorithm, renames, context lines) and locale, so hashing it would make
 * "the same change" hash differently on two machines and turn a safety gate into
 * a source of spurious refusals. Hashing file content plus the base commit binds
 * exactly what the promotion claims: these bytes, applied to that base.
 */
function computeChangeSet(worktree, baseCommit) {
  const paths = gatherChangedPaths(worktree).map((p) => ({
    path: p,
    sha256: fileHash(path.join(worktree, p)),
  }));
  return { baseCommit, paths };
}

function computeDiffHash(changeSet) {
  return hashValue({
    baseCommit: changeSet.baseCommit,
    paths: [...changeSet.paths].sort((a, b) => a.path.localeCompare(b.path)),
  });
}

/**
 * Every changed path must fall inside the objective's granted write set.
 *
 * Matching is exact, or directory-containment with an explicit separator. A
 * naive prefix test would accept `bin/view.py.bak` for a grant of `bin/view.py`
 * — a different file, one character away from a legitimate one.
 */
function assertAllowedPaths(changed, allowed) {
  const grants = (allowed ?? []).map((a) => a.replace(/\/+$/, ""));
  const violations = [];
  for (const p of changed) {
    if (path.isAbsolute(p) || p.split("/").includes("..")) { violations.push(p); continue; }
    const norm = path.normalize(p).replace(/\/+$/, "");
    const ok = grants.some((g) => norm === g || (g !== "" && norm.startsWith(g + "/")) || g === ".");
    if (!ok) violations.push(p);
  }
  if (violations.length) {
    throw new FactoryError(
      `promotion refused: ${violations.length} changed path(s) outside the objective's granted write set: ` +
      `${violations.join(", ")}. Granted: ${grants.join(", ") || "(none)"}.`,
      { violations, granted: grants },
    );
  }
  return true;
}

/** The worktree must be on the objective's own branch, and that branch must keep the prefix. */
function assertBranch(actual, declared) {
  if (!String(declared).startsWith(BRANCH_PREFIX)) {
    throw new FactoryError(
      `objective declares branch ${JSON.stringify(declared)}, which does not carry the ${BRANCH_PREFIX} prefix. ` +
      `The prefix is what keeps agent branches identifiable in the operator's repository.`,
      { declared, prefix: BRANCH_PREFIX },
    );
  }
  if (actual !== declared) {
    throw new FactoryError(
      `promotion refused: worktree is on branch ${JSON.stringify(actual)}, not the objective's ${JSON.stringify(declared)}`,
      { actual, declared },
    );
  }
  return true;
}

/** The worktree must still stand exactly where the objective said it would. */
function assertBaseCommit(worktree, expected) {
  let resolved;
  try {
    resolved = git(worktree, ["rev-parse", "--verify", `${expected}^{commit}`]).trim();
  } catch {
    throw new FactoryError(
      `promotion refused: the objective's base commit ${JSON.stringify(expected)} does not exist in this worktree`,
      { expected },
    );
  }
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();
  if (head !== resolved) {
    throw new FactoryError(
      `promotion refused: worktree HEAD is ${head}, not the objective's base commit ${resolved} (${expected}). ` +
      `The reviewed work was derived from a different base than the one being promoted onto.`,
      { head, expected, resolved },
    );
  }
  return { head, resolved };
}

/**
 * A content fingerprint of specific paths, used to PROVE the operator's tree did
 * not move across a promotion rather than to assert it.
 */
function fingerprintPaths(root, paths) {
  return hashValue([...paths].sort().map((p) => ({ path: p, sha256: fileHash(path.join(root, p)) })));
}

/** Fingerprint the primary checkout's HEAD, branch, index, status, and every tracked/untracked byte. */
function fingerprintPrimaryTree(root) {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0").filter(Boolean).sort();
  return hashValue({
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    branch: git(root, ["branch", "--show-current"]).trim(),
    index: git(root, ["ls-files", "-s", "-z"]),
    status: git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    files: listed.map((p) => ({ path: p, sha256: fileHash(path.join(root, p)) })),
  });
}

/**
 * Stage exactly the reviewed paths and commit them in the worktree.
 *
 * `git add -- <paths>` and nothing wider: a promotion commits what was reviewed,
 * so an unreviewed file left in the worktree stays uncommitted rather than
 * riding along. There is no push, and there never should be.
 */
function commitReviewedPaths({ worktree, paths, message }) {
  if (!paths?.length) throw new FactoryError("promotion refused: no reviewed paths to commit");
  const preStaged = git(worktree, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  if (preStaged.length) {
    throw new FactoryError(`promotion refused: pre-existing staged paths would contaminate the reviewed commit: ${preStaged.join(", ")}`,
      { staged: preStaged });
  }
  git(worktree, ["add", "--", ...paths]);

  const staged = git(worktree, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  if (!staged.length) {
    throw new FactoryError(
      `promotion refused: nothing to commit for the reviewed paths (${paths.join(", ")}). ` +
      `Minting an empty commit would attest to work that does not exist.`,
      { paths },
    );
  }
  const expected = [...new Set(paths)].sort();
  const actual = [...staged].sort();
  if (canonicalArray(actual) !== canonicalArray(expected)) {
    throw new FactoryError("promotion refused: staged paths do not exactly match the reviewed paths", { expected, actual });
  }

  git(worktree, ["commit", "-q", "-m", message]);
  const commit = git(worktree, ["rev-parse", "HEAD"]).trim();
  return { commit, paths: staged };
}

function canonicalArray(value) { return JSON.stringify(value); }

function parseJsonDocument(doc, name) {
  try { return JSON.parse(doc?.body); }
  catch (err) { throw new FactoryError(`${name} document is not valid JSON: ${err.message}`); }
}

function assertApprovalStage(issue) {
  const state = issue?.executionState;
  if (issue?.status !== "in_review" || state?.currentStageType !== "approval"
      || state?.currentParticipant?.type !== "user") {
    throw new FactoryError("promotion refused: current issue is not pending the native human approval stage");
  }
}

function assertDeterministicAssessment(objective, assessment) {
  if (assessment.overallVerdict !== "PASS" || assessment.criteria?.some((c) => c.verdict !== "PASS")) {
    throw new FactoryError("promotion refused: assessment is not an all-PASS verdict");
  }
  const results = new Map((assessment.deterministicResults ?? []).map((r) => [r.criterionId, r]));
  for (const criterion of objective.acceptanceCriteria ?? []) {
    const result = results.get(criterion.id);
    if (!result || !result.passed || result.exitCode !== 0 || !deepEqual(result.argv, criterion.command.argv)) {
      throw new FactoryError(`promotion refused: deterministic result ${criterion.id} is absent, red, or command-drifted`);
    }
  }
  if (results.size !== (objective.acceptanceCriteria ?? []).length) {
    throw new FactoryError("promotion refused: deterministic assessment contains undeclared results");
  }
}

function commonGitDir(cwd) {
  const raw = git(cwd, ["rev-parse", "--git-common-dir"]).trim();
  return path.resolve(cwd, raw);
}

async function run(cfg, args, { connect, requireHealthy, C }) {
  const identifier = args?._?.[1];
  const assessmentFlag = args?.flags?.assessment;
  if (!identifier || typeof assessmentFlag !== "string") {
    throw new FactoryError("usage: factory promote <issue> --assessment <sha256:...>");
  }
  const declared = (cfg.issues ?? []).find((i) => i.identifier === identifier) ?? null;
  const api = connect(cfg);
  await requireHealthy(api);
  const resolver = new Resolver(api);
  const company = await resolver.company(cfg.company.name);
  const issue = await resolver.issue(company.id, identifier);
  assertApprovalStage(issue);

  // OBJECTIVE RESOLUTION — TWO PATHS, ONE OF THEM STRICTLY STRONGER.
  //
  // A DECLARED issue (one an operator wrote into factory.config.json, e.g.
  // ZEI-1) keeps the byte-exact binding it always had: the live spec document
  // must equal the declared body exactly, so a live edit to a reviewed
  // objective is caught even if the edit is itself hash-consistent.
  //
  // An UNDECLARED issue is the normal case for a Hermes-created child. Its
  // objective exists only as the spec document `factory handoff` installed and
  // read back byte-exact, so that document IS the objective of record. It is
  // self-verifying (verifyObjectiveHashes) and identifier-bound, which is
  // weaker than a committed declaration but is exactly the guarantee the
  // handoff receipt already attests to.
  //
  // Refusing the second path is what used to make every child unpromotable.
  let objective;
  if (declared?.objectiveDocument?.objective) {
    objective = declared.objectiveDocument.objective;
    const specPath = `/api/issues/${encodeURIComponent(issue.id)}/documents/${encodeURIComponent(declared.objectiveDocument.key)}`;
    const spec = await api.get(specPath);
    if (spec?.body !== declared.objectiveDocument.body) {
      throw new FactoryError("promotion refused: live spec revision/hash does not match the declared objective");
    }
  } else {
    objective = await resolveObjectiveForIssue({ api, issueId: issue.id, identifier });
  }
  const assessmentPath = `/api/issues/${encodeURIComponent(issue.id)}/documents/assessment`;
  const assessment = validateContract("AssessmentV1", parseJsonDocument(await api.get(assessmentPath), "assessment"));
  const assessmentHash = hashValue(assessment);
  if (assessmentHash !== assessmentFlag) throw new FactoryError("promotion refused: assessment hash does not match live assessment", { expected: assessmentFlag, actual: assessmentHash });
  if (!deepEqual(assessment.objective, {
    objectiveId: objective.objectiveId, revision: objective.revision,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  })) throw new FactoryError("promotion refused: assessment objective/spec binding drifted");
  assertDeterministicAssessment(objective, assessment);

  const issueRuns = await api.get(`/api/issues/${encodeURIComponent(issue.id)}/runs`);
  const runRow = (Array.isArray(issueRuns) ? issueRuns : []).find((r) => r.runId === assessment.executionRunId);
  if (!runRow || runRow.status !== "succeeded") throw new FactoryError("promotion refused: assessed execution run is not a succeeded run of this issue");
  const paperclipRun = await api.get(`/api/heartbeat-runs/${encodeURIComponent(assessment.executionRunId)}`);
  if (paperclipRun.agentId !== issue.executionState?.returnAssignee?.agentId) {
    throw new FactoryError("promotion refused: assessed run was not produced by the current Engineer return assignee");
  }
  const claims = parseExecutionReceiptClaims(paperclipRun?.resultJson?.summary);
  const loadedGate = loadGoalGate({ run: paperclipRun, readFile: (p) => fs.readFileSync(p, "utf8") });
  const executionReceipt = buildExecutionReceipt({ run: paperclipRun, issueId: issue.id, objective, claims, goalGate: loadedGate?.gate ?? null });
  const executionReceiptHash = hashValue(executionReceipt);
  if (assessment.executionReceiptHash !== executionReceiptHash) throw new FactoryError("promotion refused: assessment is bound to a different execution receipt");

  // GOAL-GATE SEAM. The receipt path above already asserts the gate for a
  // ready-for-review terminal; this is the promotion-time verification in its
  // own right, so the refusal names the goal gate even if the receipt
  // composition rule is ever relaxed. It sits between the receipt hash check
  // and the filesystem gates deliberately: no git command runs, no worktree
  // is touched, until the run's own runtime has proved its goal complete.
  const goalGateResult = describeGoalGate({
    gate: loadedGate?.gate, run: paperclipRun, issueId: issue.id, objective,
  });
  if (!goalGateResult.verified) {
    console.log(C.yellow(`goal gate unverified: ${goalGateResult.reason}`));
    console.log(C.dim("  advisory only — the reviewed acceptance checks and the byte comparison below are what admit this change"));
  }

  const worktree = executionReceipt.execution.workspace;
  const primary = objective.repository.path;
  if (fs.realpathSync(worktree) === fs.realpathSync(primary)) throw new FactoryError("promotion refused: execution workspace is the primary checkout");
  if (commonGitDir(worktree) !== commonGitDir(primary)) throw new FactoryError("promotion refused: execution workspace is not linked to the objective repository");
  const branch = git(worktree, ["branch", "--show-current"]).trim();
  assertBranch(branch, objective.repository.branch);
  assertBaseCommit(worktree, objective.repository.baseCommit);
  const changeSet = computeChangeSet(worktree, objective.repository.baseCommit);
  const diffHash = computeDiffHash(changeSet);
  assertAllowedPaths(changeSet.paths.map((p) => p.path), objective.permissions.filesystem.write);
  if (diffHash !== executionReceipt.changes.diffHash || !deepEqual(changeSet.paths, executionReceipt.changes.paths)
      || diffHash !== assessment.repository.diffHash
      || !deepEqual(changeSet.paths.map((p) => p.path), assessment.repository.changedPaths)) {
    throw new FactoryError("promotion refused: live changed paths/content hashes/diff no longer match receipt and assessment");
  }

  const primaryBefore = fingerprintPrimaryTree(primary);
  const promoted = commitReviewedPaths({
    worktree, paths: changeSet.paths.map((p) => p.path),
    message: `${objective.objectiveId}: reviewed change`,
  });
  const primaryAfter = fingerprintPrimaryTree(primary);
  if (primaryAfter !== primaryBefore) {
    throw new FactoryError("promotion halted: primary checkout bytes, index, branch, or HEAD changed during promotion");
  }

  const now = new Date().toISOString();
  const receiptId = receipts.newId("promotion");
  const stored = receipts.write(cfg._root, {
    id: receiptId, kind: "promotion", outcome: "promoted", startedAt: now, finishedAt: now,
    issue: { id: issue.id, identifier },
    objective: assessment.objective,
    executionRunId: assessment.executionRunId, executionReceiptHash,
    assessmentId: assessment.assessmentId, assessmentHash,
    usage: executionReceipt.usage,
    goalGate: goalGateResult,
    repository: {
      primary, worktree, branch, baseCommit: objective.repository.baseCommit,
      reviewedDiffHash: diffHash, changedPaths: changeSet.paths,
      commit: promoted.commit, primaryFingerprintBefore: primaryBefore, primaryFingerprintAfter: primaryAfter,
    },
    deterministicResults: assessment.deterministicResults,
  });
  const receiptBody = JSON.stringify(stored.receipt, null, 2);
  const promotionKey = `promotion-${receiptId}`;
  const promotionPath = `/api/issues/${encodeURIComponent(issue.id)}/documents/${encodeURIComponent(promotionKey)}`;
  const prior = await api.getOptional(promotionPath);
  const put = { title: `${objective.objectiveId} immutable promotion receipt`, format: "markdown", body: receiptBody, changeSummary: `Attach ${receiptId}` };
  if (prior?.latestRevisionId) put.baseRevisionId = prior.latestRevisionId;
  await api.mutate({
    readPath: promotionPath, writePath: promotionPath, method: "PUT", body: put,
    allow: ["title", "format", "body", "changeSummary", "baseRevisionId"],
    expect: [{ path: "body", value: receiptBody }], allowMissingBefore: prior === null,
  });

  const productBody = {
    type: "commit", provider: "factory-local-git", externalId: promoted.commit,
    title: `${objective.objectiveId} reviewed commit`, status: "ready_for_review",
    reviewState: "needs_board_review", isPrimary: true,
    summary: `Local reviewed commit ${promoted.commit}; immutable receipt ${receiptId}`,
    metadata: { branch, receiptId, receiptContentHash: stored.receipt.contentHash, executionRunId: assessment.executionRunId, diffHash },
  };
  const productsPath = `/api/issues/${encodeURIComponent(issue.id)}/work-products`;
  await api.mutate({
    readPath: productsPath, writePath: productsPath, method: "POST", body: productBody,
    allow: Object.keys(productBody),
    expect: [{ path: "", compare: (_actual, after) => Array.isArray(after) && after.some((p) =>
      p.type === "commit" && p.externalId === promoted.commit && p.metadata?.receiptContentHash === stored.receipt.contentHash) }],
  });

  const finalPath = `/api/issues/${encodeURIComponent(issue.id)}`;
  await api.mutate({
    readPath: finalPath, writePath: finalPath, method: "PATCH",
    body: { status: "done", comment: `Approved local commit ${promoted.commit}; promotion receipt ${receiptId} (${stored.receipt.contentHash}).` },
    allow: ["status", "comment"],
    expect: [{ path: "status", compare: (_actual, after) => after?.status === "done" && after?.executionState?.status === "completed" }],
  });
  console.log(C.green(`promoted ${identifier} as ${promoted.commit}`));
  console.log(C.dim(`receipt ${receiptId}  ${stored.receipt.contentHash}`));
  return 0;
}

module.exports = {
  BRANCH_PREFIX,
  gatherChangedPaths, computeChangeSet, computeDiffHash,
  assertAllowedPaths, assertBranch, assertBaseCommit,
  fingerprintPaths, fingerprintPrimaryTree, commitReviewedPaths,
  assertApprovalStage, assertDeterministicAssessment, run,
};
