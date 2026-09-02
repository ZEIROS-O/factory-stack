"use strict";
// Transport failures and reasoning failures are not the same event.
//
// WHAT THE DISCRIMINATING TEST ESTABLISHED (2026-09-02, from 16 recorded ZEI-2
// runs plus the shipped server source; no dispatch, no spend).
//
// The "3x3 burst" that produced nine `adapter_failed` runs in eleven minutes is
// not one mechanism. Each burst of three is a dispatch, an immediate retry of
// it (`retryOfRunId` set, `invocationSource: automation`), and an assignment
// pickup (`invocationSource: assignment`, no `retryOfRunId`).
// `scheduledRetryAttempt` is 0 on all nine, which is why Paperclip's scheduled
// retry counter looked innocent — it was not involved. The three bursts are
// continuation recovery: @paperclipai/server holds "adapter_failed" in
// TRANSIENT_INFRA_CONTINUATION_ERROR_CODES with
// CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3.
//
// THE TAXONOMY THEREFORE ALREADY EXISTS, and it is bounded on both sides: the
// transport side at 3 attempts, the reasoning side at
// DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1. The plan's premise that one
// was missing is, on this evidence, wrong.
//
// WHAT IS ACTUALLY MISSING is on this side of the wire:
//
//   1. Nothing here reads it. Nine identical launches presented as an
//      unexplained storm rather than as one condition with a known bound.
//   2. The taxonomy is a vendored constant this repo depends on and never
//      asserts, so a Paperclip upgrade could re-scope the blast radius in
//      silence. test/unit/failure-class.test.js binds this mirror to the
//      shipped files and fails if they diverge.
//   3. Nothing refuses the NEXT dispatch. Paperclip's allowance is per
//      recovery episode; re-assigning the issue starts a fresh one. The gate
//      below is the stop: after a full transient allowance of identical
//      failures, the answer is a config fix, not a tenth launch.
//
// AND ONE FACT WORTH KEEPING IN FRONT: the storm cost $0 only because it died
// before reaching a provider. That is luck about where the failure landed, not
// a control. The same nine launches past that point would have billed nine
// times.

const gate = (name, ok, detail = "") => ({ name, ok, detail });

/**
 * Codes the server itself retries as transient infrastructure. Mirrored from
 * @paperclipai/server/dist/services/recovery/service.js
 * (TRANSIENT_INFRA_CONTINUATION_ERROR_CODES) and asserted against it.
 */
const TRANSPORT_ERROR_CODES = new Set([
  "adapter_failed",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
  "provider_quota",
  "timeout",
  "process_lost",
]);

/**
 * Codes the server refuses to retry: a decision was made, and repeating the
 * launch cannot change it. Mirrored from NON_RETRYABLE_CONTINUATION_ERROR_CODES.
 */
const CONTROL_ERROR_CODES = new Set([
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
]);

/** A run that ended in one of these left a usable next action. */
const PRODUCTIVE_LIVENESS_STATES = new Set([
  "advanced", "completed", "blocked", "needs_followup",
]);

/**
 * Reconciled cost. `usageJson` is the provider-derived record; a top-level
 * self-reported number is not trusted over it, because one document reports
 * OMP's self-reported cost understating a measured model by 2x and that has
 * never been reconciled against provider billing.
 */
function costOf(run) {
  const usage = run?.usageJson;
  if (usage && typeof usage.costUsd === "number") return usage.costUsd;
  if (typeof run?.costUsd === "number") return run.costUsd;
  return null;
}

/**
 * One run -> one class.
 *
 *   transport   the launch or the transport died. Cheap, and an immediate
 *               identical retry proves nothing.
 *   control     a deliberate refusal — budget, pause, missing agent. Retrying
 *               it is never right.
 *   reasoning   the model ran. Replaying it re-pays for the reasoning, which
 *               is the engine behind both recorded cost incidents.
 *   productive  it ran and left a disposition. Nothing to do.
 *
 * An UNKNOWN failure code classifies as reasoning, deliberately. Guessing
 * "transport" would authorise auto-replay of something that may already have
 * paid a provider; the safe default costs an operator glance, not money.
 */
function classifyRun(run) {
  const costUsd = costOf(run);
  const code = run?.errorCode ?? null;

  if (run?.status === "succeeded") {
    const productive =
      PRODUCTIVE_LIVENESS_STATES.has(run.livenessState) ||
      Boolean(run.nextAction);
    return {
      class: productive ? "productive" : "reasoning",
      code, costUsd,
      retryIsInformative: false,
      autoReplaySafe: false,
      guidance: productive
        ? "the run left a disposition; the control plane can continue"
        : "succeeded with no disposition — a corrective redispatch re-pays for the reasoning. " +
          "Read the run before replaying it.",
    };
  }

  if (code && TRANSPORT_ERROR_CODES.has(code)) {
    return {
      class: "transport", code, costUsd,
      retryIsInformative: false,
      autoReplaySafe: true,
      guidance: "the launch or transport failed; an identical immediate retry cannot succeed. " +
        "Change something before dispatching again.",
    };
  }

  if (code && CONTROL_ERROR_CODES.has(code)) {
    return {
      class: "control", code, costUsd,
      retryIsInformative: false,
      autoReplaySafe: false,
      guidance: "a deliberate refusal by the control plane; resolve the condition, do not retry.",
    };
  }

  return {
    class: "reasoning", code, costUsd,
    retryIsInformative: false,
    autoReplaySafe: false,
    guidance: code
      ? `unrecognised error code "${code}"; treated as reasoning-class so it is never auto-replayed`
      : "failed with no error code; treated as reasoning-class so it is never auto-replayed",
  };
}

/**
 * A run list -> one condition.
 *
 * The count is not the finding. Nine launches with one error code and nothing
 * changed between them is ONE condition observed nine times, and reporting it
 * as nine events is how it read as a storm.
 */
function classifyRunHistory(runs) {
  const ordered = [...(runs ?? [])].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)));
  const classified = ordered.map((run) => ({ run, ...classifyRun(run) }));

  // Streak measured from the END: a success since the failures resolves them.
  let consecutiveTransportFailures = 0;
  for (let i = classified.length - 1; i >= 0; i--) {
    if (classified[i].class !== "transport") break;
    consecutiveTransportFailures++;
  }

  const tail = classified.slice(classified.length - consecutiveTransportFailures);
  const distinctErrorCodes = [...new Set(tail.map((c) => c.code))];
  const costs = classified.map((c) => c.costUsd).filter((n) => typeof n === "number");

  const counts = {};
  for (const c of classified) counts[c.class] = (counts[c.class] ?? 0) + 1;
  const dominantClass = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    runs: classified,
    dominantClass,
    counts,
    consecutiveTransportFailures,
    distinctErrorCodes,
    // One code across the whole streak and nothing between attempts changed.
    identicalFailure: consecutiveTransportFailures > 1 && distinctErrorCodes.length === 1,
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
    // The shape that explains the count: automation retries vs fresh pickups.
    retryChains: tail.filter((c) => c.run.retryOfRunId).length,
    assignmentDispatches: tail.filter((c) => c.run.invocationSource === "assignment").length,
  };
}

/**
 * Paperclip's transient allowance is CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS
 * = 3, per recovery episode. Reassigning the issue starts a fresh episode, which
 * is how one broken config produced three full bursts. Three identical failures
 * is therefore the point at which the server has already spent its own
 * allowance and another launch adds no information.
 */
const TRANSIENT_ALLOWANCE = 3;

/**
 * THE PRE-DISPATCH STOP. Everything the server does about this is bounded and
 * automatic; this is the one place the factory can decline to start the next
 * episode. It raises to the operator rather than re-dispatching — which is the
 * whole difference between a system that improves itself and one that harms
 * itself.
 */
function repeatedTransportFailureGate({ identifier, runs }) {
  const name = `${identifier} is not repeating an unresolved launch failure`;
  if (runs === null || runs === undefined) {
    return gate(name, false, "could not read this issue's run history, so the condition is unknown");
  }
  const h = classifyRunHistory(runs);
  if (h.consecutiveTransportFailures < TRANSIENT_ALLOWANCE || !h.identicalFailure) {
    return gate(name, true, h.consecutiveTransportFailures
      ? `${h.consecutiveTransportFailures} recent transport failure(s), within the transient allowance`
      : "no unresolved launch-failure streak");
  }
  const code = h.distinctErrorCodes[0];
  return gate(name, false,
    `the last ${h.consecutiveTransportFailures} run(s) all ended ${code} and cost ` +
    `$${h.totalCostUsd.toFixed(2)} in total — ${h.retryChains} automatic retry(ies) and ` +
    `${h.assignmentDispatches} assignment pickup(s), nothing changed between them.\n` +
    `Paperclip's own transient allowance is ${TRANSIENT_ALLOWANCE} attempts per recovery ` +
    `episode; reassigning the issue starts a fresh one, which is how one broken config ` +
    `produces bursts indefinitely.\n` +
    `A launch that cannot start will not start on attempt ${h.consecutiveTransportFailures + 1}. ` +
    `Fix the config or the launch path, then dispatch. ` +
    `Note the $0 is where the failure LANDED, not a control: the same launches past the ` +
    `provider boundary would have billed every time.`);
}

module.exports = {
  classifyRun, classifyRunHistory, repeatedTransportFailureGate,
  TRANSPORT_ERROR_CODES, CONTROL_ERROR_CODES, PRODUCTIVE_LIVENESS_STATES,
  TRANSIENT_ALLOWANCE, costOf,
};
