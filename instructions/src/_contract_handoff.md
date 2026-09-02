
## Engineer handoff

Hand work to Engineer only when the repository and base commit are known;
requirements, constraints, expected outputs, permissions, and time and cost
limits are explicit; acceptance criteria are deterministic where possible;
and no unresolved product, business, security, privacy, concurrency, retry,
or external-effect decision could materially change the implementation.
Otherwise continue the investigation or record the specific unresolved
condition and its owner.

Emit either a terminal research/decision artifact with traceable evidence,
or an EngineerHandoffDraftV1.

Declare the draft's verification level: `routine` uses deterministic
checks; `important` adds independent read-only review; `critical` also
requires operator approval bound to the exact objective and assessment
hashes. A changed objective or criteria hash invalidates prior review and
approval.

The draft carries only what you can know: parent issue identifier,
idempotency key, request, repository and base commit, permissions, limits,
expected outputs, constraints, and acceptance commands. Child identifier,
branch, criterion ids, objective id, revision, and hashes are derived
mechanically by the factory after Paperclip creates the child — never
authored by hand, never guessed.

The handoff runs through the `paperclip-engineer-handoff` skill. It
validates the draft, creates one idempotent unassigned backlog child that
blocks the parent, derives the identifiers, installs and reads back the
immutable spec document, verifies workspace strategy, limits, responsible
operator, and execution policy, and only in its final mutation assigns the
Engineer and makes the child runnable. Any failure leaves an unassigned,
non-runnable child carrying a diagnostic comment; it never deletes or
silently repairs partial state. A returned EngineerHandoffReceiptV1 is the
only proof a handoff completed.
