# Ledger

> **Append-only.** One row per terminal attempt. Rows are never rewritten and
> never reordered. A ledger you can edit is a ledger that agrees with whatever
> you currently believe.

This is the episodic index — the half of a learning loop that most designs
miss, because it records what *worked* as well as what broke. `ARCHITECTURE.md`
makes *"three consecutive useful outputs independently accepted"* a promotion
criterion; this file is what makes that criterion **measurable instead of
remembered**. It is also the only place a cost regression can be seen.

Rows are written by `factory retro <issue> --append`, or by hand for a session
that established a verified fact. Both take the same discipline: a row records
something **executed**, not something read or believed.

## Reading the columns

- **ledger $** — `usageJson.costUsd` from Paperclip's run ledger. The control
  plane's own record.
- **claimed $** — what the run's own execution receipt said it spent.
- These are **never merged**. One document reports OMP's self-reported cost
  understating a measured model by 2×, and nothing here has been reconciled
  against provider billing. A single "cost" column would silently pick a winner.
- **cache-read** — cached input tokens. Cost here is dominated by re-reading the
  resident prompt, so this is the column that shows whether a bundle reduction
  actually worked.
- **verdict** — the issue's terminal state, or `session` for an operator-session
  row.
- **fact** — the single line a human would have wanted to know beforehand.
  Supplied, never generated: a machine-written "lesson" is a summary of what
  happened, not something learned from it.

## What is NOT here

Model lineage is not recorded per run by Paperclip — no run record carries the
model that executed it — so the `model` column is populated only when a run
carries a `paperclipModelProfile`, and is `—` otherwise. Do not infer it from
the agent's current configuration; that changes.

`reportedTimeoutSec` is deliberately absent. The server builds it from
`agent.adapterConfig` alone, so it cannot reflect an issue override and is not
evidence about any run's actual bound.

---

## Rows

| date | issue | verdict | runs | billed | ledger $ | claimed $ | elapsed | cache-read | model | stop | fact |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 2026-09-01 | ZEI-1 | blocked | 12 | 8 | $11.1490 | — | 44m | 11,535,419 | — | paused | Cost is cache-reads of the resident prompt: 11.5M cache-read vs 125K output across 12 runs. |
| 2026-09-02 | ZEI-2 | blocked | 16 | 1 | $1.3282 | — | 18m | 21,377,165 | — | completed | Engineer fixed src/add.js but emitted no receipt frame, so the Reviewer correctly refused to review. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | `serverInfo.git` is evaluated PER REQUEST, not captured at process start — a server launched at 568da81 reported 467b525 after later commits. A sha comparison proves same-tree, never same-vintage. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | The 3x3 adapter_failed burst is dispatch + immediate retry + assignment pickup, repeated by Paperclip continuation recovery (TRANSIENT_INFRA_CONTINUATION_ERROR_CODES, max 3). scheduledRetryAttempt stays 0 throughout. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | The failure taxonomy already exists server-side and is bounded both ways: transport retries 3x, reasoning replay capped at DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | `resultJson.effectiveTimeoutSec` is built from agent.adapterConfig alone, so it cannot reflect an issue override and is NOT evidence about any run's real bound. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | `knownRunCost` requires usageJson.costStatus === 'reported'; Paperclip never sets that field, so factory promote refuses all 24 runs carrying usage. Phase 5 is blocked on it. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | Two of the six documented failures had NO guard: approvalMode: write (the ~$5.57 ZEI-1 runaway) was prevented only by the config happening to say yolo. adapterArgv passed it straight through. |
