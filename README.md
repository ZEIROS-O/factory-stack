# factory-stack

Control plane for the agent factory. Paperclip is the board; Hermes and OMP are workers.

```
you → Paperclip issue → heartbeat (30s) → spawns a worker CLI → result on the issue
```

## Layout

| Path | What |
|---|---|
| `package.json` / `package-lock.json` | Pins `paperclipai` — never run it via floating `npx` |
| `instructions/bundles.json` | Machine-owned bundle composition: roles, fragment order, byte caps |
| `instructions/src/` | Source fragments — `_core.md` plus role and contract files. Compiled into each agent's `AGENTS.md`; never edit `out/` |
| `instructions/compile.sh` | Compiles the three bundles (mode 0444) + SHA-256 manifest; `--check` is byte-read-only and never publishes |
| `docs/` | `FACTORY_KNOWLEDGE.md` index → `ARCHITECTURE.md`, `OPERATIONS.md`, `BUILD_HISTORY.md` |
| `scripts/prove-restore.sh` | Proves a database backup actually restores |
| `ops/paperclip-{start,status,stop}.sh` | Fail-closed lifecycle wrappers for the local Paperclip instance |
| `scripts/sync-superpowers.sh` | Syncs the superpowers skill pack into Hermes |

## Local Paperclip lifecycle

Run the local instance only through its tracked tmux session:

```bash
ops/paperclip-start.sh
ops/paperclip-status.sh
ops/paperclip-stop.sh
```

The wrappers own the `paperclip-default` session and refuse duplicate sessions
or processes, an occupied API port, stale/mismatched runtime PID metadata, a
database directory owned by another account, and an unhealthy API. Start only
after a fresh backup has been restore-proven with `scripts/prove-restore.sh`.

## Agents

`factory.config.json` is the source of truth for configured agents, adapters,
models, tools, instruction bundles, and budgets. The current desired state
declares OMP Engineer and OMP Reviewer. A Hermes instruction source is retained
as a dormant role template but is not currently configured for reconciliation.

The intended producer/reviewer boundary uses separate model families and a
narrow read-only reviewer tool surface. Runtime provenance still needs to be
verified from actual runs; configuration alone is not evidence of independence.

## Instructions

Paperclip's active adapter supplies the platform contract; the compiler never
copies it. `instructions/bundles.json` is the single machine-owned source of
bundle composition: it lists each role's fragment set in load-bearing order and
the byte caps that keep the resident prompt small. A bundle is the exact
ordered concatenation of its declared fragments — `_core.md` (shared
invariants) plus role and contract files specific to that role.

```bash
bash instructions/compile.sh --write   # edit src/ or bundles.json, then always run this
bash instructions/compile.sh --check  # byte-read-only drift check; NEVER publishes
```

`--write` installs each bundle mode `0444` (generated output is read-only to
humans) and regenerates `instructions/manifest.sha256` in role order. `--check`
is byte-read-only: it verifies composition, order, caps, forbidden-content
guards, duplicate headings, the manifest, and the `0444` mode, with zero
network calls and zero writes.

The compiler writes only local files (`instructions/out/` +
`instructions/manifest.sha256`) — it has no Paperclip credential path at all.
Live publication is a declarative reconciliation: `factory.config.json` binds
each agent's `instructions.bundle` to the compiled bytes verified against the
committed manifest at load time, and `factory apply` upserts the live
instruction files with exact semantic readback plus an immutable receipt.

## Known gaps

- **Worktree isolation is enforced at the kernel, not by instructions.**
  `ops/omp-bwrap.sh` mounts the primary X-Bookmarks tree and the repository's
  shared git metadata (objects, refs, packed-refs) read-only, so an agent cannot
  modify the operator's tree, commit, or rewrite history; only the assigned
  worktree is writable. Committing from inside is impossible by design — the only
  sanctioned commit path is `factory promote`. `omp/worktree-guard.js` remains as
  fail-closed diagnostics and defence-in-depth, not the boundary.
- **`@zhafron/paperclip-omp-adapter` is third-party, v0.1.3, single maintainer.**
  Load-bearing and unproven under crash, cancel, and resume.
- **Network isolation is unproven by design.** The Bubblewrap wrapper leaves the
  network namespace shared because OMP needs model-provider access. Anything
  reachable from this machine is reachable from inside; the mitigation is
  credentials, not connectivity. Never place production or external-effect
  credentials in the worker environment.

## Gotchas

- **The 200-and-do-nothing class is broader than one endpoint.** Paperclip has a
  class of write paths that accept a payload, silently drop fields, and return 200
  with the unchanged object. Confirmed members: `agent update` with
  `instructionsBundle` (only `instructions-file:put` persists); issue create/update
  with `executionWorkspacePreference`/`executionWorkspaceSettings` when
  `enableIsolatedWorkspaces` is off (fields deleted, still 200). Treat any new
  write path as a member until proven otherwise: never trust a status code, always
  re-GET and semantically compare (`lib/api.js#mutate` makes this the only
  sanctioned write path, and the issue-document upserts are covered by the same
  discipline — a document PUT that answers 200 without landing `latestBody` is an
  error, not a success).
- **A partial issue-level workspace strategy silently replaces the project's.**
  The server resolves `issueSettings.workspaceStrategy ?? projectPolicy.workspaceStrategy`
  — no merge. An issue strategy naming only `{type, baseRef}` silently drops
  `branchTemplate` and `worktreeParentDir`. `factory.config.json` load refuses a
  partial strategy (`lib/config.js#validate`).
- Codex reports a stale 272K context window for the GPT-5.6 family; corrected to
  1M in `~/.omp/agent/models.yml`.
- A set `CDPATH` makes `cd` echo its target and corrupt `$(cd … && pwd)`.

## Budgets

Budget policy is declared in `factory.config.json` and enforced by Paperclip and
provider-side limits. Read the current configuration and live ledger rather than
copying amounts from documentation; unknown or unreconciled cost is not zero.
