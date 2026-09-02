"use strict";
// Static analysis of ops/omp-bwrap.sh and ops/hermes-bwrap.sh.
//
// Deliberately bwrap-free: it reads the scripts as text, so it passes in a
// managed sandbox where bwrap itself is unavailable. It asserts the
// containment STRUCTURE — profile derivation, masks, bind directions, strip
// parity, fail-closed exit codes — the invariants a future edit could break
// silently. Behaviour only observable by actually running bwrap (e.g. that
// a bind over a symlink resolves inside) belongs in test/integration and
// needs an authorized environment.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const OPS = path.resolve(__dirname, "../..", "ops");
const OMP = fs.readFileSync(path.join(OPS, "omp-bwrap.sh"), "utf8");
const HERMES = fs.readFileSync(path.join(OPS, "hermes-bwrap.sh"), "utf8");

const CLAUDE_SKILL_DIRS = [
  "~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills",
  "~/.claude/skills",
];

function stripValues(script, varName) {
  // Returns the whitespace-joined word list assigned to STRIP_EXACT/STRIP_PREFIX.
  const re = new RegExp(`^${varName}="([^"]*)"`, "m");
  const m = script.match(re);
  assert.ok(m, `${varName} must be defined in the script`);
  return m[1].trim().split(/\s+/).filter(Boolean);
}

test("both scripts are strict and fail closed", () => {
  for (const [name, src] of [["omp-bwrap.sh", OMP], ["hermes-bwrap.sh", HERMES]]) {
    assert.match(src, /^#!\/usr\/bin\/env bash/m, `${name} is bash`);
    assert.match(src, /set -euo pipefail/, `${name} is strict`);
    // Every exit is a documented fail-closed code. Distinctness per named
    // condition is asserted for hermes-bwrap below (its conditions are
    // required to be distinct); omp-bwrap inherits codes the operator
    // already shipped (127 twice, 78 twice, for different conditions), so
    // only multiplicity is asserted here.
    const exits = [...src.matchAll(/exit (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(exits.length >= 4, `${name} has multiple distinct exit paths`);
  }
});

test("hermes-bwrap.sh fails closed with distinct exit codes per condition", () => {
  // The task names six conditions, each with its own code:
  //   127 bwrap missing, 126 hermes missing, 65 bad profile name,
  //   78 profile dir absent, 66 workspace not a directory, 73 mask file.
  const exits = [...HERMES.matchAll(/exit (\d+)/g)].map((m) => Number(m[1]));
  const set = new Set(exits);
  // Six conditions, six codes. The invalid-profile-name check appears in two
  // branches (the .. guard and the regex guard) and correctly exits the SAME
  // code 65, so only the SET is asserted, plus that no stray code slipped in.
  assert.deepEqual([...set].sort((a, b) => a - b), [65, 66, 73, 78, 126, 127],
    "exactly the six documented fail-closed codes");
});

test("omp-bwrap.sh derives the profile from the adapter environment and validates it", () => {
  assert.match(OMP, /PROFILE="\$\{OMP_PROFILE:-\$\{PAPERCLIP_OMP_PROFILE:-\}\}"/,
    "profile comes from OMP_PROFILE or PAPERCLIP_OMP_PROFILE");
  // The adapter's own profile-name grammar, in the script's anchor form:
  // ^[a-z0-9][a-z0-9._-]{0,63}$ (the leading ^ is the regex anchor, not a
  // negated class).
  assert.match(OMP, /\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$/,
    "profile name regex");
  // ".." must never reach a path; the task names it explicitly.
  assert.match(OMP, /\*\.\.\*/, "rejects any profile containing '..'");
  assert.match(OMP, /\*\.\)/, "rejects profile names ending in '.' (adapter parity)");
  assert.match(OMP, /PROFILE_ROOT="\$HOME\/\.omp\/profiles\/\$PROFILE"/,
    "the profile root is derived from the validated profile name");
  assert.match(OMP, /PROFILE_DIR="\$PROFILE_ROOT\/agent"/,
    "the agent state root is still the per-profile agent dir, now expressed under the root");
});

test("omp-bwrap.sh masks the operator's global CLAUDE.md with a real empty file", () => {
  assert.match(OMP, /--ro-bind "\$EMPTY_MASK" "\$HOME\/\.claude\/CLAUDE\.md"/,
    "binds an empty file over the personal CLAUDE.md");
  assert.match(OMP, /EMPTY_MASK="\$HOME\/\.cache\/factory\/empty-mask"/,
    "uses a stable real empty file, not /dev/null");
  // Verified finding embedded as evidence: /dev/null over a regular file
  // fails on bwrap 0.6.1, which is why the real file is required.
  assert.match(OMP, /\/dev\/null/, "documents the /dev/null verification");
  // The mask must apply AFTER the read-only root (mount order is load-bearing).
  assert.ok(OMP.indexOf("--ro-bind / /") < OMP.indexOf('--ro-bind "$EMPTY_MASK"'),
    "mask comes after --ro-bind / /");
});

test("omp-bwrap.sh does NOT mask the approved skill directories", () => {
  // The script names the skill paths so the guarantee is stated where it is
  // meant — this asserts they are named AND that no empty-file bind or tmpfs
  // ever lands on them.
  for (const dir of CLAUDE_SKILL_DIRS) {
    assert.ok(OMP.includes(dir), `skill dir named so it stays readable: ${dir}`);
    assert.doesNotMatch(OMP, new RegExp(`--ro-bind "[^"]*" "${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `no mask on ${dir}`);
    assert.doesNotMatch(OMP, new RegExp(`--tmpfs "${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `no tmpfs on ${dir}`);
  }
});

test("omp-bwrap.sh binds the per-profile tree when a profile is set, and the global agent dir only when not", () => {
  assert.match(OMP, /args\+=\( --bind "\$PROFILE_ROOT" "\$PROFILE_ROOT" \)/,
    "binds the profile tree; see the EROFS canary finding for why the agent subdir alone is not enough");
  assert.match(OMP, /args\+=\( --bind "\$HOME\/\.omp\/agent" "\$HOME\/\.omp\/agent" \)/,
    "legacy global agent binding still exists");
  // logs/run/paperclip stay writable in both branches.
  assert.match(OMP, /"\$HOME\/\.omp\/logs" "\$HOME\/\.omp\/run" "\$HOME\/\.omp\/paperclip"/,
    "shared OMP dirs remain writable");
  // Binding is conditional on the profile existing.
  assert.match(OMP, /if \[ -n "\$PROFILE_ROOT" \]/, "profile binding is conditional");
});

test("hermes-bwrap.sh pins HERMES_HOME to the Paperclip profile", () => {
  assert.match(HERMES, /PROFILE="\$\{FACTORY_HERMES_PROFILE:-paperclip-hermes\}"/,
    "default profile is paperclip-hermes");
  // Hermes profile grammar: ^[a-z0-9][a-z0-9_-]{0,63}$ (no dots, unlike OMP).
  assert.match(HERMES, /\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$/,
    "hermes profile grammar (no dots)");
  assert.match(HERMES, /\*\.\.\*/, "rejects '..' in profile names");
  assert.match(HERMES, /--setenv HERMES_HOME "\$PROFILE_DIR"/,
    "HERMES_HOME is pinned via the sandbox environment");
});

test("hermes-bwrap.sh ro-binds the workspace and never --binds it", () => {
  assert.match(HERMES, /--ro-bind "\$WS_REAL" "\$WS_REAL"/, "workspace is read-only");
  assert.doesNotMatch(HERMES, /--bind "\$WS_REAL"/, "workspace is never writable");
  assert.match(HERMES, /PAPERCLIP_WORKSPACE_WORKTREE_PATH:\-\$\{PAPERCLIP_WORKSPACE_CWD/,
    "workspace comes from the adapter environment");
});

test("hermes-bwrap.sh masks the personal Hermes files and keeps the profiles root traversable", () => {
  // Personal FILES are masked by binding the shared empty file over
  // $HOME/.hermes/<name> in a loop; the loop names exactly the personal set.
  assert.match(HERMES, /for f in config\.yaml SOUL\.md \.env auth\.json; do/,
    "masks the personal files by name");
  assert.match(HERMES, /--ro-bind "\$EMPTY_MASK" "\$HOME\/\.hermes\/\$f"/,
    "binds the empty mask over each personal file");
  // Personal DIRECTORIES are hidden with a tmpfs, also in a loop.
  assert.match(HERMES, /for d in memories cron sessions; do/,
    "masks the personal directories by name");
  assert.match(HERMES, /--tmpfs "\$HOME\/\.hermes\/\$d"/,
    "hides each personal directory with a tmpfs");
  assert.match(HERMES, /--tmpfs/, "hides directories with a tmpfs");
  // The root and the profiles/ root must stay traversable: never masked
  // wholesale, never a tmpfs over ~/.hermes itself.
  assert.doesNotMatch(HERMES, /--tmpfs "\$HOME\/\.hermes"(\s|$)/, "no wholesale ~/.hermes tmpfs");
  assert.doesNotMatch(HERMES, /--ro-bind "\$EMPTY_MASK" "\$HOME\/\.hermes"(\s|$)/,
    "no wholesale ~/.hermes mask");
  assert.match(HERMES, /profiles/, "profiles root remains part of the mount plan");
  assert.match(HERMES, /personal Hermes state at ~\/\.hermes is MASKED/,
    "header documents the individual-mask design");
});

test("the two scripts strip the same credential lists (parity, no silent divergence)", () => {
  const ompExact = stripValues(OMP, "STRIP_EXACT");
  const hermesExact = stripValues(HERMES, "STRIP_EXACT");
  const ompPrefix = stripValues(OMP, "STRIP_PREFIX");
  const hermesPrefix = stripValues(HERMES, "STRIP_PREFIX");
  assert.deepEqual(hermesExact, ompExact, "STRIP_EXACT parity");
  assert.deepEqual(hermesPrefix, ompPrefix, "STRIP_PREFIX parity");
  assert.ok(ompExact.includes("GITHUB_TOKEN") && !ompExact.includes("OPENROUTER"),
    "model keys survive the strip");
  assert.ok(ompPrefix.includes("AWS_"), "prefix strip list populated");
});

test("hermes-bwrap.sh forwards all arguments unchanged", () => {
  assert.match(HERMES, /exec bwrap "\$\{args\[@\]\}" -- "\$REAL_HERMES" "\$@"/,
    "execs the real hermes with the full original argv");
  assert.match(HERMES, /FACTORY_REAL_HERMES/, "hermes binary is overridable for tests");
});
// ── the profile ROOT is the writable unit, not the agent subdirectory ────────
//
// Found by the first live canary. With OMP_PROFILE set, OMP relocates its
// runtime directories under ~/.omp/profiles/<profile>/ — `run/` alongside
// `agent/`, not inside it. The sandbox bound only <profile>/agent, so the very
// first thing OMP did inside the sandbox was
//
//   EROFS: read-only file system, mkdir '/home/lucascoh/.omp/profiles/paperclip-engineer/run'
//
// The isolation property is unchanged by widening to the profile root: the
// operator's global ~/.omp/agent still stays read-only under a profile. What
// widens is only the profile's OWN tree, which is the thing the profile exists
// to give this agent.

test("omp-bwrap.sh binds the whole profile root writable, so OMP can create its runtime dirs", () => {
  assert.match(OMP, /PROFILE_ROOT="\$HOME\/\.omp\/profiles\/\$PROFILE"/,
    "the profile root is named as its own variable");
  assert.match(OMP, /args\+=\( --bind "\$PROFILE_ROOT" "\$PROFILE_ROOT" \)/,
    "the profile root is what gets bound writable; binding only <profile>/agent made `run/` read-only");
});

test("omp-bwrap.sh still keeps the operator's global agent dir read-only under a profile", () => {
  // Widening to the profile root must not have widened anything else: the
  // global agent binding stays inside the no-profile branch only.
  const profileBranch = OMP.slice(OMP.indexOf('if [ -n "$PROFILE_ROOT" ]'), OMP.indexOf("# The adapter's per-agent session directory"));
  assert.doesNotMatch(profileBranch.split("else")[0], /\$HOME\/\.omp\/agent/,
    "the global agent dir must never be bound writable while a profile is active");
});

// ── the task bounds must live where they are actually loaded ────────────────
//
// They used to live in omp/profiles/<agent>/config.yml, which OMP reads ONLY
// under --profile. Dropping --profile (because profiles isolate auth by
// design, and the factory has no separate credential to isolate yet) would
// therefore have silently restored OMP's defaults: the Engineer from depth 1
// to 2 with no runtime cap, and the Reviewer from no subagents at all to 2,
// concurrency 32, and no cap. Those are budget-burn bounds, so they moved into
// the `--config` policy overlays, which load on every run either way.
const REPO = path.resolve(__dirname, "../..");
const ENGINEER_POLICY = fs.readFileSync(path.join(REPO, "omp/engineer.policy.yml"), "utf8");
const REVIEWER_POLICY = fs.readFileSync(path.join(REPO, "omp/reviewer.policy.yml"), "utf8");

test("the engineer policy overlay carries the subagent and runtime bounds", () => {
  assert.match(ENGINEER_POLICY, /^task:/m, "the overlay declares a task block");
  assert.match(ENGINEER_POLICY, /maxRecursionDepth:\s*1\b/, "subagents yes, sub-subagents no");
  assert.match(ENGINEER_POLICY, /maxConcurrency:\s*8\b/);
  assert.match(ENGINEER_POLICY, /maxRuntimeMs:\s*1800000\b/, "30-minute hard cap per subagent");
});

test("the reviewer policy overlay withholds subagents entirely", () => {
  assert.match(REVIEWER_POLICY, /^task:/m);
  assert.match(REVIEWER_POLICY, /maxRecursionDepth:\s*0\b/, "the Reviewer spawns nothing");
  assert.match(REVIEWER_POLICY, /maxConcurrency:\s*1\b/);
  assert.match(REVIEWER_POLICY, /maxRuntimeMs:\s*300000\b/);
});
