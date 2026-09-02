"use strict";
// A truncated run summary must not strand the work.
//
// The adapter sets the run summary to OMP's final assistant message; Paperclip
// then caps the whole resultJson. On ZEI-1 run 736924f7 that produced:
//
//   truncated: true, truncationReason: "oversized_result_json",
//   originalSizeBytes: 868980, summary -> its first 500 characters
//
// The receipt frame is emitted at the END of the final message, so it was
// exactly what got cut. Reading only the summary threw "must contain exactly one
// frame", which broke the Reviewer's disposition tool, which left the review
// stage undecided, which made the server redispatch the Reviewer — a paid loop
// that could never terminate. These tests pin the recovery, and pin that it does
// not paper over a genuinely missing frame.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECEIPT_BEGIN, RECEIPT_END, finalAssistantTextFromRunLog, resolveReceiptText,
} = require("../../lib/execution-receipt");
const { FactoryError } = require("../../lib/util");

const frame = (obj) => `${RECEIPT_BEGIN}\n${JSON.stringify(obj)}\n${RECEIPT_END}`;

/** Build an ndjson run log the way Paperclip stores one: raw stdout chunks. */
function runLog(assistantTexts, { splitAcrossChunks = false } = {}) {
  const lines = [];
  let seq = 0;
  const emit = (chunk) => lines.push(JSON.stringify({ ts: "2026-09-01T21:06:58.393Z", stream: "stdout", chunk, seq: ++seq }));
  emit("[paperclip] Skipping saved session resume for task \"x\".\n");
  for (const text of assistantTexts) {
    const line = JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    if (splitAcrossChunks) {
      const mid = Math.floor(line.length / 2);
      emit(line.slice(0, mid));
      emit(line.slice(mid));
    } else emit(line);
  }
  emit(JSON.stringify({ message: { role: "user", content: "ignored" } }) + "\n");
  return lines.join("\n") + "\n";
}

function fakeApi(log, { pageBytes = 1 << 20 } = {}) {
  const calls = [];
  return {
    calls,
    get: async (p) => {
      calls.push(p);
      const m = p.match(/offset=(\d+)/);
      const offset = m ? Number(m[1]) : 0;
      const content = log.slice(offset, offset + pageBytes);
      return { runId: "run-1", store: "local_file", content, nextOffset: offset + content.length };
    },
  };
}

const CLAIMS = { schemaVersion: "ExecutionReceiptClaimsV1", terminal: { disposition: "in_review" } };

test("the final assistant message is recovered from reassembled stdout chunks", () => {
  const text = "Work complete.\n\n" + frame(CLAIMS);
  const got = finalAssistantTextFromRunLog(runLog(["an earlier turn", text]));
  assert.ok(got.includes(RECEIPT_BEGIN) && got.includes(RECEIPT_END));
  assert.equal(got, text);
});

test("a message split across stdout chunks is still reassembled", () => {
  const text = "Work complete.\n\n" + frame(CLAIMS);
  assert.equal(finalAssistantTextFromRunLog(runLog([text], { splitAcrossChunks: true })), text);
});

test("ONLY the last assistant message is returned, so replayed context is not mistaken for this run's frame", () => {
  // A resumed session replays earlier turns; run 736924f7's log carried 4 BEGIN
  // and 5 END markers. Scanning the whole log would look like several frames and
  // be rejected as ambiguous. The frame that counts is the one this run ended on.
  const older = "prior turn\n" + frame({ schemaVersion: "ExecutionReceiptClaimsV1", terminal: { disposition: "blocked" } });
  const newest = "this run\n" + frame(CLAIMS);
  const got = finalAssistantTextFromRunLog(runLog([older, "a middle turn with no frame", newest]));
  assert.equal(got, newest);
  assert.equal(got.split(RECEIPT_BEGIN).length - 1, 1, "exactly one frame must survive");
  assert.ok(!got.includes("blocked"), "the replayed older frame must not leak through");
});

test("a log with no assistant text yields null rather than throwing", () => {
  assert.equal(finalAssistantTextFromRunLog('{"ts":"t","stream":"stdout","chunk":"noise\\n","seq":1}\n'), null);
});

test("malformed ndjson lines and non-stdout streams are skipped", () => {
  const text = "done\n" + frame(CLAIMS);
  const log = [
    "{not json at all",
    JSON.stringify({ stream: "stderr", chunk: JSON.stringify({ message: { role: "assistant", content: "STDERR NOISE" } }) + "\n", seq: 1 }),
    JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n", seq: 2 }),
  ].join("\n");
  const got = finalAssistantTextFromRunLog(log);
  assert.equal(got, text);
  assert.ok(!String(got).includes("STDERR NOISE"), "stderr must not be treated as model output");
});

// ---------------------------------------------------------------- resolution

test("an intact summary is used directly and the log is never fetched", async () => {
  const api = fakeApi("");
  const summary = "ok\n" + frame(CLAIMS);
  const out = await resolveReceiptText({ api, run: { id: "run-1", resultJson: { summary } } });
  assert.equal(out.source, "resultJson.summary");
  assert.equal(out.text, summary);
  assert.deepEqual(api.calls, [], "the fast path must not pay for a log fetch");
});

test("a TRUNCATED summary falls back to the run log and recovers the frame", async () => {
  // Mirror the real shape: a long narrative message with the frame at the END,
  // so a 500-character cut keeps the prose and destroys the frame.
  const full = "Work complete.\n\n" + "narrative. ".repeat(80) + "\n\n" + frame(CLAIMS);
  assert.ok(full.length > 500 && !full.slice(0, 500).includes(RECEIPT_BEGIN),
    "fixture must actually lose the frame to truncation");
  const api = fakeApi(runLog([full]));
  const out = await resolveReceiptText({
    api,
    run: { id: "run-1", resultJson: { summary: full.slice(0, 500), truncated: true, truncationReason: "oversized_result_json" } },
  });
  assert.equal(out.source, "runLog.finalAssistantMessage");
  assert.equal(out.text, full);
  assert.ok(api.calls.length >= 1 && api.calls[0].includes("/log?offset=0"));
});

test("the log is paged until exhausted", async () => {
  const full = "Work complete. " + "x".repeat(5000) + "\n" + frame(CLAIMS);
  const api = fakeApi(runLog([full]), { pageBytes: 512 });
  const out = await resolveReceiptText({ api, run: { id: "run-1", resultJson: { summary: "cut", truncated: true } } });
  assert.equal(out.text, full);
  assert.ok(api.calls.length > 5, `expected paging, got ${api.calls.length} request(s)`);
});

test("a frame missing from BOTH the summary and the log is a hard, diagnosable error", async () => {
  const api = fakeApi(runLog(["I finished but wrote no frame."]));
  await assert.rejects(
    () => resolveReceiptText({ api, run: { id: "run-1", resultJson: { summary: "no frame", truncated: true, truncationReason: "oversized_result_json" } } }),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /no complete execution receipt frame/i);
      assert.equal(err.details.summaryTruncated, true);
      assert.equal(err.details.truncationReason, "oversized_result_json");
      return true;
    },
  );
});

test("a HALF a frame in the summary is not accepted as intact", async () => {
  // The truncation cut mid-frame on the real run, leaving BEGIN without END.
  const api = fakeApi(runLog(["done\n" + frame(CLAIMS)]));
  const out = await resolveReceiptText({
    api, run: { id: "run-1", resultJson: { summary: `${RECEIPT_BEGIN}\n{"schemaVersion":"Exec`, truncated: true } },
  });
  assert.equal(out.source, "runLog.finalAssistantMessage", "a dangling BEGIN must not short-circuit the fallback");
});

// ---------------------------------------------------------------- objective binding

const { assertObjectiveBinding, objectiveStableAcrossRun } = require("../../lib/execution-receipt");

const OBJ = {
  objectiveId: "ZEI-1", revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64), criteriaHash: "sha256:" + "b".repeat(64),
};
const RUN = { startedAt: "2026-09-01T21:06:54.000Z" };
const STABLE_SPEC = { updatedAt: "2026-09-01T20:54:45.278Z" };   // installed before the run
const MOVED_SPEC  = { updatedAt: "2026-09-01T21:10:00.000Z" };   // edited mid-run

test("a complete, correct agent echo binds from the receipt claims", () => {
  const out = assertObjectiveBinding({ claims: { objective: { ...OBJ } }, objective: OBJ, run: RUN, specDocument: STABLE_SPEC });
  assert.equal(out.bindingSource, "receiptClaims");
});

test("a MISSING binding is settled by the control plane when the objective never moved", () => {
  // Exactly the ZEI-1 case: nulls and the issue UUID, one spec revision created
  // 12 minutes before the run. No other revision existed, so the binding is a fact.
  const claims = { objective: { objectiveId: null, revision: null, objectiveHash: null, criteriaHash: null } };
  const out = assertObjectiveBinding({ claims, objective: OBJ, run: RUN, specDocument: STABLE_SPEC });
  assert.equal(out.bindingSource, "controlPlane");
});

test("an absent objective block is likewise settled when the objective never moved", () => {
  const out = assertObjectiveBinding({ claims: {}, objective: OBJ, run: RUN, specDocument: STABLE_SPEC });
  assert.equal(out.bindingSource, "controlPlane");
});

test("a WRONG stated value is still rejected, stable document or not", () => {
  const claims = { objective: { ...OBJ, objectiveHash: "sha256:" + "f".repeat(64) } };
  assert.throws(
    () => assertObjectiveBinding({ claims, objective: OBJ, run: RUN, specDocument: STABLE_SPEC }),
    (err) => {
      assert.match(err.message, /contradicts the live spec/);
      assert.deepEqual(err.details.mismatched, ["objectiveHash"]);
      return true;
    },
    "a stable document must never excuse a value the agent got wrong",
  );
});

test("a wrong revision is rejected even when every other field is right", () => {
  assert.throws(
    () => assertObjectiveBinding({ claims: { objective: { ...OBJ, revision: 2 } }, objective: OBJ, run: RUN, specDocument: STABLE_SPEC }),
    /contradicts the live spec/,
  );
});

test("a missing binding is REFUSED when the objective document moved during the run", () => {
  // Here only the agent can say which text it read, so its echo becomes mandatory.
  const claims = { objective: { objectiveId: null, revision: null, objectiveHash: null, criteriaHash: null } };
  assert.throws(
    () => assertObjectiveBinding({ claims, objective: OBJ, run: RUN, specDocument: MOVED_SPEC }),
    (err) => {
      assert.match(err.message, /objective document changed during the run/);
      assert.equal(err.details.specUpdatedAt, MOVED_SPEC.updatedAt);
      return true;
    },
  );
});

test("a complete correct echo still binds even when the document moved", () => {
  const out = assertObjectiveBinding({ claims: { objective: { ...OBJ } }, objective: OBJ, run: RUN, specDocument: MOVED_SPEC });
  assert.equal(out.bindingSource, "receiptClaims");
});

test("stability is refused when either timestamp is missing or unparseable", () => {
  assert.equal(objectiveStableAcrossRun({ specDocument: null, run: RUN }), false);
  assert.equal(objectiveStableAcrossRun({ specDocument: STABLE_SPEC, run: {} }), false);
  assert.equal(objectiveStableAcrossRun({ specDocument: { updatedAt: "not a date" }, run: RUN }), false);
});

test("a document updated exactly at run start still counts as stable", () => {
  assert.equal(objectiveStableAcrossRun({ specDocument: { updatedAt: RUN.startedAt }, run: RUN }), true);
});

const ISSUE = { id: "cc4fc719-ef7c-4e7a-bc3f-2124e021ef8d", identifier: "ZEI-1" };

test("the issue UUID is accepted as objectiveId ONLY when it resolves to the same issue", () => {
  const claims = { objective: { ...OBJ, objectiveId: ISSUE.id } };
  const out = assertObjectiveBinding({ claims, objective: OBJ, run: RUN, specDocument: STABLE_SPEC, issue: ISSUE });
  assert.equal(out.bindingSource, "receiptClaims");
});

test("without the live issue to check against, no alias is accepted", () => {
  const claims = { objective: { ...OBJ, objectiveId: ISSUE.id } };
  assert.throws(
    () => assertObjectiveBinding({ claims, objective: OBJ, run: RUN, specDocument: STABLE_SPEC, issue: null }),
    /contradicts the live spec/,
    "an alias must be verified, never assumed",
  );
});

test("a UUID belonging to a DIFFERENT issue is rejected", () => {
  const claims = { objective: { ...OBJ, objectiveId: "11111111-2222-3333-4444-555555555555" } };
  assert.throws(
    () => assertObjectiveBinding({ claims, objective: OBJ, run: RUN, specDocument: STABLE_SPEC, issue: ISSUE }),
    /contradicts the live spec/,
  );
});

test("an alias is rejected when the objective names a different identifier than the issue", () => {
  const claims = { objective: { ...OBJ, objectiveId: ISSUE.id } };
  assert.throws(
    () => assertObjectiveBinding({
      claims, objective: { ...OBJ, objectiveId: "ZEI-9" }, run: RUN,
      specDocument: STABLE_SPEC, issue: ISSUE,
    }),
    /contradicts the live spec/,
  );
});
