# factory-stack

**Read `docs/FACTORY_KNOWLEDGE.md` before doing anything in this repo.** It is
the canonical ground truth: what this system is, what is built, what is proven,
and — most importantly — the specific false conclusions that have repeatedly
been reached here.

## The one rule that matters most

Five consecutive agent sessions produced confident, wrong diagnoses in this
repo. Every one came from reading code that does not run and reporting it as
fact. Before claiming any component does or does not do something, **execute
something that proves it**, and label every claim `verified` / `read` /
`inferred`.

Highest-frequency trap: the agents run on `@zhafron/paperclip-omp-adapter`
(under `~/.paperclip/adapter-plugins`), **not** on
`node_modules/@paperclipai/adapter-pi-local`. Oh My Pi (OMP) and pi are
different products. See `docs/FACTORY_KNOWLEDGE.md` §5.

## Fast orientation

```bash
git log --oneline -3
npm test                                  # expect 139 pass, 0 fail
bash instructions/compile.sh --check
curl -s 127.0.0.1:3100/api/health
node bin/factory plan                     # read-only
```

## Traps that have each cost a session

1. **Confirm which adapter serves an agent's `adapterType` before reasoning about
   any `adapterConfig` key.** Behaviour is adapter-specific, not a Paperclip-wide
   constant.
2. **Never set OMP `approvalMode` to anything but `yolo` headless.** `write` and
   `prompt` make every exec tool fail while the run still exits 0 and reports
   `succeeded` — and the server then auto-creates a corrective run, so it loops
   until a budget cap stops it. This cost $5.57 in ~10 minutes.
3. **Read every Paperclip write back.** A 200 can silently `delete` fields — with
   `enableIsolatedWorkspaces` off, the isolation fields are dropped and the next
   dispatch writes into the operator's uncommitted work.
4. **A new config key must be added to `AGENT_MANAGED_KEYS` in `lib/plan.js`**, or
   `factory apply` silently never writes it and the config is inert on the live
   server.
5. **Never embed a literal control byte in source.** A raw NUL in `lib/review.js`
   made git treat it as binary and hid its diff for three commits.
6. **A test that shares the code's assumption proves nothing.** Build fakes from
   the shipped response shape, verified in `node_modules/@paperclipai/server/dist`.
7. **`factory preflight` is free** — it launches real OMP with an invalid model.
   Use it to check whether a config actually works instead of reasoning about it.
8. **Some integration tests fail with `EPERM` only inside a managed agent
   sandbox** (`spawnSync git EPERM`, bwrap netlink). On 2026-08-31 exactly three
   files failed this way — `verifier`, `guard`, `promote` — and were fine outside
   it. Re-run outside before believing a failure.
9. **When mutation-testing, confirm the mutant actually landed in the file.** Two
   checks here passed while testing nothing because the edit never applied.
10. **A flag named `--check` is not evidence of a dry run.** `compile.sh --check`
   really did live-publish before it was fixed. Read the code first.

## Standing constraints

- `factory apply` has never been run; nothing live has ever been mutated.
- Nothing has ever been dispatched. The factory is at **HOLD**.
- **Billed dispatch requires explicit operator approval, every time.**
- A green test suite here has meant little — mutate the line a test claims to
  protect before trusting it.
