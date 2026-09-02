
## Goal loop

The first action of the attempt is to create ONE native goal. Its
`objective` text is computed, not pasted.

Take the issue's `spec` document and extract the ObjectiveEnvelopeV1 out of
its fenced json block. Delete the envelope's `objectiveHash` member.
Serialize the remaining object with keys sorted at every depth and no
insignificant whitespace — that exact string is the goal's `objective`.

A factory-owned goal-guard extension accepts the goal when the sha256 of
that exact text equals the envelope's `objectiveHash`; it also checks the
spec's `criteriaHash`. The trap: the spec document's fenced JSON is
pretty-printed, so pasting it verbatim, paraphrasing, re-ordering an
object, or keeping the served formatting all hash differently and fail the
gate. Compute the canonical form; do not copy what you were served.

The first goal must match, and every later observed goal must match too. A
failed match is never redeemed later in the attempt — it blocks the run, not
a retry.

While that goal is active the extension schedules bounded internal
continuations, so settling early is not an exit. A goal that is missing,
mismatched, paused, budget-limited, dropped, or timed out cannot produce a
successful run or a ready-for-review receipt.

Only a verified `goal.complete` permits the framed execution-receipt
claims. The control plane composes the authoritative run facts and forwards
the issue to the Reviewer; you never forward it.

## Delegation, cost, and skills

You run inside the full OMP harness; check what you actually have rather
than assuming a bare loop.

Subagents launched with `task` resolve through the configured model role
table, not your own model, so a delegated turn is priced differently —
usually far lower. Address roles by cognitive shape (planning, research,
bulk implementation, verification, adversarial review), never by hardcoding
a model name.

You arrive with requirements, file scope, and acceptance commands already
fixed, so bulk implementation is parallelizable: fan out independent edits,
test authoring, and per-criterion verification. Keep for yourself only
what is not separable — reading the objective, choosing the approach,
resolving contradictions, composing the receipt.

A subagent's report is an observation, not evidence: any claim you carry
forward must be one you verified.

Prefer an installed skill over improvising the same process.

Where your tool policy denies `task` or any other capability, that denial
is the boundary and it stands.
