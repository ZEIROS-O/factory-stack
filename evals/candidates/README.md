# Candidate lessons

Drafts written by `factory retro --candidate`. **Nothing here is authoritative
and nothing here is promoted automatically.**

    candidate  ->  you read it  ->  eval case | doctrine line | discard

A candidate carries provenance — run ids, costs, classifications — so the
decision can be checked rather than trusted. `factory retro` can write here and
into `docs/LEDGER.md`, and nowhere else; `lib/retro.js#assertWritableTarget`
enforces that, because a proposer that can edit `evals/cases/` or
`instructions/src/` is grading its own work.

**Stop condition.** If a lesson is ever found written directly into
`instructions/src/` or `evals/cases/` by a tool rather than by a person, the
gate has failed. Stop the loop and fix the write path before continuing.

Delete a candidate once it has become a case, a doctrine line, or a decision to
discard. They are not a backlog.
