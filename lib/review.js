"use strict";
// The decision logic behind `paperclip_review` — the Reviewer's only
// write-capable tool.
//
// WHY THIS IS A LIBRARY AND NOT THE PLUGIN
//   OMP loads the tool as an ESM module inside a sandbox, driven by a model.
//   None of that is reachable from node:test. So the plugin under
//   omp/plugins/paperclip-review is a thin adapter, and every rule that decides
//   whether work is approved lives here, where it can be probed directly and
//   mutated to prove the tests bite.
//
// THE AUTHORITY BOUNDARY THIS FILE ENFORCES
//   The Reviewer chooses a verdict. It does not choose what it reviews, it does
//   not run the acceptance commands under its own permissions, and it cannot
//   express any outcome except the two dispositions below. Everything here is
//   built so that the narrow thing is the only thing expressible.

const { FactoryError, hashText, hashValue, deepEqual } = require("./util");
const { validateContract } = require("./contracts");
const { assertGoalGate } = require("./goal-gate");

/** The complete set of outcomes a review may express. There is no third. */
const DISPOSITIONS = Object.freeze(["approve", "request_changes"]);

/** Worst-first: the honest summary of a mixed set is its strongest negative. */
const VERDICT_RANK = Object.freeze(["FAIL", "BLOCKED", "UNCERTAIN", "PASS"]);

// Every environment variable that must be present for a review to be possible.
// The tool derives its target from these and accepts no issue argument at all —
// see deriveReviewContext.
const REQUIRED_ENV = Object.freeze({
  issueId: "PAPERCLIP_TASK_ID",
  runId: "PAPERCLIP_RUN_ID",
  apiUrl: "PAPERCLIP_API_URL",
  apiKey: "PAPERCLIP_API_KEY",
  worktree: "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
});

/**
 * Derive what is being reviewed from the run environment.
 *
 * The signature takes an environment and nothing else. That is the point: there
 * is no parameter through which a model could aim this tool at a different
 * issue, so "review only the current issue" is a property of the shape rather
 * than a check that could be forgotten. Paperclip identifies the issue to a
 * dispatched run as PAPERCLIP_TASK_ID; no other variable is consulted, and
 * anything issue-shaped that appears elsewhere in the environment is ignored.
 */
function deriveReviewContext(env) {
  const out = {};
  for (const [field, name] of Object.entries(REQUIRED_ENV)) {
    const value = env?.[name];
    if (typeof value !== "string" || !value.trim()) {
      throw new FactoryError(
        `paperclip_review cannot identify its run: ${name} is missing or empty. ` +
        `This tool reviews the run it was dispatched for and refuses to guess.`,
        { missing: name },
      );
    }
    out[field] = value.trim();
  }
  // Optional: present for git_worktree strategies, absent for other modes.
  out.branch = typeof env.PAPERCLIP_WORKSPACE_BRANCH === "string" ? env.PAPERCLIP_WORKSPACE_BRANCH : null;
  return out;
}

/**
 * The vendor segment exactly as the run declared it — "openai-codex", not a
 * normalisation of it. This is what gets RECORDED, because an assessment should
 * say which route actually produced the review.
 *
 * "openrouter/anthropic/claude-opus-5" still reduces to "anthropic": a routing
 * prefix names the broker, not the model's author.
 */
function modelVendor(model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const parts = model.trim().toLowerCase().split("/").filter(Boolean);
  // The vendor is the last segment that still has a model name after it.
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

/**
 * The family used to decide INDEPENDENCE, which is a coarser question than
 * identity: "openai-codex" and "openai" are two products of one lab, so a review
 * of one by the other is a house opinion twice, not two opinions. Independence
 * is about who trained the weights, so the comparison deliberately collapses
 * product suffixes that the recorded identity keeps.
 */
function modelFamily(model) {
  const vendor = modelVendor(model);
  return vendor === null ? null : vendor.replace(/-(codex|chat|api|preview)$/, "");
}

/** Refuse a review by the producer's own family — a different transport is not independence. */
function assertModelIndependence({ engineerModel, reviewerModel }) {
  const a = modelFamily(engineerModel);
  const b = modelFamily(reviewerModel);
  if (!a || !b) {
    throw new FactoryError(
      `paperclip_review cannot establish model identity (producer=${JSON.stringify(engineerModel ?? null)}, ` +
      `reviewer=${JSON.stringify(reviewerModel ?? null)}). Independence unproven is independence absent.`,
      { engineerModel: engineerModel ?? null, reviewerModel: reviewerModel ?? null },
    );
  }
  if (a === b) {
    throw new FactoryError(
      `reviewer and producer are the same model family (${a}); a different transport in front of the ` +
      `same family is not independence. Escalate to the operator rather than reviewing.`,
      { family: a, engineerModel, reviewerModel },
    );
  }
  return {
    engineerFamily: a, reviewerFamily: b,
    engineerVendor: modelVendor(engineerModel), reviewerVendor: modelVendor(reviewerModel),
  };
}

/**
 * Execute every declared acceptance command in the read-only verifier.
 *
 * The argv array is passed through element by element and never joined into a
 * string: an argv that cannot become a shell string cannot grow a redirect or a
 * second command on its way to being run.
 */
function runAcceptanceChecks({ objective, worktree, verifierPath, exec, timeoutMs = 15 * 60 * 1000 }) {
  const criteria = objective?.acceptanceCriteria ?? [];

  // Validate EVERY command before running ANY of them. A malformed criterion
  // discovered halfway through would otherwise leave a partial result set that
  // reads like a real one.
  for (const c of criteria) {
    if (!Array.isArray(c?.command?.argv) || c.command.argv.length === 0
        || !c.command.argv.every((a) => typeof a === "string")) {
      throw new FactoryError(
        `acceptance criterion ${c?.id}: command must be a non-empty argv array of strings, ` +
        `not ${JSON.stringify(c?.command)}. Shell strings are not executable here by construction.`,
        { criterionId: c?.id },
      );
    }
  }

  return criteria.map((c) => {
    const argv = c.command.argv;
    const cwd = typeof c.command.cwd === "string" && c.command.cwd ? c.command.cwd : ".";
    const args = ["--worktree", worktree, "--cwd", cwd, "--", ...argv];
    const r = exec(verifierPath, args, { encoding: "utf8", timeout: timeoutMs });

    const stdout = r?.stdout ?? "";
    const stderr = r?.stderr ?? "";
    const exitCode = typeof r?.status === "number" ? r.status : null;
    return {
      criterionId: c.id,
      argv,
      cwd,
      exitCode,
      // A verifier that could not run is a FAILED check. Treating "no result" as
      // success is the exact shape of the 200-and-do-nothing defect this system
      // exists to refuse.
      passed: exitCode === 0,
      outputHash: hashText(`${stdout}\x00${stderr}`),
      stdoutHash: hashText(stdout),
      stderrHash: hashText(stderr),
      error: r?.error ? String(r.error.message ?? r.error) : null,
    };
  });
}

/** Every objective criterion judged exactly once: no gaps, no extras, no duplicates. */
function assertCriteriaCoverage(objective, criteria) {
  const declared = (objective?.acceptanceCriteria ?? []).map((c) => c.id);
  const seen = new Map();
  for (const c of criteria ?? []) {
    if (seen.has(c.criterionId)) {
      throw new FactoryError(`criterion ${c.criterionId} is judged twice; one criterion gets one verdict`,
        { criterionId: c.criterionId });
    }
    seen.set(c.criterionId, c);
  }
  const missing = declared.filter((id) => !seen.has(id));
  if (missing.length) {
    throw new FactoryError(
      `assessment does not judge every acceptance criterion; missing: ${missing.join(", ")}. ` +
      `An unjudged criterion is how unreviewed work gets approved.`,
      { missing },
    );
  }
  const extra = [...seen.keys()].filter((id) => !declared.includes(id));
  if (extra.length) {
    throw new FactoryError(
      `assessment judges criteria that the objective does not declare: ${extra.join(", ")}`,
      { extra },
    );
  }
  return true;
}

/** Worst case wins. Never a bare approval that outruns its own criteria. */
function deriveOverallVerdict(criteria) {
  const verdicts = (criteria ?? []).map((c) => c.verdict);
  if (!verdicts.length) return "BLOCKED";
  for (const rank of VERDICT_RANK) if (verdicts.includes(rank)) return rank;
  return "BLOCKED";
}

/**
 * The disposition is DERIVED, never asserted.
 *
 * Two independent conditions must both hold to approve: every criterion PASS,
 * and every deterministic check green. They are separate on purpose — a reviewer
 * convinced by the code cannot approve over a red check, and a green suite
 * cannot approve a criterion the reviewer judged FAIL.
 */
function deriveDisposition({ criteria, deterministicResults }) {
  const failedChecks = (deterministicResults ?? []).filter((r) => !r.passed);
  if (failedChecks.length) {
    return {
      disposition: "request_changes",
      reason: `${failedChecks.length} deterministic check(s) failed (${failedChecks.map((r) => r.criterionId).join(", ")}); ` +
        `a failed deterministic check is BLOCKED however sound the implementation appears.`,
      failedChecks: failedChecks.map((r) => r.criterionId),
    };
  }
  const overall = deriveOverallVerdict(criteria);
  if (overall !== "PASS") {
    const bad = (criteria ?? []).filter((c) => c.verdict !== "PASS");
    return {
      disposition: "request_changes",
      reason: `overall verdict ${overall}: ${bad.map((c) => `${c.criterionId}=${c.verdict}`).join(", ")}`,
      failedChecks: [],
    };
  }
  return { disposition: "approve", reason: "every criterion PASS and every deterministic check green", failedChecks: [] };
}

/**
 * What the exhaustion of the review budget means.
 *
 * The plan is explicit that exhaustion must reach the responsible human rather
 * than loop or produce the blocked-and-reassign-to-Engineer state. So the final
 * round cannot send work back: it escalates. Approval is never blocked by
 * exhaustion — a clean pass on the last round is still a pass.
 */
function resolveRound({ round, limits, disposition }) {
  if (!DISPOSITIONS.includes(disposition)) {
    throw new FactoryError(`unknown disposition ${JSON.stringify(disposition)}; only ${DISPOSITIONS.join(" and ")} exist`,
      { disposition });
  }
  const max = limits?.maxReviewRounds ?? 2;
  if (disposition === "approve") {
    return { action: "approve", escalate: false, assignToEngineer: false, round, maxReviewRounds: max };
  }
  if (round >= max) {
    return {
      action: "escalate", escalate: true, assignToEngineer: false, round, maxReviewRounds: max,
      reason: `review round ${round} of ${max} exhausted the budget; escalating to the operator rather than ` +
        `returning the work again. Looping here is how a run burns its ceiling without a decision.`,
    };
  }
  return { action: "request_changes", escalate: false, assignToEngineer: true, round, maxReviewRounds: max };
}


/**
 * Submit the review: write the assessment, then move the stage.
 *
 * ORDER IS LOAD-BEARING. The assessment document is written and verified FIRST,
 * and only then does the stage advance. A stage that moved without its evidence
 * in place is a decision nobody can audit — and since the write goes through
 * api.mutate, an assessment the server accepted but did not persist stops the
 * whole submission instead of quietly becoming an approval.
 *
 * THERE IS NO SEPARATE DECISION ENDPOINT. Paperclip records a native execution
 * stage decision from the issue PATCH itself: `done` approves, anything else
 * (here `in_progress`) requests changes, and BOTH require a non-empty comment in
 * the same request (issue-execution-policy.js:607 and :664 — prior comments are
 * explicitly not considered).
 */
async function submitReview({
  env, api, objective, reviewerModel, engineerModel, verifierPath, exec,
  criteria, summary, changeSet, executionReceipt, goalGate,
  round = 1, limits = null, assessmentKey = "assessment",
  now = () => new Date().toISOString(),
}) {
  // ---- everything that can refuse, refuses BEFORE the first write ----------
  const ctx = deriveReviewContext(env);
  const identity = assertModelIndependence({ engineerModel, reviewerModel });
  if (typeof summary !== "string" || !summary.trim()) {
    throw new FactoryError(
      "a review must carry a summary: it becomes the stage decision comment, and Paperclip rejects " +
      "a stage decision with no comment (422). Prior comments are not considered.",
    );
  }
  assertCriteriaCoverage(objective, criteria);

  // AN ASSESSMENT MUST BIND TO WHAT IT JUDGED. AssessmentV1 requires both
  // hashes as strings rather than allowing null, and that is the right shape: an
  // assessment that floats free of a specific receipt and a specific diff cannot
  // be checked against anything later, so "this was reviewed" degrades into an
  // unverifiable claim. The change set is derived by the REVIEWER from the
  // worktree it can see, never taken from the producer's account of its own work.
  if (!executionReceipt) {
    throw new FactoryError(
      "a review must receive and validate the ExecutionReceiptV1 it audited; " +
      "an assessment with no receipt binding cannot be checked against anything later",
    );
  }
  validateContract("ExecutionReceiptV1", executionReceipt);
  if (!changeSet || typeof changeSet.diffHash !== "string" || !Array.isArray(changeSet.changedPaths)) {
    throw new FactoryError(
      "a review must bind to the exact change it judged (changeSet.diffHash and changedPaths), " +
      "independently derived from the worktree rather than taken from the producer's claim",
      { changeSet: changeSet ?? null },
    );
  }
  const expectedObjective = {
    objectiveId: objective.objectiveId, revision: objective.revision,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  };
  if (!deepEqual(executionReceipt.objective, expectedObjective)
      || executionReceipt.execution.workspace !== ctx.worktree
      || executionReceipt.execution.branch !== ctx.branch
      || executionReceipt.execution.baseCommit !== changeSet.baseCommit
      || executionReceipt.execution.headCommit !== changeSet.headCommit
      || executionReceipt.changes.diffHash !== changeSet.diffHash
      || !deepEqual(executionReceipt.changes.paths, changeSet.paths)) {
    throw new FactoryError("ExecutionReceiptV1 does not match the current objective, run workspace, or live change set");
  }
  if (executionReceipt.changes.committed || executionReceipt.terminal.status !== "ready_for_review") {
    throw new FactoryError("ExecutionReceiptV1 is not an uncommitted ready-for-review handoff");
  }
  // GOAL-GATE REFUSAL. A ready-for-review receipt must carry the goal-gate
  // record the Engineer's own runtime wrote, re-verified here against the
  // run and objective the receipt itself binds — the same invariants the
  // receipt's composition already asserted, so this is the Reviewer-side
  // defense rather than a new rule. The gate cannot upgrade anything: it is
  // only ever a further reason to refuse, and it refuses BEFORE the first
  // write like everything above it.
  assertGoalGate({
    gate: goalGate,
    run: { id: executionReceipt.execution.runId, sessionIdAfter: executionReceipt.execution.sessionId },
    issueId: ctx.issueId,
    objective,
  });
  const executionReceiptHash = hashValue(executionReceipt);

  const deterministicResults = runAcceptanceChecks({
    objective, worktree: ctx.worktree, verifierPath, exec,
  });

  const decision = deriveDisposition({ criteria, deterministicResults });
  const overallVerdict = deriveOverallVerdict(criteria);
  const round_ = resolveRound({ round, limits: limits ?? objective?.limits, disposition: decision.disposition });

  const assessment = {
    schemaVersion: "AssessmentV1",
    assessmentId: `assessment-${ctx.runId}`,
    objective: {
      objectiveId: objective.objectiveId, revision: objective.revision,
      objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
    },
    executionRunId: executionReceipt.execution.runId,
    executionReceiptHash,
    reviewer: { agentName: "OMP Reviewer", modelFamily: identity.reviewerVendor },
    repository: {
      baseCommit: changeSet.baseCommit,
      headCommit: changeSet.headCommit ?? changeSet.baseCommit,
      diffHash: changeSet.diffHash,
      changedPaths: changeSet.changedPaths,
    },
    deterministicResults: deterministicResults.map((r) => ({
      criterionId: r.criterionId, argv: r.argv, exitCode: r.exitCode,
      passed: r.passed, outputHash: r.outputHash,
    })),
    criteria,
    overallVerdict,
    assessedAt: now(),
  };

  // ---- write 1: the assessment document, for THIS issue only --------------
  const docPath = `/api/issues/${encodeURIComponent(ctx.issueId)}/documents/${encodeURIComponent(assessmentKey)}`;
  const live = await api.getOptional(docPath);
  const body = JSON.stringify(assessment, null, 2);
  const put = {
    title: `${objective.objectiveId} review assessment (AssessmentV1)`,
    format: "markdown",
    body,
    changeSummary: `Review round ${round_.round}: ${decision.disposition}`,
  };
  // documents.js:291 rejects an update with no baseRevisionId outright.
  if (live?.latestRevisionId) put.baseRevisionId = live.latestRevisionId;

  await api.mutate({
    readPath: docPath, writePath: docPath, method: "PUT", body: put,
    allow: ["title", "format", "body", "changeSummary", "baseRevisionId"],
    expect: [{ path: "body", value: body }],
    allowMissingBefore: live === null,
  });

  // ---- write 2: the stage decision ----------------------------------------
  const status = round_.action === "approve" ? "done" : "in_progress";
  const comment = round_.action === "approve"
    ? `Approved. ${summary.trim()}`
    : round_.escalate
      ? `Escalating to the operator. ${round_.reason} ${decision.reason} ${summary.trim()}`
      : `Changes requested. ${decision.reason} ${summary.trim()}`;

  const statusPath = `/api/issues/${encodeURIComponent(ctx.issueId)}`;
  await api.mutate({
    readPath: statusPath, writePath: statusPath, method: "PATCH",
    body: { status, comment }, allow: ["status", "comment"],
    expect: [{
      path: "status",
      compare: (_actual, after) => round_.action === "approve"
        ? after?.status === "in_review" && after?.executionState?.currentStageType === "approval"
        : round_.escalate
          ? after?.status === "in_review" && after?.executionState?.currentStageType === "review"
            && after?.executionState?.currentParticipant?.type === "user"
          : after?.status === "in_progress" && after?.executionState?.status === "changes_requested",
    }],
  });

  return {
    issueId: ctx.issueId, runId: ctx.runId,
    disposition: decision.disposition, overallVerdict,
    escalated: round_.escalate, round: round_.round,
    criteria, deterministicResults, assessment, status, comment,
  };
}

module.exports = {
  DISPOSITIONS, REQUIRED_ENV,
  deriveReviewContext, modelFamily, modelVendor, assertModelIndependence,
  runAcceptanceChecks, assertCriteriaCoverage, deriveOverallVerdict,
  deriveDisposition, resolveRound, submitReview,
};
