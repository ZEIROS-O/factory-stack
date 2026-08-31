#!/usr/bin/env python3
"""Tests for the five bin/ defects fixed under ZEI-1.

Synthetic fixtures only; no test reads a real note, so the suite says nothing about the
corpus and cannot be made to pass by editing it. Conventions follow tests/test_validate_claims.py
and tests/test_view.py (REPO/bin on sys.path, TemporaryDirectory roots, `claim()` builders).

STATUS: WRITTEN BUT NEVER EXECUTED. The authoring run could not run python (see
ZEI-1-remediation-spec.md). Treat every assertion here as a proposal to be run, not as a
passing result.

Drop at: tests/test_bin_defects.py
"""
import io
import json
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "bin"))

import coverage  # noqa: E402
import make_batches  # noqa: E402
import validate_claims  # noqa: E402
import view  # noqa: E402


# `prose_of` strips heading and fence lines and everything from "## Links" down, so the
# body below must clear MIN_PROSE_CHARS (400) in plain prose alone.
PROSE = (
    "Losing money is rarely a single decision; it is a sequence of small concessions that "
    "each look reasonable in isolation. The first concession is sizing up after a loss, "
    "because the loss feels like information about the market when it is information about "
    "the position. The second is moving a stop, which converts a bounded loss into an "
    "unbounded one. The third is trading a setup that was never in the plan, on the grounds "
    "that conditions are unusual. Conditions are always unusual. The fourth is adding to a "
    "position that is already wrong, which is indistinguishable from the third at the time "
    "and only separable afterwards."
)


def note_text(bookmark_id="111", title="12 ways to lose money"):
    return f"""---
title: "{title}"
bookmark_id: "{bookmark_id}"
author_username: "someone"
published: 2026-01-02T00:00:00.000Z
aliases: ["{title}"]
---
# {title}

## Post text
```text
{PROSE}

1. one
2. two
3. three
```

## Links
- Original post: https://x.com/someone/status/{bookmark_id}
"""


def claim(**over):
    base = {
        "kind": "claim",
        "item_id": "111",
        "note_path": "bookmarks/n.md",
        "author_username": "someone",
        "published": "2026-01-02",
        "claim": "Losing money the first way is a documented outcome of doing one.",
        "frames": ["mechanism"],
        "type": "mechanism",
        "trigger": "doing one",
        "action": "stop doing one",
        "actionability": "executable",
        "explanatory_power": 1,
        "decision_relevance": 1,
        "specificity": 1,
        "half_life_class": "years",
        "half_life_reason": None,
        "commercial_interest": "none",
        "numeric_confidence": "absent",
        "value_basis": "unknown",
        "legal_risk": "none",
        "enumeration_position": 1,
        "quote": "1. one",
    }
    base.update(over)
    return base


class ValidatorRoot(unittest.TestCase):
    """Repo-shaped tempdir: bookmarks/n.md, pipeline/raw/, dispositions.json."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "bookmarks").mkdir()
        (self.root / "pipeline" / "raw").mkdir(parents=True)
        (self.root / "bookmarks" / "n.md").write_text(note_text(), encoding="utf-8")
        self.addCleanup(self._tmp.cleanup)

    def run_validator(self, records, *, expected_items=0):
        raw = self.root / "pipeline" / "raw" / "batch-001.jsonl"
        lines = [json.dumps(r) for r in records]
        lines.append(json.dumps({
            "kind": "sentinel", "batch": 1, "status": "complete",
            "notes": ["bookmarks/n.md"], "record_count": len(records),
        }))
        raw.write_text("\n".join(lines) + "\n", encoding="utf-8")
        (self.root / "pipeline" / "dispositions.json").write_text(json.dumps([{
            "note_path": "bookmarks/n.md", "item_id": "111",
            "title": "12 ways to lose money", "disposition": "extract",
            "expected_items": expected_items, "enumerated_items": 3, "declared_n": 12,
        }]), encoding="utf-8")
        return validate_claims.validate(self.root)


# --- Defect 1: --root, and the relativity contract -----------------------------------

class TestMakeBatchesRoot(unittest.TestCase):
    """`--root` must retarget the vault, and note_path must be relative to that root."""

    FIXTURE_NOTE_COUNT = 58  # mirrors the new-bookmarks-2026-08-30 allowlist size

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "bookmarks").mkdir()
        (self.root / "pipeline").mkdir()
        for i in range(self.FIXTURE_NOTE_COUNT):
            (self.root / "bookmarks" / f"n{i:03d}.md").write_text(
                note_text(bookmark_id=str(1000 + i)), encoding="utf-8")
        self.addCleanup(self._tmp.cleanup)

    def test_root_matches_every_note_in_the_fixture_vault(self):
        """Acceptance check 2. Hardcoded VAULT matched zero notes under a foreign root."""
        argv = ["make_batches.py", "--root", str(self.root), "--pack-bytes", "25000"]
        with unittest.mock.patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()) as out:
            rc = make_batches.main()

        self.assertEqual(rc, 0)
        self.assertIn(f"notes in scope        {self.FIXTURE_NOTE_COUNT}", out.getvalue())
        written = json.loads((self.root / "pipeline" / "dispositions.json").read_text())
        self.assertEqual(len(written), self.FIXTURE_NOTE_COUNT)

    def test_note_path_is_relative_to_root_not_to_repo(self):
        """The relativity decision, asserted. REPO-relative emission is what double-prefixes."""
        record = make_batches.describe(self.root / "bookmarks" / "n000.md", self.root)

        self.assertEqual(record["note_path"], "bookmarks/n000.md")
        self.assertFalse(Path(record["note_path"]).is_absolute())

    def test_emitted_note_path_round_trips_through_validate_claims_note_body(self):
        """The actual defect: make_batches output must resolve under the same --root."""
        record = make_batches.describe(self.root / "bookmarks" / "n000.md", self.root)

        body = validate_claims.note_body(self.root, record["note_path"])

        self.assertIn("Losing money is rarely a single decision", body)
        self.assertNotIn("bookmark_id:", body)  # frontmatter sliced off

    def test_default_root_keeps_repo_relative_output_unchanged(self):
        """Regression guard: omitting --root must not move existing note_path values."""
        record = make_batches.describe(self.root / "bookmarks" / "n000.md", self.root)
        self.assertTrue(record["note_path"].startswith("bookmarks/"))


class TestCoverageRoot(unittest.TestCase):
    """coverage.py already threads `root`; only the CLI flag was missing."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "pipeline").mkdir()
        with (self.root / "pipeline" / "claims.jsonl").open("w", encoding="utf-8") as fh:
            for _ in range(5):
                fh.write(json.dumps(claim(
                    note_path="bookmarks/hv.md", decision_relevance=3, specificity=3)) + "\n")
        (self.root / "pipeline" / "dispositions.json").write_text(json.dumps([
            {"note_path": "bookmarks/hv.md", "item_id": "111", "title": "t",
             "author_username": "someone", "published": "2026-01-02",
             "disposition": "extract", "expected_items": 0}]), encoding="utf-8")
        self.addCleanup(self._tmp.cleanup)

    def test_root_flag_analyses_the_given_root(self):
        with redirect_stdout(io.StringIO()) as out:
            coverage.main(["--root", str(self.root), "--live-worklist"])

        self.assertIn("bookmarks/hv.md", out.getvalue())


# --- Defect 2: flagged records must not credit the recall floor ----------------------

class TestFlaggedDoesNotClearRecallFloor(ValidatorRoot):
    def test_a_note_whose_records_are_all_flagged_has_accounted_zero(self):
        """Acceptance check 3, asserted directly."""
        flagged = [claim(quote=f"a sentence absent from the note {i}") for i in range(4)]

        result = self.run_validator(flagged, expected_items=12)

        self.assertEqual(len(result.claims), 0)
        self.assertEqual(len(result.flagged), 4)
        floors = [f for f in result.hard_failures if f["kind"] == "recall_floor"]
        self.assertEqual(len(floors), 1)
        self.assertEqual(floors[0]["accounted"], 0)
        self.assertEqual(floors[0]["gap"], 12)

    def test_forty_unresolvable_quotes_cannot_satisfy_a_forty_item_floor(self):
        """The reported exploit, stated as its own case."""
        result = self.run_validator(
            [claim(quote=f"not present {i}") for i in range(40)], expected_items=40)

        floors = [f for f in result.hard_failures if f["kind"] == "recall_floor"]
        self.assertEqual(len(floors), 1)
        self.assertEqual(floors[0]["accounted"], 0)

    def test_a_valid_record_still_credits_the_floor(self):
        result = self.run_validator([claim()], expected_items=1)

        self.assertEqual(len(result.claims), 1)
        self.assertEqual([f for f in result.hard_failures if f["kind"] == "recall_floor"], [])


# --- Defect 3: persist the excerpt span ----------------------------------------------

class TestExcerptSpanPersisted(ValidatorRoot):
    def test_emitted_claim_carries_excerpt_span_and_excerpt_normalized(self):
        """Acceptance check 4. Assert key PRESENCE: excerpt_normalized is legitimately False."""
        result = self.run_validator([claim()], expected_items=0)

        self.assertEqual(len(result.claims), 1)
        record = result.claims[0]
        self.assertIn("excerpt_span", record)
        self.assertIn("excerpt_normalized", record)
        self.assertIsNotNone(record["excerpt_span"])
        start, end = record["excerpt_span"]
        self.assertIsInstance(start, int)
        self.assertLess(start, end)

    def test_excerpt_span_indexes_the_note_body(self):
        result = self.run_validator([claim()], expected_items=0)
        record = result.claims[0]

        body = validate_claims.note_body(self.root, record["note_path"])
        start, end = record["excerpt_span"]

        self.assertEqual(body[start:end], "1. one")

    def test_exact_match_records_excerpt_normalized_false(self):
        """False means 'resolved by exact substring', not 'missing'."""
        result = self.run_validator([claim()], expected_items=0)

        self.assertIs(result.claims[0]["excerpt_normalized"], False)

    def test_span_survives_to_claims_jsonl(self):
        self.run_validator([claim()], expected_items=0)

        written = [json.loads(l) for l in
                   (self.root / "pipeline" / "claims.jsonl").read_text().splitlines() if l.strip()]

        self.assertEqual(len(written), 1)
        self.assertIn("excerpt_span", written[0])
        self.assertIn("excerpt_normalized", written[0])


# --- Defect 4: dump skips.jsonl -------------------------------------------------------

class TestSkipsAreDumped(ValidatorRoot):
    @staticmethod
    def _skips(n):
        return [{"kind": "skip", "item_id": "111", "note_path": "bookmarks/n.md",
                 "enumeration_position": i,
                 "skipped_because": f"duplicate of item {i} with a different noun"}
                for i in range(1, n + 1)]

    def test_skips_jsonl_line_count_equals_the_number_of_justified_skips(self):
        """Acceptance check 5."""
        justified = self._skips(8)

        self.run_validator([claim()] + justified, expected_items=9)

        path = self.root / "pipeline" / "skips.jsonl"
        self.assertTrue(path.exists())
        lines = [l for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
        self.assertEqual(len(lines), len(justified))

    def test_skip_prose_reason_is_preserved_not_discarded(self):
        self.run_validator([claim()] + self._skips(2), expected_items=3)

        rows = [json.loads(l) for l in
                (self.root / "pipeline" / "skips.jsonl").read_text().splitlines() if l.strip()]

        self.assertTrue(all(r["skipped_because"] for r in rows))
        self.assertNotIn("_batch_file", rows[0])

    def test_an_unjustified_skip_is_flagged_and_not_written_to_skips(self):
        """Only credited skips are dumped; a reasonless skip stays a flag."""
        bad = {"kind": "skip", "item_id": "111", "note_path": "bookmarks/n.md",
               "enumeration_position": 1, "skipped_because": "  "}

        result = self.run_validator([bad], expected_items=0)

        lines = [l for l in (self.root / "pipeline" / "skips.jsonl")
                 .read_text(encoding="utf-8").splitlines() if l.strip()]
        self.assertEqual(lines, [])
        self.assertEqual(len(result.flagged), 1)


# --- Defect 5: view.py --fields passthrough ------------------------------------------

class TestViewFieldsPassthrough(unittest.TestCase):
    PASSTHROUGH = ["commercial_interest", "value_basis", "legal_risk",
                   "enumeration_position", "quote"]

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "pipeline").mkdir()
        rows = [claim(note_path="bookmarks/a.md", commercial_interest="sells_tool",
                      value_basis="monthly", legal_risk="tos_violation",
                      enumeration_position=7, quote="1. one")]
        with (self.root / "pipeline" / "claims.jsonl").open("w", encoding="utf-8") as fh:
            for c in rows:
                fh.write(json.dumps(c) + "\n")
        self.addCleanup(self._tmp.cleanup)

    def test_render_claims_emits_every_requested_field(self):
        """Acceptance check 6."""
        out = view.render_claims(view.load(self.root), fields=self.PASSTHROUGH)

        for field in self.PASSTHROUGH:
            self.assertIn(field, out)

    def test_requested_field_values_are_emitted_not_just_names(self):
        out = view.render_claims(view.load(self.root), fields=self.PASSTHROUGH)

        for value in ("sells_tool", "monthly", "tos_violation", "7"):
            self.assertIn(value, out)

    def test_default_output_is_unchanged_when_fields_is_absent(self):
        """Regression guard for the existing tier-2 line shape."""
        rows = view.load(self.root)

        self.assertEqual(view.render_claims(rows), view.render_claims(rows, fields=None))

    def test_a_field_absent_from_the_record_is_tolerated(self):
        """enumeration_position is NOT in REQUIRED, so it can legitimately be missing."""
        out = view.render_claims(view.load(self.root), fields=["no_such_field"])

        self.assertTrue(out.strip())


if __name__ == "__main__":
    unittest.main()
