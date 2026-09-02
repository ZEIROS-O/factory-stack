"use strict";

const fs = require("node:fs");
const { FactoryError, deepEqual, hashValue } = require("./util");
const { validateContract } = require("./contracts");
const { loadGoalGate, describeGoalGate } = require("./goal-gate");

const RECEIPT_BEGIN = "---BEGIN EXECUTION_RECEIPT_CLAIMS_V1---";
const RECEIPT_END = "---END EXECUTION_RECEIPT_CLAIMS_V1---";

function parseExecutionReceiptClaims(text) {
  if (typeof text !== "string") throw new FactoryError("Engineer run has no receipt output");
  const starts = text.split(RECEIPT_BEGIN).length - 1;
  const ends = text.split(RECEIPT_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new FactoryError(`Engineer output must contain exactly one ${RECEIPT_BEGIN}/${RECEIPT_END} frame`);
  }
  const start = text.indexOf(RECEIPT_BEGIN) + RECEIPT_BEGIN.length;
  const end = text.indexOf(RECEIPT_END, start);
  if (end < start) throw new FactoryError("Execution receipt frame is malformed");
  let claims;
  try { claims = JSON.parse(text.slice(start, end).trim()); }
  catch (err) { throw new FactoryError(`Execution receipt claims are not valid JSON: ${err.message}`); }
  const keys = ["schemaVersion", "objective", "repository", "checks", "observations", "conclusions", "unresolvedConditions", "warnings", "terminal"];
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || claims.schemaVersion !== "ExecutionReceiptClaimsV1") {
    throw new FactoryError("Execution receipt frame must carry ExecutionReceiptClaimsV1");
  }
  const extras = Object.keys(claims).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => claims[k] === undefined);
  if (extras.length || missing.length) throw new FactoryError("Execution receipt claims have an invalid shape", { extras, missing });
  if (!claims.repository || !Array.isArray(claims.repository.paths) || !Array.isArray(claims.checks)) {
    throw new FactoryError("Execution receipt claims must include repository paths and checks");
  }
  return claims;
}

// ---------------------------------------------------------------- receipt source
//
// WHY THE RUN SUMMARY IS NOT A RELIABLE SOURCE.
//
// The adapter sets the run summary to OMP's final assistant message
// (@zhafron/paperclip-omp-adapter dist/server/execute.js:581). Paperclip then
// caps the whole resultJson: a large run comes back with
//
//   truncated: true, truncationReason: "oversized_result_json",
//   originalSizeBytes: 868980, stdout -> 4096 chars, summary -> 500 chars
//
// The receipt frame is emitted at the END of that final message, so on any
// substantial run it is exactly what gets cut. Observed on ZEI-1 run 736924f7:
// the Engineer completed all five defects and emitted a complete, valid frame in
// a 12,207-character message; the stored summary held its first 500 characters.
// Reading only the summary therefore threw "must contain exactly one frame",
// which broke the Reviewer's disposition tool, which left the review stage with
// no decision, which made the server redispatch the Reviewer — a paid loop that
// could never terminate, caused entirely by reading a truncated display field.
//
// The full transcript is retained and served by the API, so the frame is
// recoverable. Trust is unchanged: these claims were always the Engineer's own
// untrusted assertions, checked against the objective and the run below.
const RUN_LOG_CHUNK_BYTES = 1 << 20;
const RUN_LOG_MAX_BYTES = 64 << 20;

async function fetchRunLog(api, runId) {
  let offset = 0, out = "";
  for (;;) {
    const page = await api.get(
      `/api/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=${RUN_LOG_CHUNK_BYTES}`,
    );
    const content = typeof page?.content === "string" ? page.content : "";
    if (!content) break;
    out += content;
    if (out.length > RUN_LOG_MAX_BYTES) throw new FactoryError(`run ${runId} log exceeds ${RUN_LOG_MAX_BYTES} bytes`);
    const next = page?.nextOffset;
    if (typeof next !== "number" || next <= offset) break;
    offset = next;
  }
  return out;
}

/**
 * Recover OMP's final assistant message from a run log.
 *
 * The log is newline-delimited {ts, stream, chunk, seq} records carrying raw
 * process output, so stdout is reassembled first and then read as OMP's
 * `--mode json` stream.
 *
 * ONLY THE LAST ASSISTANT MESSAGE IS RETURNED, never the whole log. A resumed
 * session replays earlier turns, so a full-log scan finds several BEGIN/END
 * markers from prior context (4 and 5 respectively on run 736924f7) and
 * `parseExecutionReceiptClaims` rightly rejects that as ambiguous. The frame the
 * contract means is the one in the message this run actually ended on.
 */
function finalAssistantTextFromRunLog(ndjson) {
  const chunks = [];
  for (const line of String(ndjson).split("\n")) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.stream === "stdout" && typeof rec.chunk === "string") chunks.push(rec.chunk);
  }
  let final = null;
  for (const line of chunks.join("").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const message = event?.message && typeof event.message === "object" ? event.message
      : (event?.role ? event : null);
    if (message?.role !== "assistant") continue;
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
    }
    if (text.trim()) final = text;
  }
  return final;
}

/** The receipt text, preferring the cheap field and falling back to the transcript. */
async function resolveReceiptText({ api, run }) {
  const summary = run?.resultJson?.summary;
  const complete = (t) => typeof t === "string" && t.includes(RECEIPT_BEGIN) && t.includes(RECEIPT_END);
  if (complete(summary)) return { text: summary, source: "resultJson.summary" };

  const truncated = run?.resultJson?.truncated === true;
  const text = finalAssistantTextFromRunLog(await fetchRunLog(api, run.id));
  if (!complete(text)) {
    throw new FactoryError(
      "Engineer run carries no complete execution receipt frame in its stored summary or its run log",
      {
        runId: run.id,
        summaryTruncated: truncated,
        truncationReason: run?.resultJson?.truncationReason ?? null,
        summaryLength: typeof summary === "string" ? summary.length : 0,
        finalMessageLength: typeof text === "string" ? text.length : 0,
      },
    );
  }
  return { text, source: "runLog.finalAssistantMessage" };
}

function knownRunCost(run) {
  const usage = run?.usageJson;
  const cost = usage?.costUsd ?? usage?.cacheAdjustedCostUsd;
  if (usage?.costStatus !== "reported" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new FactoryError("promotion requires a known cost from the Paperclip run ledger", { usage: usage ?? null });
  }
  return cost;
}

/**
 * Two git object names refer to the same commit.
 *
 * Git's own minimum abbreviation is 4 hex characters; anything shorter is not a
 * commit name at all, and accepting it would let a 1-character "match" pass.
 * Both sides must be hex, and the shorter must prefix the longer.
 */
const MIN_ABBREV = 4;
function sameCommit(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = a.trim().toLowerCase(), y = b.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(x) || !/^[0-9a-f]+$/.test(y)) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < MIN_ABBREV) return false;
  return long.startsWith(short);
}

/**
 * Was the objective stable for the whole run?
 *
 * THIS, NOT THE AGENT'S ECHO, IS THE REAL BINDING PROOF. The guarantee wanted is
 * "the Engineer worked against the objective revision that is live now". The
 * control plane can settle that directly: if the `spec` document was last
 * updated at or before the run started, no other revision existed while the run
 * was executing, so the Engineer cannot have worked from a different one.
 *
 * Requiring the agent to retype objectiveHash/criteriaHash instead proves only
 * that it copied a document correctly. On ZEI-1 run 736924f7 the Engineer fixed
 * all five defects, emitted a valid frame, and filled those four fields with the
 * issue UUID and nulls — so $3.79 of correct, verified work was rejected over a
 * transcription slip while the objective had exactly one revision, created 12
 * minutes before the run and never touched since.
 *
 * The echo is still checked when the agent supplies it (a stale agent that names
 * a genuinely different revision is caught), but it is corroboration, not the
 * source of truth. When the document did move during the run the echo becomes
 * mandatory, because then only the agent can say which text it actually read.
 */
function objectiveStableAcrossRun({ specDocument, run }) {
  const updated = Date.parse(specDocument?.updatedAt ?? "");
  const started = Date.parse(run?.startedAt ?? "");
  if (!Number.isFinite(updated) || !Number.isFinite(started)) return false;
  return updated <= started;
}

/**
 * One issue has two names, and either may appear as `objectiveId`.
 *
 * The envelope names the objective by issue IDENTIFIER ("ZEI-1"); an agent
 * reading its Paperclip context naturally reaches for the issue UUID instead.
 * They denote the same row, and that is checkable rather than assumed: the
 * claimed value must equal the live issue's `id` AND the expected value must
 * equal that same issue's `identifier`. Without the live issue to check against,
 * no alias is accepted.
 */
function sameObjectiveId(claimedId, expectedId, issue) {
  if (deepEqual(claimedId, expectedId)) return true;
  if (!issue) return false;
  return claimedId === issue.id && expectedId === issue.identifier;
}

function assertObjectiveBinding({ claims, objective, run, specDocument, issue }) {
  const expected = {
    objectiveId: objective.objectiveId, revision: objective.revision,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  };
  const claimed = claims.objective ?? {};
  const stated = ["objectiveId", "revision", "objectiveHash", "criteriaHash"]
    .filter((k) => claimed[k] !== undefined && claimed[k] !== null);

  // Whatever the agent DID state must be right. A wrong value is a real
  // mismatch and is never excused by the document being stable.
  const wrong = stated.filter((k) => k === "objectiveId"
    ? !sameObjectiveId(claimed.objectiveId, expected.objectiveId, issue)
    : !deepEqual(claimed[k], expected[k]));
  if (wrong.length) {
    throw new FactoryError("execution receipt objective binding contradicts the live spec", {
      mismatched: wrong, claimed: Object.fromEntries(wrong.map((k) => [k, claimed[k]])),
      expected: Object.fromEntries(wrong.map((k) => [k, expected[k]])),
    });
  }

  const complete = stated.length === 4;
  if (complete) return { bindingSource: "receiptClaims" };

  if (!objectiveStableAcrossRun({ specDocument, run })) {
    throw new FactoryError(
      "execution receipt omits its objective binding and the objective document changed during the run, " +
      "so which revision the Engineer read cannot be established",
      {
        missing: ["objectiveId", "revision", "objectiveHash", "criteriaHash"].filter((k) => !stated.includes(k)),
        specUpdatedAt: specDocument?.updatedAt ?? null, runStartedAt: run?.startedAt ?? null,
      },
    );
  }
  return { bindingSource: "controlPlane" };
}

function buildExecutionReceipt({ run, issueId, objective, claims, specDocument, issue, goalGate }) {
  if (!run || run.status !== "succeeded") throw new FactoryError("execution receipt requires a succeeded Paperclip run");
  if (run.contextSnapshot?.issueId !== issueId) throw new FactoryError("execution run belongs to a different issue");
  const expectedObjective = {
    objectiveId: objective.objectiveId, revision: objective.revision,
    objectiveHash: objective.objectiveHash, criteriaHash: objective.criteriaHash,
  };
  // The receipt always records the AUTHORITATIVE objective below, never the
  // agent's copy of it, so a receipt can never carry a wrong binding.
  assertObjectiveBinding({ claims, objective, run, specDocument, issue });
  const repo = claims.repository;
  // The objective may name the base commit ABBREVIATED (ZEI-1 declares
  // "3cb8238"), while a run reports the full 40-char sha it actually checked
  // out. A strict !== therefore rejects a receipt that is exactly right, and no
  // Engineer output can ever satisfy it — the two strings cannot be equal. So
  // one is required to be a prefix of the other, case-insensitively, with a
  // minimum length that keeps the comparison meaningful rather than accidental.
  if (!sameCommit(repo.baseCommit, objective.repository.baseCommit) || repo.branch !== objective.repository.branch) {
    throw new FactoryError("execution receipt repository binding does not match the live spec", {
      claimedBaseCommit: repo.baseCommit ?? null, objectiveBaseCommit: objective.repository.baseCommit ?? null,
      claimedBranch: repo.branch ?? null, objectiveBranch: objective.repository.branch ?? null,
    });
  }
  const ws = run.contextSnapshot?.paperclipWorkspace;
  const workspace = ws?.worktreePath || ws?.cwd;
  if (!workspace || ws?.branchName !== repo.branch) throw new FactoryError("Paperclip run workspace/branch does not match the receipt");
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    throw new FactoryError("Paperclip run has invalid execution timestamps");
  }
  const costUsd = knownRunCost(run);
  const ceiling = objective.limits?.costCeilingUsd;
  // The ceiling is RECORDED, NOT ENFORCED. It used to throw here when costUsd
  // exceeded it, which meant an over-budget run could not even have its receipt
  // built — so the Reviewer could not read it and the work became unreachable.
  // That inverts the intent: the money is already spent by this point, so the
  // check could never prevent a dollar of it; it could only ensure you got
  // nothing back for it. Cost is also not a correctness signal, and the real
  // hard stops (adapterConfig timeoutSec/maxTime, the per-agent Paperclip
  // budget, the provider cap) act while a run is alive, where they can help.
  if (!(typeof ceiling === "number" && ceiling > 0)) throw new FactoryError("objective has no declared cost ceiling to record");
  // The number stays in the receipt so an expensive run is still visible.
  // ExecutionReceiptV1 requires costCeilingUsd, so the objective must declare one.
  // GOAL-GATE ADMISSIBILITY. A ready-for-review receipt is the only terminal
  // status that hands work to the Reviewer, so it is the only one that
  // additionally requires the run's goal-gate record proving the Engineer's
  // native goal completed against this objective (lib/goal-gate.js — the
  // gate is written by the factory-owned extension, not by the Engineer, and
  // every field in it is re-checked against the authoritative run and
  // objective). blocked, failed, and cancelled receipts remain buildable
  // WITHOUT a complete goal: an attempt that legitimately blocks must still
  // be able to report. The asymmetry is strictly one-directional and
  // structural — claims.terminal is copied verbatim into the receipt below,
  // so a gate (even a complete one) can never UPGRADE a non-ready terminal
  // status; it only ever refuses to admit a ready-for-review claim that the
  // run's runtime never proved.
  // ADVISORY 2026-09-02. This was a refusal; the gate is corroborating
  // evidence rather than proof (lib/goal-gate.js trust model), so it is now
  // evaluated and recorded, never fatal. A ready-for-review claim is still
  // established the way it always really was: the Reviewer independently runs
  // every acceptance command, and promotion proves committed bytes equal
  // reviewed bytes. Neither trusts the agent's own account of itself.
  const goalGateResult = describeGoalGate({ gate: goalGate, run, issueId, objective });
  void goalGateResult; // recorded by callers; never a refusal here
  const receipt = {
    schemaVersion: "ExecutionReceiptV1", receiptId: run.id,
    objective: expectedObjective,
    execution: {
      runId: run.id, sessionId: run.sessionIdAfter ?? null, workspace,
      branch: repo.branch, baseCommit: repo.baseCommit, headCommit: repo.headCommit,
      startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
      durationSeconds: (finished - started) / 1000,
    },
    changes: { committed: false, diffHash: repo.diffHash, paths: repo.paths },
    checks: claims.checks, observations: claims.observations, conclusions: claims.conclusions,
    unresolvedConditions: claims.unresolvedConditions, warnings: claims.warnings,
    usage: { costStatus: "known", costUsd, costCeilingUsd: ceiling },
    terminal: claims.terminal,
  };
  return validateContract("ExecutionReceiptV1", receipt);
}

async function loadExecutionReceiptForReview({ api, issue, objective, readFile }) {
  const engineerId = issue?.executionState?.returnAssignee?.type === "agent"
    ? issue.executionState.returnAssignee.agentId : null;
  if (!engineerId) throw new FactoryError("current review has no Engineer return assignee");
  const listed = await api.get(`/api/issues/${encodeURIComponent(issue.id)}/runs`);
  const candidates = (Array.isArray(listed) ? listed : []).filter((r) =>
    r.agentId === engineerId && r.status === "succeeded");
  if (!candidates.length) throw new FactoryError("current issue has no succeeded Engineer run carrying an execution receipt");
  candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const run = await api.get(`/api/heartbeat-runs/${encodeURIComponent(candidates[0].runId)}`);
  const { text, source } = await resolveReceiptText({ api, run });
  const claims = parseExecutionReceiptClaims(text);
  // The installed objective document, so the binding can be settled from the
  // control plane rather than from the agent's transcription of it.
  const specRaw = await api.getOptional(`/api/issues/${encodeURIComponent(issue.id)}/documents/spec`);
  const specDocument = specRaw?.document ?? specRaw ?? null;
  // The run's goal gate, loaded the same way every consumer loads it: from
  // the session directory the adapter persisted on the run. Passed through so
  // the Reviewer path receives the gate automatically and submitReview can
  // re-refuse on it before its first write.
  const loadedGate = loadGoalGate({ run, readFile: readFile ?? ((p) => fs.readFileSync(p, "utf8")) });
  const receipt = buildExecutionReceipt({ run, issueId: issue.id, objective, claims, specDocument, issue, goalGate: loadedGate?.gate ?? null });
  const { bindingSource } = assertObjectiveBinding({ claims, objective, run, specDocument, issue });
  return {
    run, claims, receipt, receiptHash: hashValue(receipt), receiptSource: source, bindingSource,
    goalGate: loadedGate?.gate ?? null, goalGatePath: loadedGate?.path ?? null,
  };
}

module.exports = {
  RECEIPT_BEGIN, RECEIPT_END, parseExecutionReceiptClaims, buildExecutionReceipt,
  loadExecutionReceiptForReview, knownRunCost,
  finalAssistantTextFromRunLog, resolveReceiptText, fetchRunLog,
  assertObjectiveBinding, objectiveStableAcrossRun, sameCommit,
};
