# Factory Architecture

Stable, settled design: what the system is and the principles it cannot
violate. Mutable status, incident history, and open work live elsewhere.

---

## 1. Mission

Build a local-first, low-operator-attention software and agent factory that
converts bounded objectives into verified changes, artifacts, decisions, or
operational outcomes.

The optimization target is **valuable unattended progress per unit of founder
attention** — not agent count, autonomy, model sophistication, or orchestration
complexity. Work is successful only when the requested terminal outcome is
proven by evidence and accepted under the required policy.

---

## 2. Settled architecture

```
Founder / Board
      │
      ▼
Paperclip — sole company control plane
      │
      ├── bounded technical objective ──► OMP Engineer
      │                                      │
      │                               uncommitted worktree diff
      │                                      │
      │                       deterministic verification
      │                                      │
      │                        independent OMP Reviewer
      │                                      │
      │                        controlled human promotion
      │
      └── future mixed objective ───────► Hermes ──► OMP if needed
```

- **Paperclip** owns objectives, issues, assignment, schedules, budgets,
  approvals, status, retries, recovery, and audit. It is the only control plane.
- **OMP** is the bounded technical execution runtime. The Engineer produces
  work; the Reviewer independently assesses it.
- **Hermes is deferred.** Add it only after the direct Paperclip → OMP lane is
  proven, and only for mixed/ambiguous/research objectives.
- **Git** owns code, tests, documents, schemas, committed artifacts.
- **Deterministic validators** establish mechanically observable facts. A
  model's claim is not evidence when reality can be inspected.
- **Human approval** controls final promotion.
- **Provider limits** are the authoritative financial boundary.

Do not revive Conductor, add Temporal, build a competing RPC/control plane, or
introduce a second task database or scheduler.

---

## 3. Non-negotiable operating principles

1. **The executor cannot certify itself.** Producer output requires independent
   evidence and, where policy requires, independent review.
2. **Mechanical reality outranks model judgment.** Tests, type checks, schemas,
   hashes, Git state, API readback, and filesystem inspection outrank summaries.
3. **HTTP 200 is not success.** Read back and compare semantically.
4. **Exit code 0 is not success.** OMP success depends on stop reason, evidence,
   and acceptance state.
5. **Instructions are not security boundaries.** Enforce invariants with
   capability restrictions, schemas, sandboxing, hooks, worktrees, readback,
   and budgets.
6. **Current truth beats memory.** Memory may preserve procedures, never
   override live state, repository state, objective revision, or evidence.
7. **Every objective reaches an explicit terminal or intervention state.**
8. **One authority per concern.**
9. **Fail closed.** Missing configuration, unknown cost, stale evidence, partial
   strategy, changed diff, missing criterion, or ambiguous authority blocks.
10. **Complexity must earn its place.**
11. **Verification outranks analysis.** A claim you have not executed is a
    hypothesis. Reading more source is not a substitute for running one command.
    (Added 2026-09-01 after five sessions of the opposite.)

---

## 9. Contracts

### Engineer output contract

The Engineer **cannot commit** — shared Git objects are read-only by design. It
must return: an uncommitted diff in the assigned external worktree; base commit
and branch identity; `head == base` in the receipt; exact changed paths and
hashes; commands and deterministic results; OMP session/model/provider lineage;
duration, cost status, warnings, unresolved conditions; and claims separated
from evidence.

Only `factory promote` may stage the exact reviewed paths and create the commit,
after revalidation and human approval. The Engineer must never merge, push,
deploy, publish, or write into the primary tree.

### Review contract

The Reviewer must: receive the exact spec revision, criteria hash, base/diff
hash, deterministic results, and producer lineage; **be from a different model
family**; assess every criterion PASS/FAIL/BLOCKED/UNCERTAIN with evidence; run
acceptance commands in a second read-only verifier; write only the current
issue's assessment through `paperclip_review`; either approve toward human
review or request changes; never modify repository, spec, budget, receipt,
project, or another issue; stop after two rounds and escalate rather than loop.

Approval can never overrule a deterministic failure, stale spec, changed diff,
missing criterion, same-family review, or failed cost gate.

**Note on independence:** it is currently proven by comparing
`FACTORY_ENGINEER_MODEL` / `FACTORY_REVIEWER_MODEL`, two constants in the
Reviewer's `env`. That asserts a property of the config, not of the run. If the
Engineer's `model` changes and the env is not updated, a model could review its
own family while the assessment claims independence. Carrying the producing
model from the run row is the real fix.

### Budget contract

- ZEI-1 time limit hard-enforced at 45 min via `timeoutSec: 2700`.
- The **$4 ZEI-1 limit is not an issue-level hard stop** — Paperclip supports
  company/agent/project budget scopes only. Treat $4 as a promotion-time gate.
- Real hard boundaries: the Engineer's $40 agent budget and the provider cap.
- Unknown or unreconciled cost is not zero, and blocks promotion.

---

## 13. Authority and precedence

When sources conflict:

1. Explicit founder decision and the current approved objective.
2. **Live state you just verified yourself** — repository, running server, tests,
   immutable receipts.
3. This document.
4. Newest implementation roadmap and handoff notes.
5. Older architecture comparisons and research.

Handoff summaries from prior sessions rank **below** live state deliberately.
Several have been confidently wrong. If this document and reality disagree,
reality wins — then fix this document in the same session.
