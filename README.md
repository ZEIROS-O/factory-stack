# factory-stack

Control plane for the agent factory. Paperclip is the board; Hermes and OMP are workers.

```
you → Paperclip issue → heartbeat (30s) → spawns a worker CLI → result on the issue
```

## Layout

| Path | What |
|---|---|
| `package.json` / `package-lock.json` | Pins `paperclipai` — never run it via floating `npx` |
| `instructions/src/` | Governing law. Compiled into each agent's `AGENTS.md` |
| `instructions/compile.sh` | Builds and pushes the three bundles |
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

| Agent | Runtime | Model | Tools | Skills |
|---|---|---|---|---|
| Hermes Generalist | `hermes_local` | `claude-opus-5` | all | all 39 (adapter forces this) |
| OMP Engineer | `omp_local` | `anthropic/claude-opus-5` | all | 12 implementation |
| OMP Reviewer | `omp_local` | `openai-codex/gpt-5.6-sol` | 6, read-only | 5 verification |

Producer and reviewer sit in different model families on purpose. A reviewer of
the same family as the producer is not independent, whatever the transport.

## Instructions

Each delivered `AGENTS.md` is **self-contained**: Paperclip's platform contract
verbatim, then the shared doctrine, then one role section. The doctrine is
duplicated into all three at build time rather than referenced, because silent
non-delivery of a secondary file is unacceptable.

```bash
bash instructions/compile.sh     # edit src/, then always run this
```

`compile.sh` hard-fails if the platform contract stops being a byte-exact prefix,
or if any output starts referencing an external instruction file.

## Known gaps

- **Worktree isolation is not harness-enforced.** The `omp_local` adapter contains
  no worktree code and does not protect the primary branch. The Engineer's
  `AGENTS.md` requires it to create and verify a worktree itself. A repo-side hook
  rejecting writes to the primary branch is the only real boundary.
- **Envelope, receipt, and assessment are prose, not schemas.** Nothing rejects a
  receipt reporting `cost: 0` when it means `unknown`, or an assessment whose
  criteria hash does not match the objective revision.
- **`@zhafron/paperclip-omp-adapter` is third-party, v0.1.3, single maintainer.**
  Load-bearing and unproven under crash, cancel, and resume.

## Gotchas

- `agent update --payload-json '{"instructionsBundle":…}'` returns 200 and does
  nothing. `agent instructions-file:put` is the only write path that persists.
- Codex reports a stale 272K context window for the GPT-5.6 family; corrected to
  1M in `~/.omp/agent/models.yml`.
- A set `CDPATH` makes `cd` echo its target and corrupt `$(cd … && pwd)`.

## Budgets

Company $100/mo; Hermes $30, Engineer $40, Reviewer $20 — all `hardStop`, warn at
80%. Agent budgets sum under the company cap so an agent trips its own ceiling
first. The provider-side OpenRouter cap is the real backstop: it covers spend
Paperclip never sees, including your own terminal sessions.
