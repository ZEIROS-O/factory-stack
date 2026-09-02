# Factory Documentation Index

This repository's documentation is split into three files so mutable status and
history are never auto-loaded. Pick the one you actually need.

| File | What it is | Read it when |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Stable architecture: mission, the settled role diagram, non-negotiable operating principles, the engineer/review/budget contracts, and authority/precedence. | You need to know *what this system is and why it is shaped this way*. |
| [`OPERATIONS.md`](OPERATIONS.md) | How to operate it: the methodology preamble and traps, verified adapter facts and custom-tool discovery, Paperclip server behaviours, environment gotchas, proven vs not-proven claims, the acceptance boundary, promotion criteria, the rollout and canary order, and resuming rules. | You are about to *run, change, or verify* the system. Read the preamble first. |
| [`BUILD_HISTORY.md`](BUILD_HISTORY.md) | Dated build history and incident log: historical state snapshots, the recorded false conclusion, cost incidents, the investigated-and-FALSE claims list, and known defects. | You need *evidence of what happened before* — never as a claim about the system today. |

## Precedence

When sources conflict, higher beats lower:

1. Explicit operator decision and the current approved objective.
2. Live state you verified yourself — repository, running server, tests, immutable receipts.
3. These documents.
4. Newer implementation handoffs.
5. Older architecture comparisons and research.

Handoff summaries rank *below* live state deliberately: several have been
confidently wrong. If a document and reality disagree, reality wins — then fix
the document in the same session.
