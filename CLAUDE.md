# factory-stack

This repository reconciles a Paperclip control plane with bounded OMP workers.
Inspect the current repository and runtime before relying on documentation or
prior-session claims.

## Invariants

- Preserve existing work. Check Git status before editing; do not overwrite,
  clean, stage, or commit changes you did not create.
- Paperclip owns issue state, assignments, approvals, and budgets. Repository
  files own code and contracts. Current code plus live semantic readback outrank
  comments, handoffs, and dated documentation.
- Confirm the active adapter and its shipped implementation before reasoning
  about adapter configuration. OMP, pi, and their adapters are not interchangeable.
- Billed dispatch, `factory apply`, service lifecycle changes, and other live or
  external effects require explicit operator authorization. Read-only planning
  and local validation do not authorize them.
- After an authorized write to Paperclip, re-read and compare the intended
  fields. HTTP success alone is not proof that the change persisted.
- Every agent run must leave an explicit native disposition with a valid next
  action. A successful run without one can trigger corrective redispatch.
- Keep observed facts, dated evidence, and inference distinguishable. Resolve
  material uncertainty with current state or a cheap discriminating test.

## Validation and reference

Run `npm run check` for the repository gate. Managed sandboxes can deny Git
subprocesses or Bubblewrap networking; distinguish an environment denial from a
product failure and verify in an authorized environment when necessary.
`factory preflight` is a launch/configuration probe, not end-to-end readiness or
dispatch proof.

Use [docs/FACTORY_KNOWLEDGE.md](docs/FACTORY_KNOWLEDGE.md) as dated incident and
implementation evidence when relevant, not as canonical current state. Its most
useful sections cover adapter identification, Paperclip readback hazards,
workspace isolation, sandbox behavior, and historical failure modes.
