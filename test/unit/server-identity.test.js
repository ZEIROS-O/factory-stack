"use strict";
// The server that executes a dispatch must come from the tree you are editing.
//
// WHY THIS EXISTS. On 2026-09-02 two Paperclip servers shared one embedded
// Postgres: the tracked tmux session ran the binary from
// worktrees/factory-finalization (commit 4e7c1a6) while `factory.config.json`
// pointed the CLI at it and the operator edited factory-stack. Both answered
// `status: ok`. Every read looked healthy and every dispatch ran adapter
// plugins loaded at the older tree's server start. `ops/paperclip-status.sh`
// caught the PID/port half of that condition and failed closed; nothing
// checked GIT IDENTITY, which is the half that decides which code actually
// executes a run.
//
// MEASURED 2026-09-02: `serverInfo.git` is evaluated per REQUEST, not captured
// at process start — a server launched at 568da81 reported 467b525 once two
// later commits landed in its tree. So a sha comparison proves "same tree",
// not "same vintage", and staleness in time needs the separate
// processStartedAt-vs-HEAD-commit-time gate. The tests below hold that
// distinction, because a suite that conflated them would pass while the gate
// it describes did nothing.
//
// These gates are pure over injected observations so the failure modes can be
// asserted without a live server. Every one fails CLOSED: an observation that
// could not be made has proven nothing.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkServerIdentity, parsePaperclipProcesses,
} = require("../../lib/server-identity");

const ROOT = "/home/lucascoh/factory-stack";
const SHA = "568da813e9c0874deea91005efa3163b9d118b9f";

const STARTED = "2026-09-02T20:03:54.285Z";
const COMMITTED = "2026-09-02T19:00:00.000Z";   // before STARTED: not stale

const health = (over = {}) => ({
  status: "ok",
  serverInfo: {
    processStartedAt: over.processStartedAt ?? STARTED,
    git: {
      available: true, fullSha: SHA, shortSha: SHA.slice(0, 7),
      branchName: "master", subject: "a commit",
      ...(over.git ?? {}),
    },
    ...(over.serverInfo ?? {}),
  },
});

const proc = (root, pid = 620282) => ({
  pid, args: `node ${root}/node_modules/.bin/paperclipai run --instance default --config /home/lucascoh/.paperclip/instances/default/config.json`,
});

const named = (result, fragment) =>
  result.checks.find((c) => c.name.includes(fragment));

test("a server built from this repo's HEAD, alone, passes every gate", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA, headCommittedAt: COMMITTED, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, true);
  assert.equal(r.checks.filter((c) => !c.ok).length, 0);
});

test("a server running a different commit is reported, with both shas named", () => {
  const stale = "4e7c1a6e4f799528eccdd64107daf4a94a3d5af7";
  const r = checkServerIdentity({
    root: ROOT,
    health: health({ git: { fullSha: stale, shortSha: "4e7c1a6", branchName: "feat/factory-finalization" } }),
    headSha: SHA, headCommittedAt: COMMITTED,
    processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  const c = named(r, "serves this repo");
  assert.equal(c.ok, false);
  // Both sides must appear: "it drifted" without the two values is unactionable.
  assert.match(c.detail, /4e7c1a6/);
  assert.match(c.detail, /568da81/);
  assert.match(c.detail, /feat\/factory-finalization/);
});

test("a server launched from another tree is caught even when the commit matches", () => {
  // The exact 2026-09-02 near-miss inverse: two trees can sit on the same
  // commit while only one of them has the adapter plugins you just edited.
  const other = "/home/lucascoh/worktrees/factory-context-arch";
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA, headCommittedAt: COMMITTED, processes: [proc(other)],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "serves this repo").ok, true, "the commit gate is independent and still passes");
  const c = named(r, "binary");
  assert.equal(c.ok, false);
  assert.match(c.detail, /factory-context-arch/);
});

test("two servers sharing the instance fail the single-owner gate", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA, headCommittedAt: COMMITTED,
    processes: [proc(ROOT, 620282), proc("/home/lucascoh/worktrees/factory-finalization", 112128)],
  });
  assert.equal(r.ok, false);
  const c = named(r, "exactly one");
  assert.equal(c.ok, false);
  assert.match(c.detail, /620282/);
  assert.match(c.detail, /112128/);
});

test("no server at all fails the single-owner gate rather than passing vacuously", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA, headCommittedAt: COMMITTED, processes: [],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "exactly one").ok, false);
});

// ---- fail-closed: an observation that could not be made proves nothing ----

test("a health payload without git identity fails closed", () => {
  const r = checkServerIdentity({
    root: ROOT, health: { status: "ok", serverInfo: {} }, headSha: SHA, headCommittedAt: COMMITTED, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "serves this repo").ok, false);
});

test("a server reporting git.available false fails closed", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health({ git: { available: false, fullSha: null } }),
    headSha: SHA, headCommittedAt: COMMITTED, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "serves this repo").ok, false);
});

test("an unreadable local HEAD fails closed instead of skipping the comparison", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: null, headCommittedAt: COMMITTED, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "serves this repo").ok, false);
});

test("an unreadable process table fails both process gates closed", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA, headCommittedAt: COMMITTED, processes: null,
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "binary").ok, false);
  assert.equal(named(r, "exactly one").ok, false);
});

test("a dirty server tree is noted but does not fail the gate", () => {
  // Uncommitted work is the normal state of a tree under development, and it
  // does not change the bytes a running server already loaded. Failing on it
  // would make `factory status` exit 1 for the whole of every working session,
  // which trains the operator to ignore the one line that matters.
  const r = checkServerIdentity({
    root: ROOT,
    health: health({ git: { localChanges: { available: true, hasLocalChanges: true, unstagedFileCount: 3 } } }),
    headSha: SHA, headCommittedAt: COMMITTED, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, true);
  const c = named(r, "serves this repo");
  assert.equal(c.ok, true);
  assert.match(c.detail, /uncommitted/i);
});

// ---- staleness in time: the gate that describes the real incident ----

test("a server that started BEFORE the current HEAD was committed is stale", () => {
  const r = checkServerIdentity({
    root: ROOT,
    health: health(),                                  // started 20:03:54Z
    headSha: SHA,
    headCommittedAt: "2026-09-02T20:44:00.000Z",       // committed 40 min later
    processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  const c = named(r, "started after");
  assert.equal(c.ok, false);
  assert.match(c.detail, /40 minute/);
  assert.match(c.detail, /paperclip-start\.sh/);
  // The sha gate must NOT fire here: same tree, and it is read per request.
  assert.equal(named(r, "serves this repo").ok, true,
    "sha equality cannot detect staleness in time — that is why this gate exists");
});

test("a server started after the last commit is not stale", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA,
    headCommittedAt: "2026-09-02T19:00:00.000Z",
    processes: [proc(ROOT)],
  });
  assert.equal(named(r, "started after").ok, true);
});

test("a missing processStartedAt fails the staleness gate closed", () => {
  const h = health();
  delete h.serverInfo.processStartedAt;
  const r = checkServerIdentity({
    root: ROOT, health: h, headSha: SHA, headCommittedAt: COMMITTED, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "started after").ok, false);
});

test("an unreadable HEAD commit time fails the staleness gate closed", () => {
  const r = checkServerIdentity({
    root: ROOT, health: health(), headSha: SHA, headCommittedAt: null, processes: [proc(ROOT)],
  });
  assert.equal(r.ok, false);
  assert.equal(named(r, "started after").ok, false);
});

// ---- process-table parsing ----

test("the tmux supervisor line is not counted as a server", () => {
  // `ops/paperclip-lifecycle.sh` excludes it with the same rule. A parser that
  // counted it would report two owners for every correctly tracked instance.
  const rows = [
    "112127 tmux new-session -d -s paperclip-default exec '/home/lucascoh/factory-stack/node_modules/.bin/paperclipai' run --instance 'default'",
    "620282 node /home/lucascoh/factory-stack/node_modules/.bin/paperclipai run --instance default",
  ].join("\n");
  const got = parsePaperclipProcesses(rows);
  assert.equal(got.length, 1);
  assert.equal(got[0].pid, 620282);
});

test("an unrelated process merely mentioning paperclipai is not counted", () => {
  const rows = [
    "999 bash -c pgrep -af paperclipai run",
    "620282 node /home/lucascoh/factory-stack/node_modules/.bin/paperclipai run --instance default",
  ].join("\n");
  const got = parsePaperclipProcesses(rows);
  assert.deepEqual(got.map((p) => p.pid), [620282]);
});

test("an npm-exec bare `paperclipai run` IS counted — that is how the rogue arrived", () => {
  // PID 518405 on 2026-09-02 was `node …/node_modules/.bin/paperclipai run`
  // with no --instance, launched by `npm exec paperclipai run` from a shell.
  // A parser keyed on --instance would have missed exactly the process that
  // caused the incident.
  const rows = "518405 node /home/lucascoh/factory-stack/node_modules/.bin/paperclipai run";
  const got = parsePaperclipProcesses(rows);
  assert.equal(got.length, 1);
  assert.equal(got[0].pid, 518405);
});

test("a shell command that greps for the server is not counted, even path-qualified", () => {
  // Any tool that inspects the process table writes its own command into it.
  const rows = [
    "888 bash -c pgrep -af /home/lucascoh/factory-stack/node_modules/.bin/paperclipai run",
    "620282 node /home/lucascoh/factory-stack/node_modules/.bin/paperclipai run --instance default",
  ].join("\n");
  assert.deepEqual(parsePaperclipProcesses(rows).map((p) => p.pid), [620282]);
});
