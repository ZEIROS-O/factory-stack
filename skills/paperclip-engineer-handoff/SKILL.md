---
name: paperclip-engineer-handoff
description: Use when the handoff gate in the Hermes handoff contract is fully satisfied and a clarified request must become an OMP Engineer objective. Composes an EngineerHandoffDraftV1 and runs `factory handoff --draft <path>`. Use when handoff is warranted and authorized; never for investigation, clarification, or implementing the work yourself.
---

# Paperclip engineer handoff

## When to use this skill

Only when the handoff gate in the Hermes handoff contract is fully satisfied:
the request is unambiguous, the acceptance conditions are known and
mechanically checkable, the repository and base commit are identified, and no
open question remains that an Engineer could not resolve from the objective
alone. If any of that is missing, the next step is investigation or a
clarifying question — not this skill.

## What to compose: an EngineerHandoffDraftV1, and nothing else

Write an `EngineerHandoffDraftV1` as JSON. It carries only facts that exist
before Paperclip is involved:

- `parentIssueIdentifier` — the Paperclip issue this work descends from.
- `idempotencyKey` — your retry key. Choose it once per distinct request;
  reuse it verbatim on every retry of the same request.
- `title`, `originalRequest` — the work and the verbatim ask behind it.
- `repository.path`, `repository.baseCommit` — where the work happens and on
  what base.
- `permissions` — the complete read/write authority envelope; anything not
  listed is denied.
- `limits` — wall clock, child cost ceiling, outer factory cost ceiling, and
  the maximum number of review rounds.
- `verificationLevel`, `expectedOutputs`, `constraints`.
- `acceptanceCommands` — commands whose clean exit proves the work, as
  `argv` arrays with a bare program name first. Never a shell string.

**Never author a derived identifier.** The child issue identifier, the branch,
the acceptance criterion ids, the objective id, the revision, and every hash
are derived mechanically from the child Paperclip actually creates. The draft
schema rejects them, and the helper refuses them. Authoring one is a defect,
not a shortcut — a handoff that names its own objective has already drifted
from the thing it is supposed to describe.

## How to invoke

Write the draft to a file and run:

    /home/lucascoh/factory-stack/bin/factory handoff --draft <path-to-draft.json>

The path is absolute deliberately. `factory` is not on PATH, and you run from
a neutral working directory that is not the repository, so a bare `factory`
resolves to nothing.

The helper validates the draft before touching the network, creates an
unassigned backlog child that blocks the parent, installs the immutable
objective document, and only then makes the child runnable.

## What success looks like

An `EngineerHandoffReceiptV1`: the parent and child identifiers, the
idempotency key, the objective id and revision, the objective and criteria
hashes, the spec document revision, and a verified readback of the stored
document. The hashes in the receipt bind the receipt to exactly the objective
the Engineer will run against. The receipt is immutable and stored
permanently; it is the only proof the handoff happened.

## What failure looks like, and the correct response

Any failure leaves an unassigned, non-runnable child issue carrying a
diagnostic comment that names the failed step, what was expected, and what
was observed. The child is never deleted and partial state is never rolled
back — it is the evidence.

The correct response is always the same:

1. Read the diagnostic comment on the child.
2. Fix the draft (or whatever the observed error points at).
3. Re-run `factory handoff` with the SAME `idempotencyKey`.

The helper is idempotent: the same key with the same draft resumes or replays
the existing child; it never creates a second child for the same work. The
same key with a different draft is refused — that means the request changed,
and a changed request needs a new key.

Never hand-repair Paperclip state. Never delete the child. Never create a
second child for the same work. Never dispatch the Engineer yourself.

## The boundary

You have no repository write authority and no Paperclip authority beyond this
skill. You never dispatch the Engineer; Paperclip owns dispatch once the child
is runnable, and the Reviewer and the operator own what happens after. Your
job ends at a valid draft and a verified receipt.
