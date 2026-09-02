# Build History and Incident Log

> **This file is DATED EVIDENCE, never current state.** It records what was
> true at specific commits and what was learned the hard way. It must not be
> used to justify a claim about the system as it stands — verify against the
> current repository and live semantic readback.

Copies outside the repository are untracked mirrors. Entries were
accumulated across multiple 2026-09-01 snapshots and do not share one
repository commit or live-state boundary; treat dates, commits, and commands
attached to individual claims as their evidence scope.

---

## 4. Historical state snapshot — verified 2026-09-01

This section records the state at commit `74d3eff`; it is not a current-status
dashboard. Re-run the named checks and inspect live state before using it.

- **Repository:** `/home/lucascoh/factory-stack`, branch `master`, commit
  `74d3eff`. The `feat/factory-finalization` worktree was merged
  (fast-forward) and is no longer the working location.
- **Tests:** 139 pass, 0 fail, 0 skipped (`npm test`).
- **Instruction bundles:** `instructions/compile.sh --check` clean.
- **Live Paperclip:** healthy at `127.0.0.1:3100`. Company `ZEIROS`.
- **At this snapshot,** `factory apply` had not been run and no `receipts/`
  directory existed. This does not establish that no other live mutation had
  occurred.
- No authorized functional Engineer/review/promotion canary had completed. The
  later six-run corrective-dispatch incident is recorded in §5c.
- The factory was at **HOLD** at this snapshot.

### Build state by section

| Section | State | Meaning |
| --- | --- | --- |
| §1 Preserve/checkpoint | Complete | Artifacts hash-verified; Paperclip pinned |
| §2 Declarative reconciliation | Complete | `factory plan/apply/rollback`, tested, works live |
| §3 Sandbox + guard | Complete | 15 escape tests pass; bwrap 0.6.1 confirmed working |
| §3 Lifecycle wrappers | Complete | `ops/paperclip-*.sh` |
| §3 Backup/restore proof | Complete | Proven against a throwaway DB, live counts matched |
| §4 Schemas/instructions | Complete | Objective/Receipt/Assessment schemas + compiled bundles + manifest |
| §5 Review | Complete | `lib/review.js`, `paperclip_review` custom tool loads |
| §5 Promote | **Written, not trustworthy** | `promote.run` exists; see §7 |
| §6 Tests/canary | Partial | Unit/integration exist; **live canary never run** |
| §7 ZEI-1 | Not started | Blocked behind the canary |

### The uncommitted working tree is deliberate WIP, not scratch

`lib/promote.js`, `lib/review.js`, `lib/execution-receipt.js`, the two schema
files and three test files are uncommitted mid-Task-5 implementation, left when
a session was cut off. **Do not discard them as abandoned scratch work.** See §7
for the defects they still carry.

### The one honest headline

**The loop has never run end to end.** Everything above is mechanism plus unit
tests. Until one task goes Engineer → Reviewer → promote against a disposable
fixture, every claim about whether this system *works* is a hypothesis.

---

### The false conclusion, recorded so it is not repeated

Commit `4e7c1a6` moved `configFiles`/`hooks`/`tools` into `extraArgs` and
declared `approvalMode`, `autoApprove`, `configFiles`, `hooks`, `tools`,
`pluginDirs` "retired: inert on this adapter — they appear ZERO times." That was
measured against `adapter-pi-local` (**wrong product**). All six are read by the
real adapter.

Because those keys were kept "managed but undeclared", the next `factory apply`
would have **deleted them from the live agents** — including the Engineer's
policy overlay and worktree guard, which were live and working the whole time.
The accompanying claim that the Engineer "ran with no policy overlay and no
worktree guard" was false.

Reverted in `74d3eff`. The proof it was wrong: correcting the config dropped
`factory plan` from *6 actions deleting 7 keys* to *6 actions deleting none*.

## 5c. Cost incidents

- **2026-08-31 — ZEI-1 runaway: ~$5.57 across six runs in ~10 minutes, zero
  repository writes.** The full mechanism, because no single piece looks
  dangerous alone:
  1. `approvalMode: write` on a headless agent (Paperclip runs OMP `--mode json
     -p`). Every exec-tier tool fails with *"requires approval but no
     interactive UI available"*.
  2. The run nevertheless **exits 0** and is recorded `succeeded`.
  3. The issue is therefore left `in_progress` with no disposition.
  4. The server's successful-run handoff creates a **corrective run** — and the
     loop repeats, bounded only by the $40 agent cap (~2 hours).

  The fix is mechanical confinement, not approval: `approvalMode: yolo` plus the
  strict `--config` overlay and the worktree guard. `omp/engineer.policy.yml`
  records this in full. Note `bash.patterns` governs the `bash` tool ONLY —
  `eval` spawns a shell by another path, so `tools.approval.eval: deny` is
  required too; removing one without the other reopens the hole.
- **~$1.82 of "startup" was 86% waste.** Real invocation cost was ~$0.25 (a
  cache-write of a 39,415-token standing prompt); the other ~$1.57 was 22 turns
  re-reading that same prompt. Keep the resident prompt small — skills should be
  loaded per task, not all-resident.
- **The same incident was then mis-attributed** by a later agent (reported as
  ~1% of cost when it was ~61%). Reconcile cost against the run ledger
  (`usageJson`) rather than estimating it.
- **Standing rule:** billed dispatch requires explicit operator approval, every
  time. Unknown or unreconciled cost is not zero.

## 5e. Claims that were investigated and are FALSE

Recorded so they are not rediscovered and re-acted upon:

- **"`instructions/compile.sh --check` silently performs live writes."** This was
  TRUE on 2026-08-31 — the flag was ignored and the live publish path ran,
  mutating agent metadata timestamps (bytes were identical, but it was an
  unauthorised write). It was then fixed. **Verified 2026-09-01: the current
  script contains no `curl` or HTTP call at all** and does only
  `cmp`/`sha256sum`/`grep` locally. Kept here because the historical claim is
  still repeated in old handoffs: check the script, don't re-act on the report.
  The general lesson stands — *a flag named `--check` is not evidence of a dry
  run; read the code.*
- **"`adapterConfig.tools`/`configFiles`/`hooks`/`pluginDirs`/`approvalMode`/
  `autoApprove` are inert"** — FALSE; see §5.
- **"The adapter hardcodes `--tools read,bash,edit,write,grep,find,ls`."** FALSE
  for this adapter; it hardcodes nothing and emits `--tools` only when the key is
  set.
- **"`extraArgs` is the only key that reaches the OMP CLI."** FALSE; it is one of
  many, appended last.

## 7. Known defects and open work

### `factory promote` — reported by an independent review, NOT yet re-verified

Treat these as **credible but unconfirmed**; reproduce each before fixing.

1. **No authentication of who wrote the assessment.** `promote` checks the
   assessment's hash, schema, and objective binding, but never that it came from
   a *Reviewer run by a different agent*. If an Engineer's run-scoped token can
   write documents on its own issue, it could write its own all-PASS assessment
   and self-approve. **Open question: the actual token scope — check the server
   source before acting.**
2. **`fileHash` decodes as UTF-8**, so invalid bytes all become U+FFFD and
   structurally different files hash identically (collision demonstrated). Fix:
   hash the raw `Buffer`.
3. **Broken symlinks hash to `null`**, indistinguishable from "deleted". A
   symlink can be committed as a reviewed "deletion" and retargeted after
   approval with no race. Fix: `lstat`, hash `readlink` for symlinks, use a
   distinct sentinel for deletions, reject targets escaping the worktree.
4. **The commit's contents are never verified** — only the path *names*. `git
   add` applies filters (`.gitattributes`, `core.autocrlf`) and hooks run, so
   committed blobs can differ from reviewed bytes (demonstrated with CRLF). Fix:
   re-read the commit tree and assert each blob hash; `--no-verify`;
   `--literal-pathspecs`.
5. **Post-commit failure leaves unresumable state.** The commit is minted before
   five later steps; any failure leaves a commit plus a receipt claiming
   `outcome: "promoted"`, and re-running fails `assertBaseCommit`.

### Test quality

`promote-run.test.js` kills **0 of 18** security gates. `execution-receipt.test.js`
kills 4 of 17. Fixing these tests matters as much as fixing the code.

### Live configuration

The live Engineer's `command` is `"omp"` — **the raw binary. It is not
sandboxed.** Running `factory apply` is what puts it behind `ops/omp-bwrap.sh`.
As of `74d3eff` the apply is non-destructive (deletes no keys).

---

## 8. Next actions — strict order

1. **Re-verify and fix `promote` defects 2–4** (local, small; each needs a
   failing test first).
2. **Resolve defect 1** — read the server source for run-token document/status
   scope, then decide.
3. **Give `promote.run` real tests** — every gate must kill its mutant.
4. **`factory apply`** from the primary tree; read the diff; confirm readback.
5. **Run the disposable canary** (§6 of the roadmap): isolated external
   worktree, bounded Engineer edit, denied escape, deterministic verification,
   independent review, controlled promotion, cancel/restart recovery, unchanged
   source fingerprint, cost ≤ $1 reconciled against provider billing.
6. **Only then** preflight and dispatch ZEI-1, once.

Any mismatch leaves the factory at HOLD.

---
