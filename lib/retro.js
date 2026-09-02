"use strict";
// `factory retro <issue>` — the reader.
//
// This system emits excellent structured episodic evidence: a per-run cost
// ledger, execution receipts, per-criterion assessments, recovery actions,
// immutable apply receipts. Until now nothing read any of it back. The missing
// component was never a store — it was a reader and a promotion gate.
//
// WHAT THIS IS ALLOWED TO DO. It reads the control plane and writes, at most,
// two things: a row appended to docs/LEDGER.md, and a candidate lesson dropped
// in evals/candidates/. It must NEVER write instructions/src/, evals/cases/, or
// any expected output. The proposer does not get to move the bar that judges
// it; a candidate becomes an eval case or a doctrine line only by a human
// reading it. `assertWritableTarget` below is that rule made mechanical rather
// than remembered — if it ever fires, the gate has already been defended.
//
// TWO COST COLUMNS, DELIBERATELY. `ledgerCostUsd` is Paperclip's run ledger
// (`usageJson.costUsd`), the control plane's own record. `claimedCostUsd` is
// what the Engineer's execution receipt said about itself. They are recorded
// separately and never reconciled into one number, because one document reports
// OMP's self-reported cost understating a measured model by 2x and nothing here
// has ever been checked against provider billing. A single "cost" column would
// silently pick a winner.
//
// The row is APPEND-ONLY and never rewritten. A ledger you can edit is a ledger
// that agrees with whatever you currently believe.

const fs = require("node:fs");
const path = require("node:path");
const { Resolver } = require("./resolve");
const { classifyRun, classifyRunHistory } = require("./failure-class");
const { FactoryError } = require("./util");

const LEDGER_RELATIVE = "docs/LEDGER.md";
const CANDIDATES_RELATIVE = "evals/candidates";

/**
 * The one write rule, enforced rather than documented. Any path this module is
 * about to write must resolve inside docs/LEDGER.md or evals/candidates/.
 */
function assertWritableTarget(root, target) {
  const resolved = path.resolve(target);
  const ledger = path.resolve(root, LEDGER_RELATIVE);
  const candidates = path.resolve(root, CANDIDATES_RELATIVE) + path.sep;
  if (resolved === ledger) return resolved;
  if (resolved.startsWith(candidates)) return resolved;
  throw new FactoryError(
    `retro may only write ${LEDGER_RELATIVE} or ${CANDIDATES_RELATIVE}/; refusing ${resolved}. ` +
    `A tool that can write instructions/src/ or evals/cases/ is a proposer grading its own work.`,
  );
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Seconds between start and finish, or null when either is missing. */
function elapsedSec(run) {
  const a = Date.parse(run?.startedAt ?? "");
  const b = Date.parse(run?.finishedAt ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

/**
 * The Engineer's own claim about what it spent, if its summary carries a
 * receipt frame. Absence is normal and is NOT an error here: a run that emitted
 * no frame is exactly the condition worth recording.
 */
function claimedCostFromSummary(run) {
  const text = [run?.resultJson?.summary, run?.stdoutExcerpt, run?.lastAssistantSnippet]
    .filter((s) => typeof s === "string").join("\n");
  const m = /"?costUsd"?\s*[:=]\s*\$?([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** Model lineage is not recorded per run by Paperclip; report what is. */
function modelOf(run) {
  const p = run?.contextSnapshot?.paperclipModelProfile;
  return p?.applied ?? p?.requested ?? null;
}

function summarizeRun(run, agentNames) {
  const cls = classifyRun(run);
  const usage = run?.usageJson ?? {};
  return {
    runId: run.runId ?? run.id,
    createdAt: run.createdAt,
    agent: agentNames.get(run.agentId) ?? run.agentId,
    status: run.status,
    errorCode: run.errorCode ?? null,
    class: cls.class,
    invocationSource: run.invocationSource ?? null,
    retryOfRunId: run.retryOfRunId ?? null,
    elapsedSec: elapsedSec(run),
    ledgerCostUsd: num(usage.costUsd),
    claimedCostUsd: claimedCostFromSummary(run),
    model: modelOf(run),
    stopReason: run?.resultJson?.stopReason ?? null,
    livenessState: run.livenessState ?? null,
    nextAction: run.nextAction ?? null,
    // Reported ONLY. The server builds this from agent.adapterConfig alone and
    // it cannot reflect an issue override; see lib/config.js.
    reportedTimeoutSec: num(run?.resultJson?.effectiveTimeoutSec),
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cachedInputTokens ?? usage.cache_read_input_tokens),
  };
}

/** Read everything, decide nothing. */
async function collectRetro({ api, cfg, identifier }) {
  const resolver = new Resolver(api);
  const company = await resolver.company(cfg.company.name);
  const issue = await resolver.issue(company.id, identifier);

  const agentNames = new Map();
  try {
    for (const a of await api.get(`/api/companies/${company.id}/agents`)) agentNames.set(a.id, a.name);
  } catch { /* names are a convenience; ids still identify a run */ }

  const raw = await api.get(`/api/issues/${issue.id}/runs`);
  const runs = (Array.isArray(raw) ? raw : [])
    .slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((r) => summarizeRun(r, agentNames));

  const history = classifyRunHistory(Array.isArray(raw) ? raw : []);
  const billed = runs.filter((r) => (r.ledgerCostUsd ?? 0) > 0);

  // CLAIMS VS EVIDENCE. Each entry is a place the run's own account and the
  // control plane's record disagree. An empty list is a real result.
  const claimsVsEvidence = [];
  for (const r of runs) {
    if (r.claimedCostUsd !== null && r.ledgerCostUsd !== null &&
        Math.abs(r.claimedCostUsd - r.ledgerCostUsd) > 0.01) {
      claimsVsEvidence.push(
        `${r.runId.slice(0, 8)}: receipt claims $${r.claimedCostUsd.toFixed(4)}, ` +
        `ledger records $${r.ledgerCostUsd.toFixed(4)}`);
    }
    if (r.status === "succeeded" && !r.livenessState && !r.nextAction) {
      claimsVsEvidence.push(
        `${r.runId.slice(0, 8)}: succeeded with no disposition — a corrective redispatch re-pays for the reasoning`);
    }
  }

  return {
    identifier, issueId: issue.id, status: issue.status ?? null,
    runs,
    totals: {
      runs: runs.length,
      billed: billed.length,
      ledgerCostUsd: runs.reduce((a, r) => a + (r.ledgerCostUsd ?? 0), 0),
      elapsedSec: runs.reduce((a, r) => a + (r.elapsedSec ?? 0), 0),
      cacheReadTokens: runs.reduce((a, r) => a + (r.cacheReadTokens ?? 0), 0),
      outputTokens: runs.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
    },
    history: {
      dominantClass: history.dominantClass,
      counts: history.counts,
      consecutiveTransportFailures: history.consecutiveTransportFailures,
      identicalFailure: history.identicalFailure,
    },
    claimsVsEvidence,
  };
}

const cell = (v) => (v === null || v === undefined || v === "" ? "—" : String(v).replace(/\|/g, "\\|"));
const money = (n) => (typeof n === "number" ? `$${n.toFixed(4)}` : "—");

const LEDGER_COLUMNS =
  "| date | issue | verdict | runs | billed | ledger $ | claimed $ | elapsed | cache-read | model | stop | fact |";
const LEDGER_RULE =
  "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |";

/**
 * One row per terminal attempt on an issue. `fact` is the single line a human
 * would want to have known; it is supplied, never inferred, because a generated
 * "lesson" is a summary of what happened and not a thing learned from it.
 */
function renderLedgerRow(retro, { date, verdict, fact }) {
  const t = retro.totals;
  const last = retro.runs[retro.runs.length - 1] ?? {};
  const claimed = retro.runs.map((r) => r.claimedCostUsd).filter((n) => n !== null);
  return [
    "", cell(date), cell(retro.identifier), cell(verdict), cell(t.runs), cell(t.billed),
    money(t.ledgerCostUsd),
    claimed.length ? money(claimed.reduce((a, b) => a + b, 0)) : "—",
    t.elapsedSec ? `${Math.round(t.elapsedSec / 60)}m` : "—",
    t.cacheReadTokens ? t.cacheReadTokens.toLocaleString("en-US") : "—",
    cell(last.model), cell(last.stopReason), cell(fact), "",
  ].join(" | ").replace(/^ \| /, "| ").replace(/ \| $/, " |");
}

/** Append-only. Never rewrites an existing row. */
function appendLedgerRow(root, row, { fsImpl = fs } = {}) {
  const file = assertWritableTarget(root, path.join(root, LEDGER_RELATIVE));
  if (!fsImpl.existsSync(file)) {
    throw new FactoryError(`${LEDGER_RELATIVE} does not exist; create it before appending rows`);
  }
  const body = fsImpl.readFileSync(file, "utf8");
  const trimmed = body.replace(/\s+$/, "");
  fsImpl.writeFileSync(file, `${trimmed}\n${row}\n`);
  return file;
}

/** A candidate is a DRAFT for a human. It never becomes a case by itself. */
function draftCandidate(root, retro, { date, verdict, fact }, { fsImpl = fs } = {}) {
  const dir = path.join(root, CANDIDATES_RELATIVE);
  const file = assertWritableTarget(root, path.join(dir, `${date}-${retro.identifier}.md`));
  fsImpl.mkdirSync(dir, { recursive: true });
  const lines = [
    `# Candidate lesson — ${retro.identifier} (${date})`,
    "",
    "> DRAFT. Written by `factory retro`. It becomes an eval case or a doctrine",
    "> line only when a human decides it does. Nothing here is authoritative.",
    "",
    `- **Verdict:** ${verdict}`,
    `- **Issue status:** ${retro.status ?? "—"}`,
    `- **Runs:** ${retro.totals.runs} (${retro.totals.billed} billed)`,
    `- **Ledger cost:** ${money(retro.totals.ledgerCostUsd)}`,
    `- **Dominant failure class:** ${retro.history.dominantClass ?? "—"}`,
    `- **Fact offered:** ${fact ?? "(none supplied)"}`,
    "",
    "## Provenance",
    "",
    ...retro.runs.map((r) =>
      `- run \`${r.runId}\` · ${r.createdAt} · ${r.agent} · ${r.status}` +
      `${r.errorCode ? ` (${r.errorCode})` : ""} · ${r.class} · ${money(r.ledgerCostUsd)}`),
    "",
    "## Claims vs evidence",
    "",
    ...(retro.claimsVsEvidence.length
      ? retro.claimsVsEvidence.map((c) => `- ${c}`)
      : ["- no disagreement found between run self-reports and the control plane's record"]),
    "",
  ];
  fsImpl.writeFileSync(file, lines.join("\n"));
  return file;
}

async function run(cfg, args, { connect, requireHealthy, C }) {
  const identifier = args._[1];
  if (!identifier) {
    console.error(C.red("retro requires an issue identifier, e.g. factory retro ZEI-1"));
    return 2;
  }
  const api = connect(cfg);
  await requireHealthy(api);
  const retro = await collectRetro({ api, cfg, identifier });

  if (args.flags.json) { console.log(JSON.stringify(retro, null, 2)); return 0; }

  const t = retro.totals;
  console.log(C.bold(`${retro.identifier}`) + C.dim(`  status=${retro.status ?? "?"}  ${retro.issueId}`));
  console.log(C.bold("\nruns"));
  for (const r of retro.runs) {
    const mark = r.status === "succeeded" ? C.green("ok  ") : C.red("FAIL");
    console.log(`  ${mark} ${r.createdAt}  ${String(r.agent).padEnd(18)} ${String(r.class).padEnd(10)} ` +
      `${money(r.ledgerCostUsd).padStart(9)}  ${r.elapsedSec !== null ? `${r.elapsedSec}s` : "—"}` +
      `${r.errorCode ? C.dim(`  ${r.errorCode}`) : ""}`);
  }
  console.log(C.bold("\ntotals"));
  console.log(`  ${t.runs} run(s), ${t.billed} billed`);
  console.log(`  ledger cost   ${money(t.ledgerCostUsd)}   ${C.dim("(usageJson — never reconciled against provider billing)")}`);
  console.log(`  cache reads   ${t.cacheReadTokens.toLocaleString("en-US")} tokens vs ${t.outputTokens.toLocaleString("en-US")} output`);
  console.log(C.bold("\nclaims vs evidence"));
  if (!retro.claimsVsEvidence.length) console.log(C.green("  none — self-reports agree with the control plane"));
  else for (const c of retro.claimsVsEvidence) console.log(`  ${C.yellow("差")} ${c}`.replace("差", "diff"));

  const date = args.flags.date === undefined || args.flags.date === true
    ? new Date().toISOString().slice(0, 10) : String(args.flags.date);
  const verdict = args.flags.verdict === undefined || args.flags.verdict === true
    ? (retro.status ?? "unknown") : String(args.flags.verdict);
  const fact = args.flags.fact === undefined || args.flags.fact === true ? null : String(args.flags.fact);

  const row = renderLedgerRow(retro, { date, verdict, fact });
  console.log(C.bold("\nledger row"));
  console.log(`  ${C.dim(row)}`);

  if (args.flags.append) {
    const file = appendLedgerRow(cfg._root, row);
    console.log(C.green(`\nappended to ${path.relative(cfg._root, file)}`));
  }
  if (args.flags.candidate) {
    const file = draftCandidate(cfg._root, retro, { date, verdict, fact });
    console.log(C.green(`drafted ${path.relative(cfg._root, file)}`) +
      C.dim("  — a draft for you to read, not a case"));
  }
  if (!args.flags.append && !args.flags.candidate) {
    console.log(C.dim("\nread-only. --append writes the row; --candidate drafts a lesson."));
  }
  return 0;
}

module.exports = {
  collectRetro, renderLedgerRow, appendLedgerRow, draftCandidate, assertWritableTarget,
  summarizeRun, elapsedSec, claimedCostFromSummary, run,
  LEDGER_COLUMNS, LEDGER_RULE, LEDGER_RELATIVE, CANDIDATES_RELATIVE,
};
