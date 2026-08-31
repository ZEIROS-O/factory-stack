"use strict";
// `factory promote` — the human approval stage, and the ONLY path by which
// agent work reaches git history.
//
// WHY THIS IS THE ONLY COMMIT PATH
//   ops/omp-bwrap.sh mounts the repository's shared git metadata read-only, so
//   an agent inside the sandbox physically cannot commit. That is deliberate:
//   the thing that decides what enters history should be the thing the operator
//   controls, running outside the sandbox, committing an exact reviewed set.
//
// WHAT PROMOTE MUST NEVER DO
//   Merge, push, deploy, or touch the operator's dirty primary tree. Every
//   operation below runs with `git -C <worktree>` against the linked worktree,
//   never against the primary checkout, and the primary tree is fingerprinted
//   before and after so that "it was not touched" is measured rather than
//   asserted.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { FactoryError, hashText, hashValue } = require("./util");

const BRANCH_PREFIX = "paperclip/";

function git(cwd, args, opts = {}) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/**
 * Every path the engineer changed in its worktree, tracked or not.
 *
 * `-z` and porcelain v1 because path parsing must survive spaces and unicode:
 * a promotion that silently drops a path with a space in it would commit a
 * subset of what was reviewed.
 */
function gatherChangedPaths(worktree) {
  const out = git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const parts = out.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    // A rename entry is followed by its source path in the next NUL field; the
    // destination is what exists now, the source is what must also be staged.
    if (status[0] === "R" || status[1] === "R") {
      const from = parts[++i];
      if (from) paths.push(from);
    }
    paths.push(p);
  }
  return [...new Set(paths)].sort();
}

function fileHash(abs) {
  try {
    return hashText(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null; // deleted
    throw err;
  }
}

/**
 * The reviewed change, content-addressed.
 *
 * CONTENT, NOT DIFF TEXT. `git diff` output varies with git version, config
 * (diff.algorithm, renames, context lines) and locale, so hashing it would make
 * "the same change" hash differently on two machines and turn a safety gate into
 * a source of spurious refusals. Hashing file content plus the base commit binds
 * exactly what the promotion claims: these bytes, applied to that base.
 */
function computeChangeSet(worktree, baseCommit) {
  const paths = gatherChangedPaths(worktree).map((p) => ({
    path: p,
    sha256: fileHash(path.join(worktree, p)),
  }));
  return { baseCommit, paths };
}

function computeDiffHash(changeSet) {
  return hashValue({
    baseCommit: changeSet.baseCommit,
    paths: [...changeSet.paths].sort((a, b) => a.path.localeCompare(b.path)),
  });
}

/**
 * Every changed path must fall inside the objective's granted write set.
 *
 * Matching is exact, or directory-containment with an explicit separator. A
 * naive prefix test would accept `bin/view.py.bak` for a grant of `bin/view.py`
 * — a different file, one character away from a legitimate one.
 */
function assertAllowedPaths(changed, allowed) {
  const grants = (allowed ?? []).map((a) => a.replace(/\/+$/, ""));
  const violations = [];
  for (const p of changed) {
    if (path.isAbsolute(p) || p.split("/").includes("..")) { violations.push(p); continue; }
    const norm = path.normalize(p).replace(/\/+$/, "");
    const ok = grants.some((g) => norm === g || (g !== "" && norm.startsWith(g + "/")) || g === ".");
    if (!ok) violations.push(p);
  }
  if (violations.length) {
    throw new FactoryError(
      `promotion refused: ${violations.length} changed path(s) outside the objective's granted write set: ` +
      `${violations.join(", ")}. Granted: ${grants.join(", ") || "(none)"}.`,
      { violations, granted: grants },
    );
  }
  return true;
}

/** The worktree must be on the objective's own branch, and that branch must keep the prefix. */
function assertBranch(actual, declared) {
  if (!String(declared).startsWith(BRANCH_PREFIX)) {
    throw new FactoryError(
      `objective declares branch ${JSON.stringify(declared)}, which does not carry the ${BRANCH_PREFIX} prefix. ` +
      `The prefix is what keeps agent branches identifiable in the operator's repository.`,
      { declared, prefix: BRANCH_PREFIX },
    );
  }
  if (actual !== declared) {
    throw new FactoryError(
      `promotion refused: worktree is on branch ${JSON.stringify(actual)}, not the objective's ${JSON.stringify(declared)}`,
      { actual, declared },
    );
  }
  return true;
}

/** The worktree must still stand exactly where the objective said it would. */
function assertBaseCommit(worktree, expected) {
  let resolved;
  try {
    resolved = git(worktree, ["rev-parse", "--verify", `${expected}^{commit}`]).trim();
  } catch {
    throw new FactoryError(
      `promotion refused: the objective's base commit ${JSON.stringify(expected)} does not exist in this worktree`,
      { expected },
    );
  }
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();
  if (head !== resolved) {
    throw new FactoryError(
      `promotion refused: worktree HEAD is ${head}, not the objective's base commit ${resolved} (${expected}). ` +
      `The reviewed work was derived from a different base than the one being promoted onto.`,
      { head, expected, resolved },
    );
  }
  return { head, resolved };
}

/**
 * A content fingerprint of specific paths, used to PROVE the operator's tree did
 * not move across a promotion rather than to assert it.
 */
function fingerprintPaths(root, paths) {
  return hashValue([...paths].sort().map((p) => ({ path: p, sha256: fileHash(path.join(root, p)) })));
}

/**
 * Stage exactly the reviewed paths and commit them in the worktree.
 *
 * `git add -- <paths>` and nothing wider: a promotion commits what was reviewed,
 * so an unreviewed file left in the worktree stays uncommitted rather than
 * riding along. There is no push, and there never should be.
 */
function commitReviewedPaths({ worktree, paths, message }) {
  if (!paths?.length) throw new FactoryError("promotion refused: no reviewed paths to commit");
  git(worktree, ["add", "--", ...paths]);

  const staged = git(worktree, ["diff", "--cached", "--name-only"]).trim();
  if (!staged) {
    throw new FactoryError(
      `promotion refused: nothing to commit for the reviewed paths (${paths.join(", ")}). ` +
      `Minting an empty commit would attest to work that does not exist.`,
      { paths },
    );
  }

  git(worktree, ["commit", "-q", "-m", message]);
  const commit = git(worktree, ["rev-parse", "HEAD"]).trim();
  return { commit, paths: staged.split("\n").filter(Boolean) };
}

module.exports = {
  BRANCH_PREFIX,
  gatherChangedPaths, computeChangeSet, computeDiffHash,
  assertAllowedPaths, assertBranch, assertBaseCommit,
  fingerprintPaths, commitReviewedPaths,
};
