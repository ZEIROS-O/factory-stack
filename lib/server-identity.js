"use strict";
// Does the Paperclip server that will execute a dispatch come from the tree
// you are editing?
//
// WHY THIS EXISTS. `ops/paperclip-status.sh` proves process identity: one
// tracked `paperclipai run`, owned by the named tmux session, named by
// `runtime-info.json`, listening and healthy. That is necessary and it is not
// sufficient. On 2026-09-02 every one of those facts held for a server running
// the binary from `worktrees/factory-finalization` at commit 4e7c1a6 while the
// operator edited `factory-stack` — a recurrence of the §5d incident. Both
// servers answered `status: ok`. Reads were fine. Dispatches were not: adapter
// plugins load at server start, so the code that executed a run came from a
// tree nobody was looking at.
//
// The shell script cannot know this, because git identity is not a process
// fact. `factory status` can, because Paperclip reports its own
// `serverInfo.git` and the CLI knows which repo it was loaded from.
//
// ONE MEASURED FACT SHAPES EVERY GATE BELOW. `serverInfo.git` is evaluated
// PER REQUEST, not captured at process start — verified 2026-09-02: a server
// launched at 568da81 reported 467b525 after two later commits landed in its
// tree. So comparing shas does NOT detect "the running process is older than
// the code on disk"; against the same tree the two sides always agree by
// construction. It detects a DIFFERENT TREE, which is a real and distinct
// condition.
//
// Staleness in time therefore needs its own gate, and it is the one that
// describes the actual incident: a server up since 09-01 02:02 while the tree
// moved on beneath it.
//
// THAT GATE IS SCOPED TO WHAT ACTUALLY LOADS AT SERVER START, not to the repo
// HEAD. Most commits here touch `lib/` — the CLI — and change nothing about a
// running server, so a gate keyed on HEAD would fail after every commit and
// train the operator to skip the one line that matters. What a restart really
// picks up is the server package itself and the adapter plugin registry;
// `configFiles`, `extensions` and the bwrap wrappers are read by the adapter
// at DISPATCH time, not at boot, so they do not belong here either.
//
// Every gate fails CLOSED. An observation that could not be made has proven
// nothing, and proving nothing is a failure — the same rule `lib/preflight.js`
// states and for the same reason: the alternative is a green check that means
// "the check broke".

const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** Short form for messages; full shas are unreadable side by side. */
const short = (sha) => (typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : String(sha ?? "?"));

const gate = (name, ok, detail = "") => ({ name, ok, detail });

/**
 * Parse `ps -eo pid=,args=` output down to the processes that own the
 * instance.
 *
 * Two exclusions carry weight:
 *
 *   - The tmux supervisor line contains the full server command as its
 *     argument, so a naive match counts every correctly tracked instance
 *     twice. `ops/paperclip-lifecycle.sh` drops it with the same rule.
 *   - A shell running `pgrep -af paperclipai` mentions the binary without
 *     being it. This is not hypothetical: any tooling that greps for the
 *     server puts its own command text in the table it is about to read, and
 *     the rogue chain of 2026-09-02 included `sh -c "paperclipai" run` as a
 *     wrapper around the process that actually served.
 *
 * So the match requires the PATH FORM — a `/paperclipai` executable followed
 * by the `run` subcommand — and drops `sh -c` wrappers. Node CLIs always
 * appear path-resolved in argv, so this costs nothing real and rejects the
 * mentions.
 *
 * It deliberately does NOT key on `--instance`: the rogue server arrived as a
 * bare `npm exec paperclipai run` with no instance flag at all, which is
 * precisely the shape a stricter matcher would miss.
 */
function parsePaperclipProcesses(psOutput) {
  return String(psOutput ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), args: m[2] } : null;
    })
    .filter(Boolean)
    .filter((p) => !/\btmux new-session\b/.test(p.args))
    .filter((p) => !/^(?:\S*\/)?(?:ba|da|z|k)?sh\s+-c\b/.test(p.args))
    .filter((p) => /\/paperclipai\s+run(?:\s|$)/.test(p.args));
}

/** `null` means the table could not be read — distinct from "no servers". */
function readPaperclipProcesses(exec = execFileSync) {
  try {
    return parsePaperclipProcesses(exec("ps", ["-eo", "pid=,args="], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

/** `null` means HEAD could not be resolved — distinct from any sha. */
function readHeadSha(root, exec = execFileSync) {
  try {
    const out = String(exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The things a Paperclip restart actually picks up, newest mtime wins.
 *
 *   - the server package, which is the code being executed;
 *   - the adapter plugin registry, because adapters are resolved and loaded
 *     once at boot — this is the mechanism behind the whole incident;
 *   - the instance config, which is read at start.
 *
 * Returns `{ at, source }`, or null if nothing could be stat'd — which fails
 * the gate closed rather than passing it silently.
 */
function readBootInputMtime(root, { fs = require("node:fs"), home = process.env.HOME } = {}) {
  const candidates = [
    [path.join(root, "node_modules/@paperclipai/server"), "@paperclipai/server"],
    [path.join(root, "node_modules/paperclipai"), "paperclipai"],
    [path.join(home ?? "", ".paperclip/adapter-plugins.json"), "adapter plugin registry"],
    [path.join(home ?? "", ".paperclip/instances/default/config.json"), "instance config"],
  ];
  let newest = null;
  for (const [file, source] of candidates) {
    try {
      const ms = fs.statSync(file).mtimeMs;
      if (!newest || ms > newest.ms) newest = { ms, at: new Date(ms).toISOString(), source };
    } catch { /* absent inputs are not evidence either way */ }
  }
  return newest;
}

/**
 * @param root          repo the CLI was loaded from (cfg._root)
 * @param health        the live `/api/health` payload
 * @param headSha       this repo's HEAD, or null if it could not be read
 * @param bootInput     {at, source} of the newest thing a restart would pick up,
 *                      or null if none could be read
 * @param processes     parsed `paperclipai run` processes, or null if unreadable
 */
function checkServerIdentity({ root, health, headSha, bootInput, processes }) {
  const checks = [];
  const git = health?.serverInfo?.git ?? null;

  // ---- 1. the server serves THIS tree -----------------------------------
  // Because git identity is read per request (see header), an equal sha means
  // "same tree", not "same vintage". A DIFFERENT sha is the signal that
  // matters: the server is reporting some other checkout's HEAD.
  const serverSha = git?.available === false ? null : (git?.fullSha ?? null);
  const dirty = git?.localChanges?.hasLocalChanges ? " (tree has uncommitted changes)" : "";
  if (!serverSha) {
    checks.push(gate("server serves this repo's tree", false,
      "the server did not report serverInfo.git.fullSha, so which tree it runs is unknown"));
  } else if (!headSha) {
    checks.push(gate("server serves this repo's tree", false,
      `could not read HEAD of ${root}; the server reports ${short(serverSha)} with nothing to compare it against`));
  } else if (serverSha !== headSha) {
    checks.push(gate("server serves this repo's tree", false,
      `server reports ${short(serverSha)}${git.branchName ? ` (${git.branchName})` : ""} ` +
      `but ${root} is at ${short(headSha)}. It is serving a different checkout. ` +
      `Restart with ops/paperclip-start.sh from ${root}.`));
  } else {
    checks.push(gate("server serves this repo's tree", true, `${short(serverSha)}${git.branchName ? ` (${git.branchName})` : ""}${dirty}`));
  }

  // ---- 2. the running process is not older than what it loaded ----------
  // THE GATE THAT DESCRIBES THE ACTUAL INCIDENT. Adapter plugins and the
  // server's module graph load once, at start, so a process older than those
  // inputs is executing superseded code however healthy it reports.
  const startedAt = health?.serverInfo?.processStartedAt ?? null;
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const inputMs = bootInput?.at ? Date.parse(bootInput.at) : NaN;
  if (!Number.isFinite(startedMs)) {
    checks.push(gate("server started after the code it loads", false,
      "the server did not report a usable processStartedAt"));
  } else if (!Number.isFinite(inputMs)) {
    checks.push(gate("server started after the code it loads", false,
      `could not stat the server package or adapter registry under ${root}`));
  } else if (inputMs > startedMs) {
    const mins = Math.round((inputMs - startedMs) / 60000);
    checks.push(gate("server started after the code it loads", false,
      `${bootInput.source} changed ${mins} minute(s) AFTER this server started ` +
      `(${startedAt}). Adapters and the server module graph load once, at boot, ` +
      `so this process is running superseded code. Restart it with ` +
      `ops/paperclip-stop.sh && ops/paperclip-start.sh.`));
  } else {
    checks.push(gate("server started after the code it loads", true, `up since ${startedAt}`));
  }

  // ---- 3. the server binary comes from this repo ------------------------
  // Independent of the commit on purpose: two trees can sit on the same sha
  // while only one has the plugin you just edited on disk.
  const wanted = path.join(root, "node_modules/.bin/paperclipai");
  if (processes === null) {
    checks.push(gate("server binary comes from this repo", false,
      "could not read the process table, so the launch path is unknown"));
  } else {
    const foreign = processes.filter((p) => !p.args.includes(wanted));
    if (!processes.length) {
      checks.push(gate("server binary comes from this repo", false,
        `no running paperclipai server; expected one launched from ${wanted}`));
    } else if (foreign.length) {
      checks.push(gate("server binary comes from this repo", false,
        `${foreign.map((p) => `pid ${p.pid}`).join(", ")} did not launch from ${wanted}: ` +
        foreign.map((p) => p.args).join(" | ")));
    } else {
      checks.push(gate("server binary comes from this repo", true, wanted));
    }
  }

  // ---- 4. exactly one server owns the instance --------------------------
  if (processes === null) {
    checks.push(gate("exactly one paperclipai run owns the instance", false,
      "could not read the process table"));
  } else if (processes.length !== 1) {
    checks.push(gate("exactly one paperclipai run owns the instance", false,
      processes.length === 0
        ? "found none; the control plane is down"
        : `found ${processes.length}: ${processes.map((p) => `pid ${p.pid}`).join(", ")}. ` +
          `They share one embedded Postgres, so stopping the tracked session takes the ` +
          `database down underneath the others. See ops/paperclip-status.sh.`));
  } else {
    checks.push(gate("exactly one paperclipai run owns the instance", true, `pid ${processes[0].pid}`));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/** Collect the live observations and grade them. */
function inspectServerIdentity({ root, health, exec = execFileSync } = {}) {
  return checkServerIdentity({
    root,
    health,
    headSha: readHeadSha(root, exec),
    bootInput: readBootInputMtime(root),
    processes: readPaperclipProcesses(exec),
  });
}

module.exports = {
  checkServerIdentity, inspectServerIdentity,
  parsePaperclipProcesses, readPaperclipProcesses, readHeadSha, readBootInputMtime,
};
