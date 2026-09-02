"use strict";
// The reader, and the one rule that keeps it a reader.
//
// `factory retro` is the component the audit found missing: this system emits
// structured episodic evidence and nothing read it back. A reader that can also
// write its own grading criteria is not a reader, so the write surface is
// exactly two paths and that is enforced, not documented.
//
// The reconciliation tests below are KNOWN-ANSWER tests. The audit plan, written
// independently on 2026-09-02, stated three numbers from the live instance:
// ZEI-1 cost $11.15 across its runs with 8 billed, the Reviewer's share $0.89,
// and one run at $3.789 showing 3,933,440 cache-read tokens against 44,582
// output. A reader that reproduces someone else's arithmetic from the raw
// ledger is a reader you can believe.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectRetro, renderLedgerRow, appendLedgerRow, draftCandidate,
  assertWritableTarget, elapsedSec, claimedCostFromSummary, LEDGER_RELATIVE,
} = require("../../lib/retro");
const { FactoryError } = require("../../lib/util");

// ---- the write rule ------------------------------------------------------

test("retro may write the ledger", () => {
  const root = "/repo";
  assert.equal(assertWritableTarget(root, "/repo/docs/LEDGER.md"), "/repo/docs/LEDGER.md");
});

test("retro may write a candidate draft", () => {
  assert.equal(
    assertWritableTarget("/repo", "/repo/evals/candidates/2026-09-02-ZEI-1.md"),
    "/repo/evals/candidates/2026-09-02-ZEI-1.md");
});

test("retro may NOT write an eval case — that is the bar it is judged against", () => {
  assert.throws(() => assertWritableTarget("/repo", "/repo/evals/cases/x/expected.json"),
    (err) => {
      assert.ok(err instanceof FactoryError);
      assert.match(err.message, /proposer grading its own work/);
      return true;
    });
});

test("retro may NOT write instructions", () => {
  assert.throws(() => assertWritableTarget("/repo", "/repo/instructions/src/_core.md"), FactoryError);
});

test("retro may not escape the candidates directory by traversal", () => {
  assert.throws(
    () => assertWritableTarget("/repo", "/repo/evals/candidates/../cases/x.md"), FactoryError);
});

test("the candidates directory itself is not a writable target, only files under it", () => {
  assert.throws(() => assertWritableTarget("/repo", "/repo/evals/candidates"), FactoryError);
});

// ---- reading -------------------------------------------------------------

// Trimmed from the real ZEI-1 ledger, values verbatim.
const RUNS = [
  { runId: "a1", agentId: "eng", status: "succeeded", createdAt: "2026-08-31T15:25:40.162Z",
    startedAt: "2026-08-31T15:25:40.162Z", finishedAt: "2026-08-31T15:30:31.000Z",
    livenessState: "advanced", resultJson: { stopReason: "completed" },
    usageJson: { costUsd: 1.82034, inputTokens: 1000, outputTokens: 20000, cachedInputTokens: 3000000 } },
  { runId: "a2", agentId: "eng", status: "succeeded", createdAt: "2026-09-01T21:06:53.971Z",
    startedAt: "2026-09-01T21:06:53.971Z", finishedAt: "2026-09-01T21:16:52.971Z",
    livenessState: "advanced", resultJson: { stopReason: "completed" },
    usageJson: { costUsd: 3.789, inputTokens: 5000, outputTokens: 44582, cachedInputTokens: 3933440 } },
  { runId: "a3", agentId: "rev", status: "succeeded", createdAt: "2026-09-01T21:16:53.591Z",
    startedAt: "2026-09-01T21:16:53.591Z", finishedAt: "2026-09-01T21:23:57.591Z",
    livenessState: "advanced", resultJson: { stopReason: "completed" },
    usageJson: { costUsd: 0.892395, inputTokens: 24577, outputTokens: 2333, cachedInputTokens: 1399040 } },
  { runId: "a4", agentId: "eng", status: "failed", errorCode: "process_lost",
    createdAt: "2026-09-01T20:59:58.786Z", startedAt: "2026-09-01T20:59:58.786Z",
    finishedAt: "2026-09-01T21:00:52.786Z", usageJson: {} },
];

const fakeApi = (runs = RUNS) => ({
  get: async (p) => {
    if (p === "/api/companies") return [{ id: "c1", name: "ZEIROS" }];
    if (p === "/api/companies/c1/issues") return [{ id: "i1", identifier: "ZEI-1", status: "blocked" }];
    if (p === "/api/issues/i1") return { id: "i1", identifier: "ZEI-1", status: "blocked" };
    if (p === "/api/companies/c1/agents") return [{ id: "eng", name: "OMP Engineer" }, { id: "rev", name: "OMP Reviewer" }];
    if (p === "/api/issues/i1/runs") return runs;
    throw new Error(`GET ${p}`);
  },
});
const cfg = { company: { name: "ZEIROS" }, _root: "/repo" };

test("totals reconcile from the raw ledger", async () => {
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  assert.equal(r.totals.runs, 4);
  assert.equal(r.totals.billed, 3, "a run with no cost is not billed");
  assert.equal(r.totals.ledgerCostUsd.toFixed(4), "6.5017");
});

test("the Reviewer's share is separable — the plan's $0.89", async () => {
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const rev = r.runs.filter((x) => x.agent === "OMP Reviewer");
  assert.equal(rev.reduce((a, b) => a + b.ledgerCostUsd, 0).toFixed(2), "0.89");
});

test("the cache-read column reproduces the plan's cited run exactly", async () => {
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const big = r.runs.find((x) => x.ledgerCostUsd === 3.789);
  assert.equal(big.cacheReadTokens, 3933440);
  assert.equal(big.outputTokens, 44582);
});

test("runs are ordered oldest first, so a ledger row reads as a history", async () => {
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const dates = r.runs.map((x) => x.createdAt);
  assert.deepEqual(dates, [...dates].sort());
});

test("a failure is classified, not just recorded as failed", async () => {
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  assert.equal(r.runs.find((x) => x.runId === "a4").class, "transport");
});

test("a succeeded run with no disposition surfaces as a claims-vs-evidence entry", async () => {
  const runs = [{ runId: "z", agentId: "eng", status: "succeeded", createdAt: "2026-09-02T00:00:00Z",
    usageJson: { costUsd: 1 } }];
  const r = await collectRetro({ api: fakeApi(runs), cfg, identifier: "ZEI-1" });
  assert.equal(r.claimsVsEvidence.length, 1);
  assert.match(r.claimsVsEvidence[0], /no disposition/);
});

test("a receipt claim that disagrees with the ledger is reported, not reconciled away", async () => {
  const runs = [{ runId: "z", agentId: "eng", status: "succeeded", createdAt: "2026-09-02T00:00:00Z",
    livenessState: "advanced", usageJson: { costUsd: 1.0 },
    resultJson: { summary: 'receipt says costUsd: 0.50 for this run' } }];
  const r = await collectRetro({ api: fakeApi(runs), cfg, identifier: "ZEI-1" });
  assert.equal(r.runs[0].claimedCostUsd, 0.5);
  assert.equal(r.runs[0].ledgerCostUsd, 1.0);
  assert.match(r.claimsVsEvidence.join("\n"), /receipt claims \$0\.5000, ledger records \$1\.0000/);
});

test("elapsed is null rather than zero when the run never finished", () => {
  assert.equal(elapsedSec({ startedAt: "2026-09-02T00:00:00Z" }), null);
  assert.equal(elapsedSec({ startedAt: "2026-09-02T00:00:00Z", finishedAt: "2026-09-02T00:01:00Z" }), 60);
});

test("a summary with no receipt frame yields no claim, which is a real answer", () => {
  assert.equal(claimedCostFromSummary({ resultJson: { summary: "I fixed the test." } }), null);
});

// ---- writing -------------------------------------------------------------

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, LEDGER_RELATIVE), "# Ledger\n\n| date |\n| --- |\n");
  return root;
}

test("appending adds a row and leaves the existing ones byte-identical", async () => {
  const root = tmpRepo();
  const before = fs.readFileSync(path.join(root, LEDGER_RELATIVE), "utf8");
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const row = renderLedgerRow(r, { date: "2026-09-02", verdict: "blocked", fact: "a fact" });
  appendLedgerRow(root, row);
  const after = fs.readFileSync(path.join(root, LEDGER_RELATIVE), "utf8");
  assert.ok(after.startsWith(before.replace(/\s+$/, "")), "prior content must survive verbatim");
  assert.ok(after.trimEnd().endsWith(row));
});

test("two appends produce two rows — the ledger accumulates rather than replaces", async () => {
  const root = tmpRepo();
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  appendLedgerRow(root, renderLedgerRow(r, { date: "2026-09-02", verdict: "blocked", fact: "one" }));
  appendLedgerRow(root, renderLedgerRow(r, { date: "2026-09-03", verdict: "done", fact: "two" }));
  const body = fs.readFileSync(path.join(root, LEDGER_RELATIVE), "utf8");
  assert.match(body, /\| one \|/);
  assert.match(body, /\| two \|/);
});

test("appending to a ledger that does not exist refuses rather than creating one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retro-"));
  assert.throws(() => appendLedgerRow(root, "| x |"), /does not exist/);
});

test("a row keeps the two cost columns separate", async () => {
  const runs = [{ runId: "z", agentId: "eng", status: "succeeded", createdAt: "2026-09-02T00:00:00Z",
    livenessState: "advanced", usageJson: { costUsd: 1.0 },
    resultJson: { summary: "costUsd: 0.50" } }];
  const r = await collectRetro({ api: fakeApi(runs), cfg, identifier: "ZEI-1" });
  const row = renderLedgerRow(r, { date: "2026-09-02", verdict: "done", fact: "f" });
  assert.match(row, /\$1\.0000/);
  assert.match(row, /\$0\.5000/);
});

test("a pipe in a supplied fact cannot break the table", async () => {
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const row = renderLedgerRow(r, { date: "2026-09-02", verdict: "done", fact: "a | b" });
  assert.match(row, /a \\\| b/);
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 13, "12 columns plus the closing pipe");
});

test("a candidate draft lands in evals/candidates and carries its provenance", async () => {
  const root = tmpRepo();
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const file = draftCandidate(root, r, { date: "2026-09-02", verdict: "blocked", fact: "a fact" });
  assert.ok(file.startsWith(path.join(root, "evals/candidates")));
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /DRAFT/);
  assert.match(body, /run `a1`/, "every run id must be present, or the row cannot be audited");
  assert.match(body, /run `a4`/);
});

test("a candidate is a draft and says so — it must never read as a decision", async () => {
  const root = tmpRepo();
  const r = await collectRetro({ api: fakeApi(), cfg, identifier: "ZEI-1" });
  const body = fs.readFileSync(
    draftCandidate(root, r, { date: "2026-09-02", verdict: "blocked", fact: null }), "utf8");
  assert.match(body, /only when a human decides it does/);
});
