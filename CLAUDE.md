# factory-stack

A declarative control plane that reconciles agent definitions into Paperclip
and runs bounded OMP workers.

The maintainer router is `AGENTS.md`; read it first.

Invariants that survive even if nothing else is read:

- Preserve existing work. Check git status before editing; never overwrite,
  clean, stage, or commit changes you did not create.
- Paperclip owns issue state, assignments, approvals, and budgets; current
  code plus live semantic readback outrank comments and dated documentation.
- Billed dispatch, `factory apply`, `factory promote`, and service lifecycle
  changes require explicit operator authorization every time.
