"use strict";
// Transport failures and reasoning failures are not the same event and must
// not get the same response.
//
// WHAT THE DISCRIMINATING TEST FOUND (2026-09-02, from the 16 recorded ZEI-2
// runs plus the shipped server source — no dispatch, no spend).
//
// The "3x3 burst" is not one mechanism. Each burst of three is:
//
//   1. invocationSource=automation, no retryOfRunId      the dispatch
//   2. invocationSource=automation, retryOfRunId=#1      an immediate retry
//   3. invocationSource=assignment, no retryOfRunId      assignment pickup
//
// and `scheduledRetryAttempt` is 0 on all nine, which is why the scheduler's
// own retry counter looked innocent. The three bursts are Paperclip's
// continuation recovery: @paperclipai/server ships
// TRANSIENT_INFRA_CONTINUATION_ERROR_CODES containing "adapter_failed", with
// CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3.
//
// SO THE TAXONOMY ALREADY EXISTS, SERVER-SIDE, AND IT IS BOUNDED ON BOTH
// SIDES: transport failures retry 3 times, and the reasoning side
// (successful-run-handoff) is capped at
// DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1.
//
// What was missing is not a classifier in Paperclip. It is that NOTHING ON
// THIS SIDE READS IT, so nine identical launches looked like an unexplained
// storm; and that the taxonomy is a vendored constant we depend on without
// asserting. This file supplies both: a classifier that mirrors the shipped
// taxonomy, a test that binds that mirror to the installed server so an
// upgrade cannot move our blast radius silently, and the pre-dispatch refusal
// that turns a repeated transport failure into an operator decision instead of
// a tenth launch.
//
// The 2026-09-02 storm cost $0 only because it died before reaching a
// provider. That is luck about where the failure landed, not a control.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyRun, classifyRunHistory, repeatedTransportFailureGate,
  TRANSPORT_ERROR_CODES, CONTROL_ERROR_CODES,
} = require("../../lib/failure-class");

// ---- fixtures: the real ZEI-2 records, trimmed ----------------------------

const transportRun = (over = {}) => ({
  runId: "bec6c723-cbde-4f0a-9e3c-4726fe3f1afe",
  status: "failed", errorCode: "adapter_failed",
  invocationSource: "automation", scheduledRetryAttempt: 0,
  createdAt: "2026-09-02T18:36:11.271Z", finishedAt: "2026-09-02T18:36:19.134Z",
  usageJson: { costUsd: 0 },
  resultJson: { stopReason: "adapter_failed", timeoutFired: false },
  livenessState: "failed",
  ...over,
});

const reasoningRun = (over = {}) => ({
  runId: "r-reasoning", status: "succeeded", errorCode: null,
  invocationSource: "automation", createdAt: "2026-09-02T19:09:27.815Z",
  finishedAt: "2026-09-02T19:20:00.000Z",
  usageJson: { costUsd: 1.32823425 },
  resultJson: { stopReason: "end_turn" },
  livenessState: null, nextAction: null,
  ...over,
});

// ---- classification ------------------------------------------------------

test("adapter_failed is transport class", () => {
  const c = classifyRun(transportRun());
  assert.equal(c.class, "transport");
  assert.equal(c.retryIsInformative, false,
    "an adapter that could not launch cannot launch on an identical immediate retry");
});

test("process_lost and timeout are transport class too", () => {
  assert.equal(classifyRun(transportRun({ errorCode: "process_lost" })).class, "transport");
  assert.equal(classifyRun(transportRun({ errorCode: "timeout" })).class, "transport");
});

test("a budget refusal is control class, not transport — retrying it is never right", () => {
  const c = classifyRun(transportRun({ errorCode: "budget_exhausted" }));
  assert.equal(c.class, "control");
  assert.equal(c.retryIsInformative, false);
});

test("a run that succeeded and left no disposition is reasoning class", () => {
  const c = classifyRun(reasoningRun());
  assert.equal(c.class, "reasoning");
  assert.equal(c.autoReplaySafe, false,
    "replaying a reasoning run re-pays for the reasoning; this is the engine of both cost incidents");
  assert.equal(c.costUsd, 1.32823425);
});

test("a run that succeeded WITH a disposition is productive and needs nothing", () => {
  const c = classifyRun(reasoningRun({ livenessState: "completed", nextAction: "review" }));
  assert.equal(c.class, "productive");
});

test("an unknown error code fails closed as reasoning, the expensive assumption", () => {
  // Guessing "transport" on an unknown code would authorise an auto-replay of
  // something that may have already paid a provider. The safe default is the
  // one that costs an operator glance, not money.
  const c = classifyRun(transportRun({ errorCode: "something_new_in_2027" }));
  assert.equal(c.class, "reasoning");
  assert.equal(c.autoReplaySafe, false);
});

test("cost is read from usageJson, never from a self-report", () => {
  const c = classifyRun(reasoningRun({ costUsd: 99, usageJson: { costUsd: 1.5 } }));
  assert.equal(c.costUsd, 1.5);
});

// ---- history: the pattern that should have stopped at run 2 --------------

const NINE = [
  ["2026-09-02T18:36:11.271Z", "automation", null],
  ["2026-09-02T18:36:19.194Z", "automation", "bec6c723-cbde-4f0a-9e3c-4726fe3f1afe"],
  ["2026-09-02T18:36:24.971Z", "assignment", null],
  ["2026-09-02T18:44:43.506Z", "automation", null],
  ["2026-09-02T18:44:50.135Z", "automation", "093c642f-08ef-43e6-89a7-285ed5740325"],
  ["2026-09-02T18:45:04.132Z", "assignment", null],
  ["2026-09-02T18:47:00.366Z", "automation", null],
  ["2026-09-02T18:47:09.143Z", "automation", "x"],
  ["2026-09-02T18:47:19.091Z", "assignment", null],
].map(([createdAt, invocationSource, retryOfRunId], i) =>
  transportRun({ runId: `r${i}`, createdAt, invocationSource, retryOfRunId }));

test("nine identical transport failures are summarised as one condition, not nine", () => {
  const h = classifyRunHistory(NINE);
  assert.equal(h.dominantClass, "transport");
  assert.equal(h.consecutiveTransportFailures, 9);
  assert.equal(h.distinctErrorCodes.length, 1);
  assert.equal(h.totalCostUsd, 0);
  assert.equal(h.identicalFailure, true,
    "same code, same outcome, nothing changed between attempts");
});

test("the burst shape is reported, because it is what makes the count explicable", () => {
  const h = classifyRunHistory(NINE);
  assert.equal(h.retryChains, 3, "three automation retries, one per burst");
  assert.equal(h.assignmentDispatches, 3, "three assignment pickups");
});

test("a history whose failures differ is NOT an identical-failure condition", () => {
  const mixed = [
    transportRun({ runId: "a", errorCode: "adapter_failed" }),
    transportRun({ runId: "b", errorCode: "process_lost" }),
  ];
  assert.equal(classifyRunHistory(mixed).identicalFailure, false);
});

test("a successful run since the failures clears the streak", () => {
  const h = classifyRunHistory([
    ...NINE,
    reasoningRun({ runId: "ok", livenessState: "completed", nextAction: "review",
      createdAt: "2026-09-02T19:09:27.815Z" }),
  ]);
  assert.equal(h.consecutiveTransportFailures, 0);
});

// ---- the pre-dispatch refusal --------------------------------------------

test("preflight refuses a tenth launch after an unresolved identical transport burst", () => {
  const g = repeatedTransportFailureGate({ identifier: "ZEI-2", runs: NINE });
  assert.equal(g.ok, false);
  assert.match(g.detail, /9/);
  assert.match(g.detail, /adapter_failed/);
  assert.match(g.detail, /\$0/, "the cost must be stated: it is what makes this look harmless");
  assert.match(g.detail, /config/i, "the operator needs the action, not just the diagnosis");
});

test("the refusal clears once the condition is resolved", () => {
  const g = repeatedTransportFailureGate({
    identifier: "ZEI-2",
    runs: [...NINE, reasoningRun({ runId: "ok", livenessState: "completed", nextAction: "review" })],
  });
  assert.equal(g.ok, true);
});

test("one or two transport failures do not trip it — a genuine transient must be allowed to retry", () => {
  assert.equal(repeatedTransportFailureGate({ identifier: "ZEI-2", runs: NINE.slice(0, 2) }).ok, true);
  assert.equal(repeatedTransportFailureGate({ identifier: "ZEI-2", runs: NINE.slice(0, 3) }).ok, false,
    "a full burst — the server's own transient allowance — is the point at which retrying stops informing");
});

test("an issue with no runs is not a failure condition", () => {
  assert.equal(repeatedTransportFailureGate({ identifier: "ZEI-3", runs: [] }).ok, true);
});

test("runs that could not be read fail the gate closed", () => {
  const g = repeatedTransportFailureGate({ identifier: "ZEI-2", runs: null });
  assert.equal(g.ok, false);
  assert.match(g.detail, /could not/i);
});

// ---- bind the mirror to the shipped server ------------------------------

test("our transport taxonomy matches the installed Paperclip server's", () => {
  // The classification that actually drives retries is Paperclip's, and it is
  // a vendored constant we do not own. Restating it without checking would
  // mean a server upgrade could re-scope our blast radius in silence. This
  // reads the shipped file. If it cannot, it FAILS rather than assuming.
  const file = path.resolve(
    __dirname, "../../node_modules/@paperclipai/server/dist/services/recovery/service.js");
  assert.ok(fs.existsSync(file), `expected the shipped recovery service at ${file}`);
  const src = fs.readFileSync(file, "utf8");
  const m = /TRANSIENT_INFRA_CONTINUATION_ERROR_CODES\s*=\s*new Set\(\[([^\]]*)\]/.exec(src);
  assert.ok(m, "could not read TRANSIENT_INFRA_CONTINUATION_ERROR_CODES from the shipped server");
  const shipped = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.ok(shipped.includes("adapter_failed"),
    "the server no longer treats adapter_failed as transient — re-derive this module's taxonomy");
  for (const code of shipped) {
    assert.ok(TRANSPORT_ERROR_CODES.has(code),
      `the server retries "${code}" as transient infra and we do not classify it as transport`);
  }
});

test("our control taxonomy matches the installed server's non-retryable set", () => {
  const file = path.resolve(
    __dirname, "../../node_modules/@paperclipai/server/dist/services/recovery/service.js");
  const src = fs.readFileSync(file, "utf8");
  const m = /NON_RETRYABLE_CONTINUATION_ERROR_CODES\s*=\s*new Set\(\[([^\]]*)\]/.exec(src);
  assert.ok(m, "could not read NON_RETRYABLE_CONTINUATION_ERROR_CODES from the shipped server");
  const shipped = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  for (const code of shipped) {
    assert.ok(CONTROL_ERROR_CODES.has(code),
      `the server refuses to retry "${code}" and we do not classify it as control`);
  }
});

test("the reasoning side is bounded at one replay by the shipped server", () => {
  // The disposition side is the expensive one, and this is the constant that
  // decides how expensive. Both cost incidents were reasoning-class replays.
  const file = path.resolve(
    __dirname,
    "../../node_modules/@paperclipai/server/dist/services/recovery/successful-run-handoff.js");
  assert.ok(fs.existsSync(file), `expected the shipped handoff module at ${file}`);
  const src = fs.readFileSync(file, "utf8");
  const m = /DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS\s*=\s*(\d+)/.exec(src);
  assert.ok(m, "could not read DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS");
  assert.equal(Number(m[1]), 1,
    "a corrective redispatch budget above 1 multiplies the cost of every missing disposition");
});

// ── the streak's cost is not the history's cost ────────────────────────────
//
// The gate's message said "the last 4 run(s) all ended adapter_failed and cost
// $1.33 in total". They cost $0.00. The $1.33 belonged to an earlier SUCCEEDED
// run in the same issue's history. Reporting it as the failures' cost
// misattributes spend to the wrong event — the exact error BUILD_HISTORY §5c
// records as "the same incident was then mis-attributed", and the reason this
// repo reconciles cost against the ledger rather than estimating it.

test("the streak carries its own cost, separate from the issue's history", () => {
  const h = classifyRunHistory([
    reasoningRun({ runId: "paid", createdAt: "2026-09-02T19:09:00Z",
      livenessState: "advanced", usageJson: { costUsd: 1.32823425 } }),
    ...NINE.map((r, i) => transportRun({ ...r, runId: `f${i}`, createdAt: `2026-09-02T20:0${i}:00Z` })),
  ]);
  assert.equal(h.consecutiveTransportFailures, 9);
  assert.equal(h.streakCostUsd, 0, "the failures reached no provider and cost nothing");
  assert.equal(h.totalCostUsd.toFixed(4), "1.3282", "the history total is a different number");
});

test("the refusal states the STREAK's cost, not the issue's", () => {
  const g = repeatedTransportFailureGate({
    identifier: "ZEI-2",
    runs: [
      reasoningRun({ runId: "paid", createdAt: "2026-09-02T19:09:00Z",
        livenessState: "advanced", usageJson: { costUsd: 1.32823425 } }),
      ...NINE.map((r, i) => transportRun({ ...r, runId: `f${i}`, createdAt: `2026-09-02T20:0${i}:00Z` })),
    ],
  });
  assert.equal(g.ok, false);
  assert.match(g.detail, /\$0\.00/, "the failures cost nothing and the message must say so");
  assert.ok(!g.detail.includes("1.33"),
    "a cost from an unrelated successful run must not be attributed to the failures");
});

// ── clearing a condition the operator has resolved ─────────────────────────
//
// The gate blocks a dispatch that would only repeat a known failure. But its
// only natural exit is a successful run, which it blocks — so a condition the
// operator HAS fixed (a reset quota, a corrected config) leaves the issue
// permanently undispatchable. That is a gate with no door.
//
// The door costs a sentence. `resolved` is not a bypass flag: it requires the
// operator to state what changed, and that statement is echoed into the gate's
// detail so it lands in the run's record rather than in someone's memory.

test("a resolved condition clears the gate when the operator says what changed", () => {
  const g = repeatedTransportFailureGate({
    identifier: "ZEI-2", runs: NINE,
    resolved: "anthropic 5h quota window reset to 0%",
  });
  assert.equal(g.ok, true);
  assert.match(g.detail, /quota window reset/, "what changed must be recorded, not just accepted");
  assert.match(g.detail, /9/, "the streak it cleared stays visible");
});

test("an empty or missing reason does NOT clear the gate", () => {
  // Otherwise `--resolved` degenerates into `--force`, which is the thing the
  // gate exists to prevent.
  for (const resolved of ["", "   ", true, null, undefined]) {
    assert.equal(repeatedTransportFailureGate({ identifier: "ZEI-2", runs: NINE, resolved }).ok, false,
      `expected ${JSON.stringify(resolved)} not to clear the gate`);
  }
});

test("a reason does not clear a gate that failed for an unreadable history", () => {
  // "I fixed it" cannot substitute for evidence that was never gathered.
  const g = repeatedTransportFailureGate({ identifier: "ZEI-2", runs: null, resolved: "I fixed it" });
  assert.equal(g.ok, false);
  assert.match(g.detail, /could not/i);
});
