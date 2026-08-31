"use strict";
// `factory promote` is the only sanctioned commit path in the whole system: the
// Engineer's sandbox cannot write shared git objects, so nothing reaches history
// except through here. These tests drive real git repositories, because the
// properties being asserted — what got committed, on which branch, and whether
// the operator's own tree moved — are not observable against a mock.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  gatherChangedPaths, computeChangeSet, computeDiffHash,
  assertAllowedPaths, assertBranch, assertBaseCommit,
  fingerprintPaths, commitReviewedPaths,
} = require("../../lib/promote");
const { FactoryError } = require("../../lib/util");

// A primary repo with the operator's own uncommitted work in it, plus a linked
// worktree on a paperclip/ branch — the real shape at promote time.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promote-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", encoding: "utf8" });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "bin"));
  fs.writeFileSync(path.join(repo, "bin/view.py"), "print('base')\n");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const baseCommit = git("rev-parse", "HEAD").trim();

  // The operator's dirty work. Nothing below may ever touch this.
  fs.writeFileSync(path.join(repo, "OPERATOR-WIP.txt"), "do not touch\n");

  const wt = path.join(root, "wt");
  git("worktree", "add", "-q", wt, "-b", "paperclip/ZEI-1");
  return {
    root, repo, wt, baseCommit, git,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const OBJECTIVE = (f) => ({
  objectiveId: "ZEI-1",
  revision: 1,
  objectiveHash: "sha256:" + "a".repeat(64),
  criteriaHash: "sha256:" + "b".repeat(64),
  repository: { path: "/repo", baseCommit: f.baseCommit, branch: "paperclip/ZEI-1" },
  permissions: { filesystem: { read: ["."], write: ["bin/view.py", "tests/test_bin_defects.py"] } },
  acceptanceCriteria: [],
});

// --------------------------------------------------------------- change set

test("the change set is exactly what the engineer left in the worktree", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, "bin/view.py"), "print('fixed')\n");
    fs.mkdirSync(path.join(f.wt, "tests"));
    fs.writeFileSync(path.join(f.wt, "tests/test_bin_defects.py"), "def test_x():\n    assert True\n");

    const changed = gatherChangedPaths(f.wt);
    assert.deepEqual(changed.sort(), ["bin/view.py", "tests/test_bin_defects.py"]);
  } finally { f.cleanup(); }
});

test("the diff hash binds file CONTENT to the base commit, not diff text", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, "bin/view.py"), "print('fixed')\n");
    const a = computeChangeSet(f.wt, f.baseCommit);
    const b = computeChangeSet(f.wt, f.baseCommit);
    assert.equal(computeDiffHash(a), computeDiffHash(b), "the same tree must hash the same twice");
    assert.match(computeDiffHash(a), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(a.paths.map((p) => p.path), ["bin/view.py"]);
    assert.match(a.paths[0].sha256, /^sha256:/);

    // A one-byte content change must move the hash: this is the value that ties
    // "what the reviewer judged" to "what gets committed".
    fs.writeFileSync(path.join(f.wt, "bin/view.py"), "print('fixed') \n");
    const c = computeChangeSet(f.wt, f.baseCommit);
    assert.notEqual(computeDiffHash(a), computeDiffHash(c));

    // And so must a different base, for identical content.
    const d = computeChangeSet(f.wt, "0".repeat(40));
    assert.notEqual(computeDiffHash(c), computeDiffHash(d));
  } finally { f.cleanup(); }
});

// ------------------------------------------------------------------- gates

test("promote refuses a path the objective did not grant write permission to", () => {
  const f = fixture();
  try {
    const allowed = OBJECTIVE(f).permissions.filesystem.write;
    assert.doesNotThrow(() => assertAllowedPaths(["bin/view.py"], allowed));

    assert.throws(() => assertAllowedPaths(["bin/view.py", "README.md"], allowed),
      (err) => {
        assert.ok(err instanceof FactoryError);
        assert.match(err.message, /README\.md/);
        return true;
      }, "a file outside the granted write set must block the whole promotion");

    // Prefix-looking paths must not sneak past a naive startsWith check.
    assert.throws(() => assertAllowedPaths(["bin/view.py.bak"], allowed), /view\.py\.bak/);
    assert.throws(() => assertAllowedPaths(["../outside.py"], allowed), /outside/);
  } finally { f.cleanup(); }
});

test("promote refuses a branch that is not the objective's own paperclip branch", () => {
  assert.doesNotThrow(() => assertBranch("paperclip/ZEI-1", "paperclip/ZEI-1"));
  assert.throws(() => assertBranch("main", "paperclip/ZEI-1"), /main/);
  assert.throws(() => assertBranch("paperclip/ZEI-2", "paperclip/ZEI-1"), /ZEI-2/);
  // The prefix alone is not enough; it must be the declared branch.
  assert.throws(() => assertBranch("paperclip/ZEI-1-extra", "paperclip/ZEI-1"), /ZEI-1-extra/);
  // And a branch that abandons the prefix entirely is refused even if declared,
  // because the prefix is what keeps agent branches identifiable.
  assert.throws(() => assertBranch("feature/x", "feature/x"), /paperclip\//);
});

test("promote refuses when the worktree is not standing on the objective's base commit", () => {
  const f = fixture();
  try {
    assert.doesNotThrow(() => assertBaseCommit(f.wt, f.baseCommit));
    assert.throws(() => assertBaseCommit(f.wt, "0".repeat(40)), /base commit/);

    // An abbreviated base commit, as the objective envelope records it, still matches.
    assert.doesNotThrow(() => assertBaseCommit(f.wt, f.baseCommit.slice(0, 7)));
  } finally { f.cleanup(); }
});

// ------------------------------------------------------ the operator's tree

test("the primary-tree fingerprint changes when the operator's own work changes", () => {
  const f = fixture();
  try {
    const paths = ["OPERATOR-WIP.txt", "README.md"];
    const before = fingerprintPaths(f.repo, paths);
    assert.equal(fingerprintPaths(f.repo, paths), before, "fingerprinting must be stable");

    fs.writeFileSync(path.join(f.repo, "OPERATOR-WIP.txt"), "changed\n");
    assert.notEqual(fingerprintPaths(f.repo, paths), before,
      "a fingerprint that cannot see the operator's edit cannot protect it");
  } finally { f.cleanup(); }
});

// ------------------------------------------------------------- the commit

test("promote commits exactly the reviewed paths and leaves everything else alone", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, "bin/view.py"), "print('fixed')\n");
    // Something the reviewer never saw, left in the worktree.
    fs.writeFileSync(path.join(f.wt, "STRAY.txt"), "not reviewed\n");

    const res = commitReviewedPaths({
      worktree: f.wt, paths: ["bin/view.py"],
      message: "ZEI-1: reviewed change",
    });
    assert.match(res.commit, /^[0-9a-f]{40}$/);

    const show = execFileSync("git", ["-C", f.wt, "show", "--name-only", "--format=", res.commit], { encoding: "utf8" });
    assert.deepEqual(show.trim().split("\n"), ["bin/view.py"],
      "an unreviewed file must not ride along in the reviewed commit");

    // The stray file is still there, uncommitted — untouched, not deleted.
    assert.equal(fs.readFileSync(path.join(f.wt, "STRAY.txt"), "utf8"), "not reviewed\n");
  } finally { f.cleanup(); }
});

test("promoting never modifies the operator's primary tree", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, "bin/view.py"), "print('fixed')\n");
    const watched = ["OPERATOR-WIP.txt", "README.md", "bin/view.py"];
    const before = fingerprintPaths(f.repo, watched);
    const headBefore = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    commitReviewedPaths({ worktree: f.wt, paths: ["bin/view.py"], message: "ZEI-1: reviewed change" });

    assert.equal(fingerprintPaths(f.repo, watched), before,
      "the operator's working tree must be byte-identical after a promotion");
    assert.equal(execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headBefore,
      "the primary branch must not move");
  } finally { f.cleanup(); }
});

test("promote refuses to commit a path that is not actually changed", () => {
  const f = fixture();
  try {
    assert.throws(
      () => commitReviewedPaths({ worktree: f.wt, paths: ["bin/view.py"], message: "empty" }),
      /nothing to commit|no changes/i,
      "an empty promotion would mint a commit that attests to work nobody did",
    );
  } finally { f.cleanup(); }
});
