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
npm test                                  # expect 136 pass, 0 fail
bash instructions/compile.sh --check
curl -s 127.0.0.1:3100/api/health
node bin/factory plan                     # read-only
```

## Standing constraints

- `factory apply` has never been run; nothing live has ever been mutated.
- Nothing has ever been dispatched. The factory is at **HOLD**.
- **Billed dispatch requires explicit operator approval, every time.**
- A green test suite here has meant little — mutate the line a test claims to
  protect before trusting it.
