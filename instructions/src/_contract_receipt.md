## Execution receipt

Call **`paperclip_receipt`** exactly once, and call it **BEFORE you set the
issue's disposition**. That order is not a style preference:

> Setting the disposition hands the issue to the next stage and reassigns it.
> The moment that happens you are no longer the assignee, and the control plane
> refuses your receipt write with `403 Agent cannot mutate another agent's
> issue`. Your work is then finished and unrecorded, and the reviewer has
> nothing to act on.

So: finish the work, call `paperclip_receipt`, and only then set the
disposition.

You supply your judgement only:

- `observations` — what you actually saw: the state you found, what you changed,
  what you saw afterwards.
- `conclusions` — what you concluded from those observations. Required when you
  are leaving the issue `ready_for_review`.
- `unresolvedConditions` — anything you could not settle. An empty array is a
  claim that nothing is unresolved; do not use it to mean "I did not check".
- `warnings` — anything the reviewer or the operator should know that is not a
  failure.
- `terminal` — `status` (`ready_for_review`, `blocked`, or `abandoned`) and a
  one-line `stopReason`.

**You never supply a hash, a commit, an objective binding, or a check result.**
The tool derives all of it: it reads the commits and per-file digests from the
worktree, the objective binding from the issue's own `spec` document, and it
RUNS the objective's acceptance commands itself, recording their real exit codes
and output hashes. If you find yourself about to copy a `sha256:` value or
report an exit code, stop — that is the tool's job, and a value you transcribe
is a value that can be wrong.

Run the acceptance commands yourself while you work, because you need to know
whether your change is correct. Just do not report them: the receipt records the
tool's own execution, so an optimistic account is not available to you and not
needed from you.

If your submission is malformed the tool tells you why and you call it again.
Getting it wrong is recoverable; not calling it is not.

Your final message is then free prose for a human reader. Do not restate the
receipt in it.

## Disposition

**Only after `paperclip_receipt` has returned successfully.** Your
`terminal.status` in the receipt is your account of the work; the disposition
moves the issue. Doing it in the other order loses the receipt.

Set the native Paperclip disposition that matches your terminal status: request `in_review` for
work ready for the configured review path; for blocked or abandoned work record
the supported disposition and its reason. Then read the issue back and confirm
it has a valid next action.

A run that ends without a disposition leaves the issue with no next step and can
trigger a corrective redispatch, which pays for the same reasoning twice.

Do not manually change assignees, review policy, execution state, stage
participants, or reviewer decisions.
