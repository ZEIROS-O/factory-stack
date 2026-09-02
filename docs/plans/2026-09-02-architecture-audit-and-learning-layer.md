# Factory-Stack: Architecture Audit + Learning Layer

## Context

You asked for a full system audit and a design for self-improvement / memory /
learning — capturing what works and what's discovered, not only what breaks —
at minimum viable scale.

The audit's central finding reframes the request:

> **This system does not need a memory system. It already emits excellent
> structured episodic evidence — execution receipts, per-criterion assessments,
> a per-run cost ledger, recovery actions, immutable apply receipts — and
> nothing ever reads any of it back. The missing component is a reader and a
> promotion gate, not a store.**

The learning loop today is 100% human: a failure fires → you notice → a session
diagnoses it → someone edits `instructions/src/` or a doc → commit. That loop
has produced real value (it is why `OPERATIONS.md §0` exists). It costs roughly
a founder-night per lesson, which is the binding constraint on the system's own
stated optimization target — *valuable unattended progress per unit of founder
attention*.

Three P0 conditions are live right now and block measuring any loop. They come
first.

---

## What I verified live (2026-09-02, ~15:00 EDT)

| Fact | Value |
|---|---|
| Real spend to date | **$11.15** across 21 runs (8 billed), reconciled from `usageJson` |
| Accepted outputs | **0** — cost per useful output is undefined |
| Budget ledger | **Correct**, monthly-scoped (Eng 468¢ / Rev 89¢ / co 557¢ = September only) |
| Tests | master **190 pass**; `feat/context-architecture` **348 pass** |
| Live agents configured from | `/home/lucascoh/worktrees/factory-context-arch` (unmerged branch) |
| Issues | ZEI-1 `blocked`, ZEI-2 `blocked` (canary, failed 19s after start) |
| `enableIsolatedWorkspaces` | `true` — isolation is working; ZEI-2's worktree provisioned correctly |
| OMP memory / autolearn | absent from config → defaults → **off** (correct; keep) |

Claims below are labelled **[V]** verified by execution, **[R]** reported by a
document, **[I]** inference, **[H]** hypothesis needing a test.

---

## P0 — do these before anything else

### P0-1 · Two Paperclip servers share one database

**Evidence [V]:** PID 112128 on `:3100` runs the binary from
`worktrees/factory-finalization` (up since 09-01 02:02, reports commit
`4e7c1a6` / branch `feat/factory-finalization`) and is the **parent of the
embedded Postgres** (112155). PID 518405 on `:3101` runs the binary from
`factory-stack`, started today 14:02 from an interactive shell, and holds ~10
established connections to *that same* Postgres. Both return `status: ok` and
serve identical data. `~/.paperclip/instances/default/runtime-info.json` has
been overwritten by the newcomer and now advertises `pid 518405, port 3101`.

`ops/paperclip-status.sh` correctly exits **1** with *"runtime PID metadata does
not match this instance."* The guard works. The condition is unresolved.

**Root cause:** the lifecycle wrappers own the tmux session, but nothing
prevents a bare `paperclipai run` from a terminal attaching to the same instance
directory. The server's own port guard shifted it to 3101 instead of refusing.

**Impact:** this is the recorded `§5d` incident recurring. Stopping the tmux
session takes Postgres down *underneath* the `:3101` server. Meanwhile
`factory.config.json` points at `:3100` — the stale binary — while the
instance's own metadata points at `:3101`.

**Fix (operator-authorized, service lifecycle):** stop PID 518405; confirm
`:3100` is sole server; then restart the tracked instance from
`/home/lucascoh/factory-stack` so the running binary and its git identity match
the tree you maintain.

**Then harden:** add to `factory status` an assertion that the live server's
`serverInfo.git.fullSha` and launch path match the repo the CLI is running from,
and that exactly one `paperclipai run` process owns the instance dir.

**Validation:** `ops/paperclip-status.sh` exits 0; one PID in `pgrep -af
paperclipai`; `runtime-info.json` names it; `/api/health` reports the commit you
expect. **Rollback:** none needed — read-only until the stop.

### P0-2 · `factory apply` from master would revert live state to a worse design

**Evidence [V]:** `factory diff` from master proposes
`reconcile agent "OMP Engineer" adapterConfig … [removing env, extensions]` —
deleting `OMP_PROFILE`, the `paperclip-goal-guard` extension, and
`base.overlay.yml` from both live agents. The goal-guard is the mechanical fix
for the exit-0-without-disposition redispatch loop that produced both cost
incidents. Master does not contain it.

**Root cause:** `${FACTORY_ROOT}` expands to whichever tree ran `apply`, so live
state is a function of *where you applied from*, not of the declared config —
and the newer design lives only on an unmerged branch.

**Impact:** structurally identical to the commit-`4e7c1a6` near-miss that
`BUILD_HISTORY.md` records as *"the single most expensive false conclusion in
this project's history."* Same mechanism, same blast radius, still unguarded.

**Fix (your decision, taken):** merge `feat/context-architecture` → master
first, accepting the 12pm audit's 7 findings as open defects tracked in
`BUILD_HISTORY.md`. Then add to `lib/preflight.js` a refusal to apply when the
resolved `${FACTORY_ROOT}` differs from the live agents' current root unless an
explicit `--relocate` flag is passed.

**Validation:** after merge, `factory diff` shows path-relocation actions only —
zero `[removing …]` clauses. `npm run check` green at 348+.
**Rollback:** the merge is a fast-forward-able branch; `git reset` restores.

### P0-3 · Subscription lanes fall back to the *most expensive* metered model

**Evidence [V]:** in both `~/.omp/agent/config.yml` and its frozen copy
`omp/base.overlay.yml`:

```yaml
retry:
  modelFallback: true
  usageAwareFallback: true      # preflight coding-plan quota before spending it
  usageReservePct: 10
  usageReservePolicy: fail-closed
  fallbackChains:
    # Subscription lanes fall to the cheapest frontier model.
    "anthropic/*":     [openrouter/z-ai/glm-5.3, openrouter/z-ai/glm-5.3-flash]
    "openai-codex/*":  [openrouter/z-ai/glm-5.3, openrouter/z-ai/glm-5.3-flash]
```

The comment says *cheapest*; the list leads with **glm-5.3 at $1.73/M** when
`glm-5.3-flash` ($0.19/M) and `deepseek-v4-pro` ($0.48/M) are both in the table.
Intent and implementation disagree.

**Mechanism [I]:** as the Anthropic/Codex subscription quota nears the 10%
reserve, `usageAwareFallback` routes to the first chain entry — the $1.73 model.
The run still succeeds, so nothing surfaces it. This matches your own note today:
*"routing is messed up; only used GLM 5.3 instead of 5.3-flash or any other the
entire time."*

**The trap:** `base.overlay.yml` is loaded via `--config` *after* the global
table, specifically so a change to your personal config cannot silently re-route
factory work. **Fixing only `~/.omp/agent/config.yml` leaves factory runs on the
expensive chain.** Both files must change.

**Fix:** reorder both chains to lead with the cheap lane, matching the stated
intent. Decide deliberately whether the fallback should optimize cost
(`glm-5.3-flash`, $0.19) or capability (`deepseek-v4-pro`, $0.48) — `glm-5.3` is
already the deliberate `code-hard` model and should not be the *default* failover.

**Also note:** metered fallback at all contradicts the declared canary boundary
*"subscription routes only … no paid nested fan-out or metered fallback"*
(`OPERATIONS.md §10`). Pick one; enforce it mechanically.

**Validation:** add a unit test asserting the two files' `fallbackChains` are
byte-identical and that no subscription chain leads with a model priced above a
declared ceiling. **Rollback:** one-line revert each.

### P0-4 · Retry policy does not classify failure type — in both directions

**Evidence [V]:** ZEI-2 today produced **9 runs, all `adapter_failed`,
`costUsd: 0`**, in three bursts of three at ~8-second intervals (18:36:11/19/25,
18:44:43/50, 18:45:04, 18:47:00/09/19). An adapter launch failure cannot succeed
on immediate retry with identical config.

The inverse is documented and verified: a *reasoning* run that exits 0 with no
disposition is re-dispatched as a corrective run
(`services/heartbeat.js:7026`) — the engine of both cost incidents.

**Root cause:** one missing thing — a failure taxonomy driving retry policy.
`adapter_failed` / `process_lost` are transport-class (cheap, retry with backoff
or not at all). `succeeded-without-disposition` is reasoning-class (expensive,
must never auto-replay).

Today's storm cost **$0 only because it died before reaching a provider**. That
is luck about where the failure landed, not a control.

**[H] — needs one discriminating test:** I observed the 3×3 burst pattern but
have *not* confirmed which component emits it. `scheduledRetryAttempt` was `0` on
the run I inspected, which argues against Paperclip's own retry counter. Test:
re-trigger one adapter failure and watch the heartbeat log for
`issue.successful_run_handoff_required` vs. a scheduler re-dispatch, before
building anything.

**Fix:** classify in one place, then make the policy structural — `adapter_failed`
raises to the operator rather than re-dispatching; the goal-guard already covers
the disposition side and should have an assertion proving it.

**Validation:** a fixture-driven test per class that kills its mutant.

---

## P1 — the learning layer (the actual ask)

### Diagnosis

Mapped onto the context tiers, this is what exists:

| Tier | State |
|---|---|
| 0 · enforcement | **Strong** — bwrap, policy overlays, goal-guard, `lib/api.js#mutate`, plan-hash |
| 1 · always-loaded | **Strong** — `CLAUDE.md` 13 lines, 3 invariants; bundles cut 73–79% |
| 2 · scoped | **Strong** — `ARCHITECTURE` / `OPERATIONS` / `BUILD_HISTORY` + index + precedence |
| 3 · procedures | Present — `instructions/src/`, `skills/` |
| 4 · knowledge | **Absent** — no retrievable, provenance-carrying fact store |
| 5 · live | **Strong** — Paperclip API, git, tests |
| episodic evidence | **Emitted and never read** ← the gap |
| evaluation state | **Absent entirely** ← the gap |

The context-architecture work you did last night is genuinely good and I am not
re-prescribing it. The monolith became four files with correct tier separation
and an explicit precedence rule. Leave it alone.

### Target: three artifacts, one command, one gate

**1 · `docs/LEDGER.md` — the episodic index (append-only)**

One row per terminal attempt. Columns: date · issue · verdict · **reconciled**
cost (from `usageJson`, never self-reported) · elapsed · model lineage · stop
reason · one-line fact learned. Written by `factory retro`; never rewritten.

This is where *"what works"* lives, which is the half most such designs miss.
`ARCHITECTURE.md §11` already makes *"three consecutive useful outputs
independently accepted"* a promotion criterion — the ledger is what makes that
criterion **measurable instead of remembered**. It is also the only place a
cost-regression comparison can exist.

**2 · `evals/cases/<id>/` — regression cases from failures that already happened**

Each case: trigger · fixture · assertion · provenance (`run <id>` /
`assessment <hash>`). Seed from the six documented, reproducible failures —
`approvalMode`-headless-inert, no-disposition-redispatch, partial-workspace-
strategy, 200-and-do-nothing, wrong-adapter-keys, adapter-list-separator. Wire
into `npm run check`.

This is what converts a narrative lesson into something that *stays* fixed.

**3 · `factory retro <issue>` — the reader (read-only)**

At terminal state, pulls the run ledger + `AssessmentV1` + `ExecutionReceiptV1`
and emits: reconciled-vs-reported cost, per-criterion verdicts, stop reason, and
a claims-vs-evidence diff. Appends the LEDGER row and drafts a candidate lesson
into `evals/candidates/` with its provenance attached.

**It never writes `instructions/src/`, `evals/cases/`, or any expected output.**

**4 · The gate**

```
candidate  →  you read it  →  eval case  |  doctrine line  |  discard
```

Nothing auto-promotes. The proposer cannot move the bar that judges it. This is
the single invariant that prevents the number going up while the system goes
down, and it is why I did not recommend auto-promotion.

**5 · Session capture (`.remember/` → ledger)**

Most durable knowledge here came from operator sessions, not factory runs —
`OPERATIONS.md §0` exists because of five bad sessions; the factory has run 21
times. `.remember/` already captures session history and is unintegrated. Add
one lightweight path: when a session establishes a **verified** fact (executed,
not read), it appends a LEDGER row with the same provenance discipline. Same
gate; no separate store.

### Deliberately NOT built

- **No vector store, no graph, no semantic retrieval.** The corpus is ~10
  documents and ~21 runs. `grep` and a markdown table beat embeddings at this
  scale; escalate only on a measured retrieval failure.
- **No OMP `memory.backend`, no `autolearn`.** OMP treats memory as *heuristic
  context that may be overridden* — a safety invariant placed there is a hint.
  Invariants belong in doctrine, which is git-tracked, compiled, and hash-pinned.
  Keep both off.
- **No skill curator.** The weekly curator on `gemini-3.7-flash` with
  `prune_builtins: true` has already deleted capability once. At this volume,
  deletion is a manual decision.

---

## P2 — worth knowing, not worth stopping for

- **Cost is dominated by cache reads of the resident prompt.** The $3.789 run
  shows **3,933,440 cache-read tokens vs 44,582 output** — ~100 turns re-reading
  a ~39K standing prompt. The 73–79% bundle reduction already attacks exactly
  this and is the right lever; the LEDGER is how you prove it worked.
- **Monthly budget reset gives no protection across a month boundary.** The two
  incidents landed 08-31 and 09-01 — consecutive days, different budget months,
  each individually well under the $40 cap. Not a bug; a property worth knowing.
- **Delegation policy contradicts the canary boundary.** `task: "@code-bulk"` →
  deepseek (metered) plus *"DELEGATE SEPARABLE WORK BY DEFAULT"* in the Engineer
  bundle, against *"one worker, no paid nested fan-out."* Unresolved since 09-02.
- **`Hermes Generalist` is live but unmanaged** by `factory.config.json`, so
  `factory diff` will never report drift on it. Budgets were created by hand.
- **Run diagnostics are unreachable.** The recovery record says *"failure details
  were withheld from the issue thread; inspect the linked run"* — and no HTTP
  route serves run logs (`/api/runs/<id>/logs` → 404). You see `blocked` with no
  reason. `factory retro` should surface `logBytes` content if a route exists.
- **[H] issue-level timeout may not reach the run.** ZEI-2 declares
  `timeoutSec: 900`; the run reported `effectiveTimeoutSec: 1800`
  (`timeoutSource: "config"`). Verify before trusting per-issue time limits.

---

## Migration order

Each phase gates the next.

**Phase 0 — Stabilize** *(operator-authorized; no new code)*
0.1 Stop the untracked `:3101` server; restart the tracked instance from
    `factory-stack`. → `ops/paperclip-status.sh` exits 0
0.2 Merge `feat/context-architecture` → master. → `npm run check` green at 348+
0.3 Fix `fallbackChains` in **both** `~/.omp/agent/config.yml` and
    `omp/base.overlay.yml`.
0.4 Re-run `factory diff`. **Gate: zero `[removing …]` clauses.**

**Phase 1 — Failure classification** *(small, mechanical)*
Run the P0-4 discriminating test first. Then classify transport vs reasoning in
one place; `adapter_failed` raises to operator instead of re-dispatching; assert
the goal-guard covers the disposition side. Tests kill their mutants.
Files: `lib/preflight.js`, `lib/goal-gate.js`, new `test/unit/failure-class.test.js`

**Phase 2 — The reader**
`docs/LEDGER.md` + `bin/factory retro` (new `lib/retro.js`). Read-only. Reuse
`lib/api.js` for reads, `lib/execution-receipt.js#objectiveFromSpecDocument` and
the existing `documents/spec` fetch rather than writing new resolution.
**Backfill the 21 existing runs** — the ledger starts with real history, not empty.

**Phase 3 — Eval cases**
Seed `evals/cases/` from the six known failures; wire into `npm run check`.
**Gate: each case goes red when its guard is deleted.** Given
`promote-run.test.js` kills 0 of 18, prove the mutant, don't assume it.

**Phase 4 — Session capture**
`.remember/` → verified-fact path into the LEDGER, same gate.

**Phase 5 — Canary**
Only now dispatch ZEI-2. The ledger records it. This is the first row that
proves the loop, and the first data point toward *three consecutive accepted
outputs*.

---

## Verification plan

| Layer | Check |
|---|---|
| Baseline | `npm run check` on master post-merge — 348+ pass, compile clean |
| Live state | `ops/paperclip-status.sh` exits 0; exactly one `paperclipai run` |
| Reconciliation | `factory diff` shows no destructive deletions |
| Routing | test asserting both `fallbackChains` byte-identical, no lane leads above ceiling |
| Retry | one fixture per failure class, each killing its mutant |
| Reader | `factory retro ZEI-1` reproduces $4.68 / $0.89 from `usageJson` — checkable against a known answer |
| Eval integrity | delete the guard a case protects → the case goes red |
| Loop | one canary produces a LEDGER row and a candidate, and writes nothing to `instructions/src/` |
| Cost | LEDGER cache-read column before/after the bundle reduction |

**Stop condition:** if a candidate lesson is ever found written directly into
`instructions/src/` or `evals/cases/` by a tool rather than by you, the gate has
failed — stop the loop and fix the write path before continuing.

---

## Justified as-is — leave these alone

Each names a failure it prevents *and* has evidence it works:

- **The four-file doc topology + precedence rule.** Correct tier separation,
  built last night, working. Do not restructure.
- **`CLAUDE.md` at 13 lines / 3 invariants.** Every line passes the rent test.
- **Bubblewrap containment.** 15 escape tests pass; ZEI-2's worktree provisioned
  correctly at `/home/lucascoh/.paperclip/worktrees/canary/paperclip/ZEI-2`.
- **`lib/api.js#mutate` readback discipline.** Guards a verified live defect class.
- **Plan-hash-gated apply + immutable receipts.** Makes "I reviewed this exact
  change" mechanical.
- **`ops/paperclip-status.sh`.** It caught the two-server condition correctly
  and failed closed. I misread its exit code initially; the guard is sound.
- **OMP memory and autolearn, off.** Keep them off, deliberately.
- **The `base.overlay.yml` freeze mechanism.** The right idea — it just froze a
  defect. Fix the content, keep the pattern.

## Uninvestigated

Not examined; distinct from "fine": `lib/promote.js` internals beyond the
recorded defects · `lib/handoff.js` (586 lines, new) · `lib/materialize.js` ·
the Hermes profile and `ops/hermes-bwrap.sh` · the `paperclip-goal-guard`
extension source · `omp/{engineer,reviewer}.policy.yml` contents · the 7
findings from the 12pm audit (I took them as reported, not re-verified) ·
`contracts/objectives/ZEI-1.json`.

## Unknowns

- **What actually emits the 3×3 retry burst** — Paperclip scheduler vs adapter.
  Named test in Phase 1.
- **Why the ZEI-2 adapter fails.** No log route found; `logBytes: 3721` exists
  and is unreachable over HTTP. Narrowed (see below) to the Paperclip→adapter
  launch seam, since preflight passes all six gates. Still the thing standing
  between you and a completed canary.
- **Whether `usageJson.costUsd` is accurate.** One document reports OMP's
  self-reported cost understates a measured model by 2×. Never reconciled
  against provider billing. The LEDGER should carry reported and reconciled as
  separate columns until this is settled.
- **Whether per-issue `timeoutSec` reaches the run** (P2 above).

## What would change this analysis

I tested the one hypothesis that would have collapsed this plan — that the ZEI-2
adapter failure and P0-2 were the same problem — and **it is disproven.**

`factory preflight ZEI-2` from the branch tree **passes all six gates [V]**:
read-only verifier, both OMP agents launch with policy and flags accepted,
`paperclip_review` registered, reviewer cannot spawn subagents, Hermes launches,
Paperclip healthy. And the OMP profiles **are** materialized
(`~/.omp/profiles/paperclip-{engineer,reviewer}`, written 14:03 today) — which
also contradicts the newest doc's claim that `materialize --apply` was deferred
as an unauthorized live effect. Another live-vs-document divergence; the live
state wins.

**What this narrows:** the OMP-side configuration is sound. The failure lives in
the Paperclip→adapter launch path — the gap between "OMP launches with these
flags from the CLI" and "the adapter launches OMP inside a run." Preflight does
not cover that seam, which is the most useful thing this probe established.

Two candidates worth testing first in Phase 5, cheapest first:

1. **The dispatching server is stale.** `:3100` has been up since 09-01 02:02
   running the binary from `factory-finalization`; adapter plugins load at
   server start. Restarting it (Phase 0.1) may be the entire fix — which is one
   more reason Phase 0 comes first.
2. **Something writes the engineer profile during failed runs.**
   `~/.omp/profiles/paperclip-engineer` has mtime 14:47 today — exactly the
   window of the third failed burst. Worth understanding before dispatching again.

If Phase 0.1 alone clears the adapter failure, Phase 5 moves up and the canary
can run as soon as Phase 2's ledger exists to record it.
