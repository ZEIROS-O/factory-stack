# factory-stack — Maintainer Router

A declarative control plane that reconciles agent definitions into Paperclip
(a local SaaS control plane) and runs bounded worker agents through OMP.
Paperclip owns objectives, assignment, status, approval, and budget; this
repository owns code, contracts, and the compiled instruction bundles the
workers receive. This file routes you to the right place — it is never loaded
into a worker.

## The three roles (routing only)

| Role | Takes | Produces | Where its bundle lives |
|---|---|---|---|
| Hermes Generalist | Ambiguous intake | Evidence-grounded research, decisions, or a handoff draft | `instructions/out/AGENTS.hermes.md` |
| OMP Engineer | Immutable objective envelope | Verified changes plus an execution receipt | `instructions/out/AGENTS.engineer.md` |
| OMP Reviewer | Objective + receipt + artifacts | An assessment and one disposition | `instructions/out/AGENTS.reviewer.md` |

The compiled bundles in `instructions/out/` are generated; their full
instructions live there and in `instructions/src/`, not in this file.

## Where things live

| Path | What it is | Rule |
|---|---|---|
| `instructions/` | `bundles.json` composes the three role bundles from `src/` fragments; `out/` is generated | Never edit `out/`; edit `src/` and `bundles.json`, then recompile |
| `contracts/` | JSON Schemas and the immutable objective envelope | The objective envelope outranks memory and guidance |
| `lib/` | Control plane: reconciliation, readback, promotion, review, goal gate | All Paperclip writes go through `lib/api.js#mutate` |
| `omp/` | Worker policy, hooks, and extensions (worktree guard, goal guard, review tool) | Sandbox policy is mechanical, not instructional |
| `ops/` | Sandboxes (bwrap) and Paperclip lifecycle wrappers | Lifecycle changes need operator authorization |
| `docs/` | Index + architecture + operations + build history | See `docs/FACTORY_KNOWLEDGE.md` for precedence |
| `test/` | Unit tests over schemas, reconciliation, promotion, instructions | `node --test test/unit/<file>` for one file |

## Validation

```bash
npm run check                                  # full gate (tests + instruction compile)
bash instructions/compile.sh --check           # byte-read-only drift check; never publishes
bash instructions/compile.sh --write           # regenerate out/ + manifest from src/
factory materialize --check                    # dry-run materialization of runtime profiles
factory preflight                              # launch/config probe, not readiness proof
```

`compile.sh --check` is byte-read-only and makes zero network calls. `factory
preflight` is a launch/configuration probe; it does not prove end-to-end
readiness or dispatch.

## Authorization

Billed dispatch, `factory apply`, `factory promote`, and service lifecycle
changes require explicit operator authorization every time. Read-only planning,
compilation, and local validation do not authorize them. Unknown or
unreconciled cost is not zero.

## Working safely

- Check `git status` before editing; never overwrite, clean, stage, or commit
  changes you did not create.
- After any authorized write to Paperclip, re-read and compare the intended
  fields — HTTP success alone is not proof of persistence.
- Keep observed facts, dated evidence, and inference distinguishable; resolve
  material uncertainty with current state or a cheap discriminating test.
- Generated instruction output is mode `0444`; to change it, edit the source
  fragments and recompile, never hand-edit `out/`.

## Where to go next

Start at `docs/FACTORY_KNOWLEDGE.md` — it indexes the three documents and states
the precedence rule. When sources conflict: explicit operator decision and the
current approved objective > live state you verified yourself > the docs >
newer handoffs > older research.
