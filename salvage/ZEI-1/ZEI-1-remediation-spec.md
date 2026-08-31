# ZEI-1 — Remediation spec (attempt blocked before first repo write)

Attempt date: 2026-08-31. Agent: OMP Engineer (293f9cdb).
Status: **blocked**. No file in `/home/lucascoh/X-Bookmarks` was created, modified, or deleted by this attempt.

## Why blocked

`bash`, `eval`, `hub`, and `task` all fail with:

```
Tool "<name>" requires approval but no interactive UI available.
Options:
  1. Set tools.approvalMode: yolo in /settings
  2. Add tools.approval.<name>: allow to config
  3. Use an interactive UI to approve the tool call
```

Root cause, from `GET /api/companies/c8a26e3d-.../agents`, this agent's record:

```json
"adapterType": "omp_local",
"adapterConfig": { "autoApprove": false, "approvalMode": "write", ... }
```

Consequences, in order of severity:

1. `git worktree add` cannot run, so the attempt worktree and branch required by the
   OMP Engineer authority boundary cannot be created or verified. The boundary says:
   if worktree isolation cannot be established, block rather than write in place.
2. None of the six deterministic acceptance checks can be executed. Verification level
   is `important`; deterministic checks are a hard gate that no reasoning may substitute for.
3. Writing unverified edits directly into `/home/lucascoh/X-Bookmarks` is the single
   highest-risk action available here, because that working tree holds the uncommitted
   phase-1 deliverable (`scripts/snapshot.py`, `tests/test_snapshot.py`, `scripts/snapshots/`,
   `CLAUDE.md`, spec edits) that ZEI-1 explicitly forbids disturbing.

Unblock owner: **Lou** (board operator; only principal who can PATCH agent adapterConfig).
Unblock action: set `autoApprove: true` on agent `293f9cdb-fa32-426f-b7f4-fd3324673432`,
or relax `approvalMode` from `write`, then re-run ZEI-1. No code change is needed to unblock.

Everything below is verified by reading the sources at the cited lines. It is a spec, not a
claim that anything was fixed.

## Relativity decision (defect 1) — REQUIRED receipt item

**`note_path` is emitted relative to `--root`, not to `REPO`.** `--root` defaults to `REPO`.

Rationale:

- `make_batches.describe()` line 109 currently emits `note_path.relative_to(REPO).as_posix()`
  → `bookmarks/foo.md`.
- `validate_claims.note_body()` line 76 resolves `(root / note_path)`.
- Root-relative emission keeps default output byte-identical to today (`bookmarks/foo.md`),
  so the 188 existing tests and any existing `dispositions.json` are unaffected, **and**
  `root / "bookmarks/foo.md"` resolves correctly under a snapshot root.
- The rejected alternative — REPO-relative emission — yields
  `projects/new-bookmarks-2026-08-30/bookmarks/foo.md`, which `note_body` would expand to
  `<root>/projects/new-bookmarks-2026-08-30/projects/new-bookmarks-2026-08-30/bookmarks/foo.md`.
  That is precisely the double-prefix the issue names.

Consumers already agree with the root-relative reading: `view.load/dispositions/render_notes`
and every `coverage.py` function take `root` and join it to `note_path`.

## Defect 1a — `bin/make_batches.py`

Module-level `VAULT = REPO / "bookmarks"` (line 23) is the hardcoded binding. `VAULT` is read
only inside `main()` (line 227), and `REPO` is read at lines 109, 233, 245, 247.

- Delete module-level `VAULT`; keep `REPO` as the `--root` default only.
- Add `ap.add_argument("--root", default=str(REPO))`; in `main()`, `root = Path(args.root).resolve()`.
- `notes = sorted((root / "bookmarks").glob("*.md"))`.
- Thread root into `describe`: `def describe(note_path: Path, root: Path = REPO)`, and line 109
  becomes `note_path.relative_to(root).as_posix()`. Default preserves every existing caller.
- Line 233 `p.relative_to(REPO)` → `p.relative_to(root)`.
- Lines 245 and 247 `(REPO / args.dispositions_out)` → `(root / ...)`, so pipeline artifacts land
  inside the snapshot rather than the repo. Create parent dirs before writing.

## Defect 1b — `bin/coverage.py`

Smaller than it looks: `root` is **already** a parameter with default `REPO` on
`load_claims` (102), `titles` (127), `citation_output_files` (136), `citation_evidence` (146),
`repository_revision` (191), `write_pre_assembly_snapshot` (200), `load_pre_assembly_analysis` (224),
`historical_analysis` (239), `analyse` (245), and `main(argv, root=REPO)` (385).

Only the CLI flag is missing. Add `ap.add_argument("--root", default=str(REPO))` and, after
parsing, `root = Path(args.root).resolve()` shadowing the parameter default. No signature churn.

## Defect 2 — `bin/validate_claims.py:219-224`

Current:

```python
errors = check_claim(root, rec)
accounted[note] = accounted.get(note, 0) + 1   # line 220 — runs for flagged records too
if errors:
    result.flagged.append(dict(rec, validation_errors=errors))
else:
    result.claims.append(rec)
```

Move the increment into the `else` branch. A record carrying `validation_errors` must never
credit the recall floor; today 40 unresolvable quotes clear a 40-item floor.

Safe because `note` cannot be `None` in the success branch: `note_path` is in `REQUIRED`
(`validate_claims.py:32`) and `check_claim` returns early at line 88 whenever any `REQUIRED`
key is missing or empty. So a record reaching the `else` branch always has a usable
`note_path` key for `accounted`.

## Defect 3 — `bin/validate_claims.py:112-115`

`derive_excerpt_span(body, rec["quote"])` is called bare; only the `ValueError` is kept. It
returns `(excerpt, [start, end], normalized)`. Bind and persist onto `rec` on success:

```python
try:
    excerpt, span, normalized = derive_excerpt_span(body, rec["quote"])
except ValueError:
    errors.append("quote_unresolvable")
else:
    rec["excerpt"] = excerpt
    rec["excerpt_span"] = span
    rec["excerpt_normalized"] = normalized
```

`rec` is the same dict appended to `result.claims` at line 224 and dumped by `dump()` at 250-257,
so the fields reach `claims.jsonl` with no further plumbing.

**Verified against `bin/expand_excerpt.py:31`** (read, not inherited from the issue text):
`def derive_excerpt_span(note_content: str, raw_excerpt: str) -> tuple[str, list[int], bool]`.
The third element is a **boolean match-mode flag**, not normalized text: `False` on the exact
substring hit (line 47), `True` on the folded/normalized fallback hit (line 58). So
`excerpt_normalized` records *how* the quote resolved. Do not store folded text there — a
reviewer checking "non-null `excerpt_normalized`" must not be satisfied by a `False` being
mistaken for absent; assert the key is *present*, not merely truthy.

## Defect 4 — `bin/validate_claims.py:211-217, 250-259`

Skip records are credited at line 214 then dropped; only unjustified ones survive, as flagged.
Add `skips: list = field(default_factory=list)` to `Result` (line 59-65), append `rec` in the
`if credit:` branch, and add `dump("skips.jsonl", result.skips)` beside the three existing dumps.
Line count then equals the number of justified skips by construction.

## Defect 5 — `bin/view.py:220-232`

`render_claims` has no `--fields` support at all — the flag does not exist in `main()`
(lines 235-253). Two parts:

- `ap.add_argument("--fields", help="comma-separated extra claim fields to append")`.
- `render_claims(rows, cap_tokens, force, fields=None)`; for each requested field present on the
  record, append ` <field>=<value>`. Must cover `commercial_interest`, `value_basis`,
  `legal_risk`, `enumeration_position`, `quote`.

**Field availability, verified against `REQUIRED` (`validate_claims.py:31-36`).**
`commercial_interest`, `value_basis`, `legal_risk`, and `quote` are all REQUIRED, so every
validated claim carries them and the passthrough always has a value. `enumeration_position`
is **not** in `REQUIRED` — it is optional and appears mainly on skip records
(`test_validate_claims.py:177`). The passthrough must therefore tolerate its absence rather
than emit `None`, and acceptance check 6 should be satisfied with a record that actually
sets it.

Keep the default output identical when `--fields` is absent: `test_view.py` asserts on the
current single-line shape (e.g. `test_force_overrides_the_cap` at line 180).

## Acceptance check 2 — fixture, not the snapshot

`/home/lucascoh/X-Bookmarks/projects` **does not exist** (glob returned "Path not found"), so the
`projects/new-bookmarks-2026-08-30` invocation cannot match 58 notes. The issue's own fallback
applies: use a fixture root with a known note count and assert against that, stating the choice.

The 58 figure is corroborated by the uncommitted phase-1 test
`tests/test_snapshot.py::test_committed_definition_carries_the_58_approved_ids_in_order`, which
asserts `len(loaded["allowlist"]) == 58`. If the snapshot materializes at a different path before
the next attempt, prefer the real root and report the actual matched count.

## Execution order for the unblocked attempt

1. `git -C /home/lucascoh/X-Bookmarks rev-parse --abbrev-ref HEAD` → expect `feat/new-bookmarks-snapshot`.
2. `git worktree add <path> -b <attempt-branch>`; `cd`; re-run step 1 to confirm; record both.
3. `python3 -m pytest -q` on the untouched worktree → record the pre-change baseline count.
4. Apply defects 2, 3, 4, 5 (single-file, low blast radius), then 1a and 1b.
5. Add tests for all five defects.
6. Re-run `python3 -m pytest -q`; capture literal output for each of the six checks.
7. Hand off: PATCH issue with `status: in_review`,
   `assigneeAgentId: f5231bf2-486e-4ed8-b8d2-1cb8a27db7e6` (OMP Reviewer),
   `reviewPolicy: not_creator`. Verify the assignee actually changed.
