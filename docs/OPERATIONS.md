# Factory Operations

How to operate the system: the methodology traps that cost five wrong
sessions, verified adapter and server facts, environment gotchas, what is
proven vs not, the acceptance boundary, promotion criteria, and resuming
rules. Read the preamble first.

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

## 11b. Rolling out the three-role context architecture

This is the ordered rollout for the Hermes Generalist → OMP Engineer → OMP
Reviewer lane. Every step is offline until the one that says otherwise. Nothing
here is a standing authorization: `factory apply`, live agent creation, gateway
lifecycle changes, and any billed dispatch require explicit operator approval at
the moment they are run.

### Offline acceptance — do all of this first

```bash
npm run check                      # full suite + instruction compiler check
bash instructions/compile.sh --check
factory materialize --check        # profile templates vs the live profile roots
factory preflight ZEI-1            # launch/config probe; unbilled, not readiness
```

`factory materialize --check` is byte-read-only and makes no network call. It
reports every OMP and Hermes profile target as `create`, `update`, or `ok` and
exits non-zero unless all are `ok`. It refuses to overwrite a profile file an
operator has edited; that refusal is a decision for you, not a failure to
retry. Run `factory materialize --apply` once you accept the diff — this writes
only inside the profile roots, never into the repository, and never stores a
credential.

`factory preflight` proves the argv each adapter builds actually reaches its
CLI: the OMP gates prove the Engineer's and Reviewer's tools, skills, overlays,
profile, and `--no-rules` resolve, and prove `task` is denied to the Reviewer in
both layers; the Hermes gate probes `hermes chat --help` only, so it bills
nothing. A pass means the configuration is launchable. It is not proof the loop
works.

### The one authorized apply

Reconcile the live control plane exactly once per reviewed change:

```bash
factory plan                                  # read every action and the hash
factory apply --plan-hash <hash>              # only after operator approval
```

The plan hash covers desired AND observed state, so a plan that no longer
matches reality refuses rather than applying something you did not read. After
the apply, verify the live readback yourself — HTTP success is not persistence —
and retain the immutable receipt under `receipts/`. `factory rollback --receipt
<id>` restores the pre-state and verifies it independently.

### Canary order — direct lane first, Hermes second

1. **Engineer → Reviewer canary.** Dispatch one bounded issue straight to the
   OMP Engineer, with Hermes out of the path entirely. This must produce: a
   goal gate whose `goalStatus` is `complete` and `terminal` is true, a framed
   execution receipt bound to the objective's exact revision and hashes, an
   independent Reviewer assessment, and a reconciled cost. Hermes is not the
   normal route for anything until this passes.
2. **Hermes → validated child → Engineer → Reviewer canary.** Only after the
   first canary passes. Give Hermes genuinely ambiguous work and require it to
   reach the Engineer solely through `factory handoff`. This must produce an
   `EngineerHandoffReceiptV1` with a verified readback, a child that blocked the
   parent until completion, and derived identifiers, branch, criterion ids, and
   hashes that Hermes never authored.
3. **Only after both pass**, make Hermes the normal route for ambiguous work.

A failed canary leaves the factory at HOLD. Report the exact failed invariant
and its evidence; do not re-dispatch to see whether it passes the second time.

### What the goal gate means for a failed attempt

A run with no verified `goal.complete` gate cannot produce ready-for-review
claims, and the control plane refuses it rather than forwarding it. That is the
intended behaviour, not a defect to route around. An attempt that legitimately
cannot finish still reports: `blocked`, `failed`, and `cancelled` receipts are
admissible without a gate, and a gate can never upgrade one of them to
ready-for-review.

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
