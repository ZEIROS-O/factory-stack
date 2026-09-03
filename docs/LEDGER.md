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
| 2026-09-02 | ZEI-2 | blocked | 20 | 1 | $1.3282 | — | 18m | 21,377,165 | — | adapter_failed | Canary re-dispatch: Engineer blocked by Anthropic 5h window at 100% with usageReservePolicy fail-closed. $0.00, no provider reached. Cost control working; the repeated-launch gate then blocked attempt 5. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | usageReservePolicy fail-closed BLOCKS the run rather than falling back: the run never started, so retry.fallbackChains never engaged. [I] fail-closed pre-empts modelFallback. The P0-3 reorder therefore guards non-quota failures, not quota exhaustion. |
| 2026-09-02 | ZEI-2 | in_review | 24 | 2 | $2.5133 | — | 27m | 26,436,569 | — | — | Canary: Engineer CALLED paperclip_receipt with well-formed args — the structural fix works at the model layer. The document write returned 403 and the reason was discarded by the tool. |
| 2026-09-02 | — | session | — | — | — | — | — | — | — | — | 403 on PUT documents/execution-receipt is NOT status-only-recovery (modelProfile undefined) and NOT the assignee mismatch (Engineer held the assignee for the whole run). Remaining candidate: decideIssueAccess(issue:mutate). Unresolved — the response body was discarded before it was read. |
| 2026-09-02 | ZEI-2 | in_review | 24 | 2 | $2.5133 | — | 31m | 30,599,439 | — | completed | 403 root cause: the Engineer set the disposition BEFORE writing the receipt, which reassigned the issue and made the write 'another agent's issue'. Ordering, not permissions. |
| 2026-09-03 | ZEI-2 | blocked | 28 | 3 | $4.0149 | — | 44m | 40,677,486 | — | completed | CANARY: Engineer wrote the receipt document via paperclip_receipt ($1.50, liveness=advanced). Structural fix proven end to end. Reviewer then looped 3x plan_only at $0.00 without calling paperclip_review. |
| 2026-09-03 | — | session | — | — | — | — | — | — | — | — | The receipt-as-tool fix WORKS: Engineer called paperclip_receipt before the disposition and the document persisted (ExecutionReceiptClaimsV1, ready_for_review, src/add.js, head==base). The ordering rule was the whole fix. |
| 2026-09-03 | — | session | — | — | — | — | — | — | — | — | Reviewer reads far outside its attempt worktree — it grepped /home/lucascoh and read factory-stack/lib/*.js to debug the receipt format instead of reviewing the diff. The WRITE boundary held; the READ boundary is wide. [H] session resume carried prior-failure context into a debugging spiral. |
| 2026-09-03 | — | session | — | — | — | — | — | — | — | — | CORRECTION: the Reviewer did NOT go off-task. It reviewed the diff, called paperclip_review with a PASS, and was refused by ExecutionReceiptV1 validation on a checks shape I got wrong. Its investigation was a correct root-cause diagnosis, and its wide read scope is what made that possible. |
| 2026-09-03 | — | session | — | — | — | — | — | — | — | — | Resume hypothesis DISPROVEN: sessionIdBefore is null on all 12 Reviewer runs — Paperclip never resumed a session. The prior-context access was OMP's own history:// device, not Paperclip continuity. |
