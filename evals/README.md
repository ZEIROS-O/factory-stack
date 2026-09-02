# Evals

Regression cases seeded from failures that **already happened here**. A
narrative lesson is a story; a case is what makes the lesson stay fixed.

    evals/cases/<id>/case.json   what happened, when, what it cost, which guard prevents it
    evals/cases/<id>/case.js     exercises that guard for real
    evals/candidates/            drafts from `factory retro`, promoted only by a person

`test/evals/cases.test.js` discovers every case, so they run under
`npm run check` rather than in a suite someone has to remember.

## The rule

A case exercises the **shipping guard**, never a mock of it. It also asserts the
legal configuration still passes — a guard that refuses everything is not a
guard, and a case that only checks the failure would not notice.

`case.json` names the guard by module and symbol, and the runner refuses a case
whose guard no longer resolves. A case pointing at deleted code cannot fail, and
would sit green forever.

## Mutants, proven

`promote-run.test.js` demonstrated that eighteen green tests can kill zero
mutants, because the fixtures shared the code's own wrong belief. So this is
measured, not assumed. Each guard was deleted or inverted in turn and the suite
re-run:

| mutation | cases that went red |
| --- | --- |
| delete the `approvalMode` refusal in `lib/config.js` | approval-mode-headless-inert |
| classify a dispositionless success as productive | no-disposition-redispatch |
| delete the `workspaceStrategy` completeness check | partial-workspace-strategy |
| let `api.mutate` trust the status code | api-200-and-do-nothing |
| drop `configFiles` from `adapterArgv` (the "keys are inert" belief) | wrong-adapter-keys, adapter-list-separator |
| make `stringList` split path keys on commas | adapter-list-separator |

Six for six. Re-prove this whenever a guard moves; a case that stops going red
has stopped being a case.

## What Phase 3 found

Two of the six documented failures **had no guard at all**. The
`approvalMode: write` runaway — the most expensive incident recorded here, ~$5.57
across six runs with zero repository writes — was prevented only by
`factory.config.json` happening to say `yolo`. `lib/preflight.js#adapterArgv`
passed `always-ask`, `write` or `yolo` straight through, and
`omp/engineer.policy.yml` explained the fix in prose. A comment is not a guard.
The refusal in `lib/config.js` was written by this phase, and its case is what
proves it holds.
