# Factory Executive Master Knowledge Base

**Purpose:** dated incident and implementation evidence. This file is not
canonical current state; verify operational claims against the current
repository and live semantic readback. Copies outside the repository are
untracked mirrors.

The entries were accumulated across multiple 2026-09-01 snapshots and do not
share one repository commit or live-state boundary. Treat dates, commits, and
commands attached to individual claims as their evidence scope.

---

## 0. READ THIS FIRST — how this project has actually gone wrong

Five consecutive agent sessions produced confident, wrong diagnoses here. Not
one was a coding mistake. Every one was the same methodological failure:

> **Reading code that does not run, and reporting it as fact.**

This system has a large surface of plausible-looking-but-wrong sources: comments
that assert guarantees the code does not provide, a `node_modules` full of
adapters that are *not* the one in use, minified bundles, and tests that pass
without testing anything. If you reason from those, you will produce a
detailed, well-cited, entirely fictional bug report. That has now happened
repeatedly, and each time it cost a night and moved the project backwards.

### The rule

**Before claiming any component does or does not do something, execute
something that proves it.** Run the code. Curl the live API. Grep the package
that is actually loaded. Mutate a line and confirm a test fails.

State your confidence explicitly, every time:

- **Verified** — "I ran this and observed the output."
- **Read** — "I read this in the source that I confirmed is loaded."
- **Inferred** — "I am reasoning from adjacent facts." *Inferences are hypotheses.
  Label them. Never build a conclusion chain on one without saying so.*

### The traps, concretely

**1. THE WRONG ADAPTER. This is the big one.**

The agents have `adapterType: "omp_local"`. They run on a **third-party plugin**:

```
~/.paperclip/adapter-plugins/node_modules/@zhafron/paperclip-omp-adapter
```

`node_modules/@paperclipai/adapter-pi-local` is for **pi**. **Oh My Pi (OMP) and
pi are different products.** Reading `adapter-pi-local` to reason about these
agents is reading the wrong file, and it produced the single most expensive
false conclusion in this project's history (see §5).

**2. Comments in this repo have been confidently wrong.** Several long
`$comment` blocks and code comments asserted hard guarantees that the code did
not implement. Treat every comment as a claim to verify, not as evidence — this
document included.

**3. The Paperclip server ships no `src/`.** Do not grep the 19MB minified
bundle. Full TypeScript is recoverable from the sourcemap:

```js
const m = JSON.parse(fs.readFileSync(
  "node_modules/paperclipai/dist/index.js.map", "utf8"));
m.sources.forEach((s, i) => { /* write m.sourcesContent[i] */ });
```

Read the `.map` with `readFileSync` + `JSON.parse`; `require()` throws on it.
(OMP itself is different — it *does* ship `src/`.)

**4. A passing test suite here has meant very little.** A mutation campaign
found `promote-run.test.js` killed **0 of 18** of its own security gates: you
could delete the approval check, the base-commit check, or the diff comparison
and the whole suite stayed green. Before trusting a test, delete the line it
claims to protect and confirm it goes red.

**And confirm the mutant actually landed.** Two mutation checks here "passed"
while testing nothing: a `sed` whose delimiter collided with the pattern (so the
edit never applied), and a removal-drift test whose signal was masked by other
drift. Re-read the file after mutating it, before believing the result.

**5. Failures are frequently silent — and the same class of mistake has opposite
visibility.** Passing an *invalid* OMP tool name (e.g. `ast-grep`) is a loud,
fatal `CliUsageError` at launch. A *custom plugin tool that throws during its own
module load* is dropped silently and yields the generic `Unknown tool in --tools`
— identical to a tool that was never found. Two independent root causes behind
one error string: fixing the flag alone left the message unchanged because
`FACTORY_ROOT` was also wrong. A synthetic probe passed while the real plugin
still failed, which is the only reason it was caught. Also: a `--config` overlay
pointing at a missing file is a hard startup error, and Paperclip can return
HTTP 200 and change nothing.

**6. A fake can encode the same wrong assumption as the code.** `apply.test.js`
had a fake returning `latestBody` because the client wrongly expected
`latestBody`, so the test passed while the real API would have failed. When you
write a fake, mirror the **shipped** response shape, confirmed from source —
otherwise the test proves only that the code agrees with itself.

**7. Approval-gating buys zero safety in headless runs.** `approvalMode: write`
made the Engineer inert: every exec-tier tool failed with "requires approval but
no interactive UI available". It converts risky actions into impossible ones and
the agent loops retrying. `prompt` is not a middle setting headless — it is a
denial with a worse error message. Boundaries here must be **mechanical**
(sandbox, tool allowlist, policy overlay), never approval prompts.

**8. Check the working tree is what you think.** `lib/review.js` was git-binary
for three commits because of one stray NUL byte, so its diffs were unreviewable
and nobody noticed. `cd` inside a Bash tool call persists between calls.

---

## 1. Mission

Build a local-first, low-operator-attention software and agent factory that
converts bounded objectives into verified changes, artifacts, decisions, or
operational outcomes.

The optimization target is **valuable unattended progress per unit of founder
attention** — not agent count, autonomy, model sophistication, or orchestration
complexity. Work is successful only when the requested terminal outcome is
proven by evidence and accepted under the required policy.

---

## 2. Settled architecture

```
Founder / Board
      │
      ▼
Paperclip — sole company control plane
      │
      ├── bounded technical objective ──► OMP Engineer
      │                                      │
      │                               uncommitted worktree diff
      │                                      │
      │                       deterministic verification
      │                                      │
      │                        independent OMP Reviewer
      │                                      │
      │                        controlled human promotion
      │
      └── future mixed objective ───────► Hermes ──► OMP if needed
```

- **Paperclip** owns objectives, issues, assignment, schedules, budgets,
  approvals, status, retries, recovery, and audit. It is the only control plane.
- **OMP** is the bounded technical execution runtime. The Engineer produces
  work; the Reviewer independently assesses it.
- **Hermes is deferred.** Add it only after the direct Paperclip → OMP lane is
  proven, and only for mixed/ambiguous/research objectives.
- **Git** owns code, tests, documents, schemas, committed artifacts.
- **Deterministic validators** establish mechanically observable facts. A
  model's claim is not evidence when reality can be inspected.
- **Human approval** controls final promotion.
- **Provider limits** are the authoritative financial boundary.

Do not revive Conductor, add Temporal, build a competing RPC/control plane, or
introduce a second task database or scheduler.

---

## 3. Non-negotiable operating principles

1. **The executor cannot certify itself.** Producer output requires independent
   evidence and, where policy requires, independent review.
2. **Mechanical reality outranks model judgment.** Tests, type checks, schemas,
   hashes, Git state, API readback, and filesystem inspection outrank summaries.
3. **HTTP 200 is not success.** Read back and compare semantically.
4. **Exit code 0 is not success.** OMP success depends on stop reason, evidence,
   and acceptance state.
5. **Instructions are not security boundaries.** Enforce invariants with
   capability restrictions, schemas, sandboxing, hooks, worktrees, readback,
   and budgets.
6. **Current truth beats memory.** Memory may preserve procedures, never
   override live state, repository state, objective revision, or evidence.
7. **Every objective reaches an explicit terminal or intervention state.**
8. **One authority per concern.**
9. **Fail closed.** Missing configuration, unknown cost, stale evidence, partial
   strategy, changed diff, missing criterion, or ambiguous authority blocks.
10. **Complexity must earn its place.**
11. **Verification outranks analysis.** A claim you have not executed is a
    hypothesis. Reading more source is not a substitute for running one command.
    (Added 2026-09-01 after five sessions of the opposite.)

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

## 5. Runtime truth — the OMP adapter (VERIFIED)

This section exists because getting it wrong cost more than any other error.

The agents are `adapterType: "omp_local"`, served by
`@zhafron/paperclip-omp-adapter` v0.1.3 (external plugin, installed under
`~/.paperclip/adapter-plugins`). It builds the OMP command line from
**first-class `adapterConfig` keys** in `dist/server/execute.js`:

| `adapterConfig` key | OMP flag | line |
| --- | --- | --- |
| `model` | `--model` | :137 |
| `thinking` | `--thinking` | :139 |
| `tools` | `--tools` | :153 |
| `skills` | `--skills` | :155 |
| `approvalMode` | `--approval-mode` | :157 |
| `configFiles` | `--config` (repeatable) | :188 |
| `extensions` | `--extension` (repeatable) | :190 |
| `pluginDirs` | `--plugin-dir` (repeatable) | :192 |
| `hooks` | `--hook` (repeatable) | :194 |
| `extraArgs` | appended verbatim, **last** | :215 |

Critical properties:

- **Nothing is hardcoded.** `--tools` is emitted *only* when `tools` is
  non-empty. Leave it unset and OMP uses its own default tool set, which
  includes write access.
- **`autoApprove` defaults to TRUE** (:159). With no valid `approvalMode`, the
  adapter adds `--auto-approve` by itself. Set both explicitly.
- **`extraArgs` is an escape hatch, not the only route.** It is appended last,
  so it can override earlier flags — but prefer the first-class key, which the
  adapter validates and the operator can read.
- **`env` is read** (and is the one `adapterConfig` key Paperclip's server
  validates, via `envConfigSchema`; a plain string is a valid binding).
- **`paperclipSkillSync` / `GET /api/agents/<id>/skills` is Paperclip's own
  skill-symlink mechanism, which this adapter does not implement.** For these
  agents, `adapterConfig.skills` is the real key.

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

### OMP custom-tool discovery (VERIFIED)

Layouts are **per provider** and not interchangeable:

| Provider | Reached by | Layout accepted | Tool name from |
| --- | --- | --- | --- |
| `claude-plugins` | `--plugin-dir` | `tools/<name>.{ts,js}` flat, non-recursive | filename |
| `omp-plugins` | `--extension` | flat **and** `tools/<name>/index.ts` | directory basename |
| `builtin` | `~/.omp/agent/tools`, `<cwd>/.omp/tools` | flat **and** nested | directory basename |

`omp/plugins/paperclip-review` uses the nested layout, so it **must** go through
`--extension` (the `extensions` key). `--plugin-dir` globs non-recursively and
cannot see it.

Also true and load-bearing:

- **The tool module is executed at discovery.** Anything that throws at load
  (bad relative path, missing dep) makes OMP drop the tool **silently**, with
  the identical `Unknown tool in --tools` error as a discovery miss. Always
  distinguish "wrong flag/layout" from "module failed to load".
- `FACTORY_ROOT` in the tool is **five** levels up from
  `omp/plugins/paperclip-review/tools/paperclip_review/index.ts`. It was four,
  which broke every `require` at load. A load-time assertion now names the
  resolved path instead of failing mysteriously.
- `--tools` does `result.tools = names` — **assignment, so the last one wins**.
- `ast-grep` is **not** a valid OMP tool name; passing it is a fatal
  `CliUsageError`. Valid names in use: `read, grep, glob, lsp, todo`, plus the
  custom `paperclip_review`.

---

## 5b. Paperclip server behaviours learned the hard way (VERIFIED)

- **Documents API renames on the wire.** The JSON field is `body`; the database
  column is `latestBody`. A GET **never** returns `latestBody`. Pinned by
  `test/unit/documents-api-shape.test.js`. A client expecting `latestBody` reads
  `undefined` and silently compares nothing.
- **`enableIsolatedWorkspaces` defaults to FALSE**
  (`validators/instance.ts:44`), and while disabled the server literally
  `delete`s `executionWorkspaceId`, `executionWorkspacePreference` and
  `executionWorkspaceSettings` from the payload, then returns a normal 200 with
  the full issue object (`@paperclipai/server/dist/services/issues.js:5313-5317`;
  the same guard repeats at :5610 and :5850). **Trust that 200 and the next
  dispatch writes straight into the operator's uncommitted work while believing
  it is isolated.** Live value is currently `true`; re-check before any dispatch.
- **`enableWorktreeRunExecution` must stay false** for the ZEI-1 boundary.
  Currently `false`. Both flags are readable at
  `GET /api/instance/settings/experimental`.
- **An issue-level `workspaceStrategy` REPLACES the project strategy**, it does
  not merge. A partial strategy silently drops branch and external-worktree
  settings. The config loader now rejects partial `git_worktree` strategies
  before mutation.
- **`adapterConfig` is stored opaquely** (`z.record(z.string(), z.unknown())`)
  with exactly one exception: `env`, validated against `envConfigSchema`. So the
  server will accept almost any adapterConfig key — its presence proves nothing
  about whether anything reads it.
- **A successful run with no disposition is AUTOMATICALLY RE-DISPATCHED.** When a
  run exits 0 but leaves no clear next step, the server logs
  `issue.successful_run_handoff_required` and creates a **corrective run**
  (`services/heartbeat.js:7026`). This is the engine of the runaway loop in §5c:
  anything that makes an agent finish without reaching a terminal disposition
  does not fail safe — it re-dispatches, repeatedly, until a budget cap stops it.
  **Every objective must reach an explicit terminal state; this is enforced by
  billing, not by politeness.**

### Where to read the server's real code

The two packages are different and the technique differs:

- **`@paperclipai/server`** — ships readable `dist/` JavaScript. Just read it:
  `node_modules/@paperclipai/server/dist/services/issues.js`,
  `.../services/heartbeat.js`, `.../routes/*.js`. This is where issue, run,
  workspace and heartbeat behaviour lives.
- **`paperclipai`** (the CLI) — minified. Recover TypeScript from
  `dist/index.js.map` `sourcesContent` (§0, trap 3). This is where validators,
  schemas and adapter-utils live.

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

## 5d. Environment gotchas (this machine, WSL2)

- **Bubblewrap mount order is load-bearing.** `--tmpfs /tmp` must come *after*
  the worktree's bind, or it silently masks any worktree living under `/tmp`.
  Mutation-tested: flipping the order flips the test result.
- **Do not redirect `HOME` inside the sandbox without checking Python.** Doing so
  broke user-site resolution, so every `pytest` invocation returned `No module
  named pytest` — six false BLOCKED verdicts from a sandbox that merely looked
  stricter than intended. A tool that cannot run is not a failing test.
- **`chmod +x` can fail on this filesystem.** Invoke scripts as
  `bash scripts/foo.sh` rather than executing them directly.
- **Watch for orphaned `paperclipai onboard` processes.** One left running in the
  background became the parent of the embedded Postgres; hours later it died and
  took the database with it, and the real foreground server (untouched, still
  alive) began returning 503. After any setup command, confirm no orphan remains.
- **OMP ships its full TypeScript `src/`** — read that, never the ~19MB minified
  `dist/cli.js`.
- **Some integration tests cannot run inside a managed agent sandbox.** Nested
  `git` and bwrap netlink setup fail with `EPERM`, which reads as a broken test
  suite when the suite is fine. Re-run outside the sandbox before believing a
  failure.

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

## 6. What is proven, and what is not

### Proven by execution

- **Declarative reconciliation.** `snapshot → dry-run diff → allowlisted write →
  exact readback → immutable receipt`. Resolves live objects by stable
  identifier, never hardcoded UUIDs. `apply` requires `--plan-hash`, so a plan
  that changed since you read it is refused.
- **Two live defect classes are guarded:** *200-and-do-nothing* (confirmed for
  agent `instructionsBundle` and issue execution-workspace fields), and *issue
  strategy replaces rather than merges* (a partial `git_worktree` strategy would
  silently drop branch and external-worktree settings; the loader now rejects
  partial strategies before mutation).
- **Containment** (15 tests, on a disposable fixture): writes inside the
  assigned worktree succeed; writes to the primary tree, shared `.git/objects`,
  and `/etc` fail; `git commit` fails; symlink escape fails; the operator's
  uncommitted file stays byte-identical; `AWS_*`/`GITHUB_TOKEN` stripped;
  `ANTHROPIC_API_KEY` preserved. `bwrap` 0.6.1 works in this WSL environment.
- **Backup restore** proven into a throwaway database, counts matched live,
  scratch DB dropped.
- **Both agents launch.** `factory preflight ZEI-1` passes all four gates
  against the real OMP binary, including `paperclip_review registered` — the
  custom tool genuinely loads via the `extensions` key. The probe names an
  invalid model, so it reaches argument validation and model resolution without
  contacting a provider. **Nothing is billed; run it freely.** It is the cheapest
  way to find out whether a config change actually works.

### NOT proven

- **The end-to-end loop.** Never run. This is the gap that matters.
- **`promote`.** Written; its own tests verify none of its security gates (§7).
- **Network isolation.** Deliberately absent — OMP needs provider access.
  Containment rests on minimal credentials, no production/external-effect
  credentials, allowlisted capabilities, and provider caps.
- **Cost reconciliation against provider billing.** Never performed.

---

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

## 9. Contracts

### Engineer output contract

The Engineer **cannot commit** — shared Git objects are read-only by design. It
must return: an uncommitted diff in the assigned external worktree; base commit
and branch identity; `head == base` in the receipt; exact changed paths and
hashes; commands and deterministic results; OMP session/model/provider lineage;
duration, cost status, warnings, unresolved conditions; and claims separated
from evidence.

Only `factory promote` may stage the exact reviewed paths and create the commit,
after revalidation and human approval. The Engineer must never merge, push,
deploy, publish, or write into the primary tree.

### Review contract

The Reviewer must: receive the exact spec revision, criteria hash, base/diff
hash, deterministic results, and producer lineage; **be from a different model
family**; assess every criterion PASS/FAIL/BLOCKED/UNCERTAIN with evidence; run
acceptance commands in a second read-only verifier; write only the current
issue's assessment through `paperclip_review`; either approve toward human
review or request changes; never modify repository, spec, budget, receipt,
project, or another issue; stop after two rounds and escalate rather than loop.

Approval can never overrule a deterministic failure, stale spec, changed diff,
missing criterion, same-family review, or failed cost gate.

**Note on independence:** it is currently proven by comparing
`FACTORY_ENGINEER_MODEL` / `FACTORY_REVIEWER_MODEL`, two constants in the
Reviewer's `env`. That asserts a property of the config, not of the run. If the
Engineer's `model` changes and the env is not updated, a model could review its
own family while the assessment claims independence. Carrying the producing
model from the run row is the real fix.

### Budget contract

- ZEI-1 time limit hard-enforced at 45 min via `timeoutSec: 2700`.
- The **$4 ZEI-1 limit is not an issue-level hard stop** — Paperclip supports
  company/agent/project budget scopes only. Treat $4 as a promotion-time gate.
- Real hard boundaries: the Engineer's $40 agent budget and the provider cap.
- Unknown or unreconciled cost is not zero, and blocks promotion.

---

## 10. ZEI-1 acceptance boundary

Before dispatch, prove all of: live state freshly re-read and reconciled;
X-Bookmarks base exactly `3cb8238`; no existing `paperclip/ZEI-1` branch or
worktree; the five dirty primary-tree paths and hashes unchanged; worktree
parent external to X-Bookmarks; full issue strategy (type, base ref, branch
template, external worktree parent, provision behavior); isolated workspaces
enabled and worktree-run execution disabled; subscription routes only, one
worker, no paid nested fan-out or metered fallback; Reviewer and human approval
stages active; baseline 127 passing tests; the pinned salvaged defect test red
as expected (18 failed, 127 passed); Engineer scope additive to `bin/` and
`tests/` only; no capture, network business action, publishing, deployment, or
other external effect authorized.

Promotion may include only the exact independently accepted diff. The receipt
must include session lineage, base and promoted commit hashes, changed files,
deterministic outputs, assessment hash, reported/reconciled cost, stop reason,
and explicit fact/conclusion separation. The primary tree must remain
byte-identical.

---

## 11. Promotion beyond ZEI-1

ZEI-1 is only the first proof. Promote the factory to default use only after:
the direct Paperclip → OMP lane succeeds; a later bounded Hermes canary succeeds
without creating a second task authority; three consecutive useful outputs are
independently accepted; cancellation/restart loses or duplicates no
authoritative work; no unauthorized filesystem or external effect occurs;
provider cost reconciles; and no run needs more than 30 minutes of operator
repair.

Keep deployments, production changes, payments, publishing, outbound
communications, CRM writes, and trading out of scope until a separately approved
typed effect boundary provides allowlisted fields, idempotency, approval,
readback, and rollback.

---

## 12. Agent rules when resuming work

- **Read §0 first.** Then verify current state yourself rather than trusting
  this snapshot or a handoff summary: `git log --oneline -3`, `git status`,
  `npm test`, `curl -s 127.0.0.1:3100/api/health`.
- **Work in `/home/lucascoh/factory-stack` on `master`.** The
  `factory-finalization` worktree is merged and superseded.
- **Label every claim** verified / read / inferred. Do not report an inference
  as a finding.
- **Do not trust a green suite.** Mutate the line a test claims to protect.
- Preserve the primary trees byte-for-byte.
- One checkpoint-sized change at a time; run its complete tests; then stop.
- Never infer success from HTTP 200, exit 0, an agent summary, or file existence.
- Never weaken objective requirements, acceptance criteria, authority,
  isolation, review independence, or cost gates to make output pass.
- Never run `scripts/apply-p0.sh` or `scripts/apply-project.sh` — evidence only,
  superseded by `factory apply`.
- Do not enable heartbeats or periodic dispatch while process/database ownership
  is ambiguous.
- **Billed dispatch requires explicit operator approval, every time.** A runaway
  loop cost $5.50 on 2026-08-31.
- If blocked, report the exact failed invariant, the evidence, the safe next
  action, and the required human decision. Do not improvise around a boundary.

---

## 13. Authority and precedence

When sources conflict:

1. Explicit founder decision and the current approved objective.
2. **Live state you just verified yourself** — repository, running server, tests,
   immutable receipts.
3. This document.
4. Newest implementation roadmap and handoff notes.
5. Older architecture comparisons and research.

Handoff summaries from prior sessions rank **below** live state deliberately.
Several have been confidently wrong. If this document and reality disagree,
reality wins — then fix this document in the same session.
