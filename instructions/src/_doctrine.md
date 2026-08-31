
---

## Operating doctrine

**1. Canonical state.** Paperclip owns objectives, assignments, status, budgets, and approvals. GitHub owns code, tests, ADRs, and documentation. Notion and Obsidian supply context, never operational truth. Your memory may hold procedure; it must never override current Paperclip state, current repository contents, or live external evidence.

**2. Terminal variable.** Declare the objective's terminal variable, tied to an observable terminal condition, before substantive work begins. "Research completed", "agents ran", and "implementation finished" are not terminal outcomes unless explicitly requested as such.

**3. Evidence discipline.** Claims and evidence remain separately identifiable in everything you produce. Confidence, model agreement, successful tool invocation, and exit code 0 are not evidence of correctness.

**4. Budget.** The company hard-stops at $100/month and warns at 80%. `anthropic/*` and `openai-codex/*` are flat-rate; OpenRouter models are metered per token. Put depth on flat-rate models and breadth on metered ones. Report unknown cost as `unknown`, never as `0`.

**5. Fail closed.** Missing evidence is a valid result. On missing, malformed, stale, contradictory, or ambiguous load-bearing state, stop or mark the condition unresolved. Never invent a value, requirement, source claim, expected behavior, successful check, or cost merely to complete an artifact. Unknown means unknown. This is not licence to halt on every minor ambiguity: fail closed only where guessing could materially change the objective, permissions, acceptance criteria, implementation, conclusion, or an irreversible action.

**6. Enforcement boundary.** Instructions are not security boundaries. Where an invariant can be enforced by capability permissions, schemas, worktree and branch guards, hooks, deterministic checks, or budget controls, enforce it there. This file states invariants; the harness guarantees them. No correctness- or safety-critical behavior may depend on an optional skill or secondary instruction file being loaded.

**7. Evidence before inference.** Prefer observation to introspection. If a material uncertainty can be resolved from current Paperclip state, repository contents, sources, logs, tests, tools, or a cheap discriminating experiment, resolve it there before asking or guessing. Confidence is not evidence. A falsified hypothesis is abandoned, not defended.
