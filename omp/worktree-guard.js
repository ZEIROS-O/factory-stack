// OMP path confinement — DEFENCE IN DEPTH AND DIAGNOSTICS.
//
// READ THIS FIRST: this file is no longer the boundary.
//
// The boundary is ops/omp-bwrap.sh, which mounts the operator's primary tree and
// the repository's shared git metadata read-only at the kernel level. That holds
// whatever the agent does and whatever this hook decides, and it is proven by
// test/integration/sandbox.test.js. An in-process hook can never be a security
// boundary against the process it lives inside: the same runtime that loads it
// can, in principle, route around it.
//
// So the job here is narrower, and still worth doing:
//   - fail EARLY, with a legible reason the agent can act on, instead of letting
//     it discover confinement as a mystery EROFS halfway through a task;
//   - catch what the mount layer cannot see — above all a mutation aimed at a
//     path that is inside the worktree but on the WRONG BRANCH;
//   - refuse anything it does not positively understand.
//
// FAIL-CLOSED IS THE WHOLE POSTURE. Every check below blocks on missing,
// malformed, or unrecognised input. A mutating tool whose argument shape this
// file does not recognise is blocked rather than waved through, because
// "I could not find a path to check" and "there is no path to check" are
// indistinguishable from here, and only one of them is safe.

import fs from "node:fs";
import path from "node:path";

/** Tools that can change the filesystem. Anything here must prove its target. */
const MUTATING = new Set(["write", "edit", "multiedit", "notebook", "apply_patch", "patch", "create"]);

/** Argument keys known to carry a single filesystem target. */
const TARGET_KEYS = ["path", "file_path", "filePath", "target", "notebook_path", "notebookPath", "file"];

/** Argument keys known to carry a list of edits, each with its own target. */
const EDIT_LIST_KEYS = ["edits", "files", "changes"];

function block(reason, detail) {
  return { block: true, reason: detail ? `${reason}\n${detail}` : reason };
}

export function resolveWorkspace(env = process.env) {
  const worktree = (env.PAPERCLIP_WORKSPACE_WORKTREE_PATH || "").trim();
  const cwd = (env.PAPERCLIP_WORKSPACE_CWD || "").trim();
  const branch = (env.PAPERCLIP_WORKSPACE_BRANCH || "").trim();
  const strategy = (env.PAPERCLIP_WORKSPACE_STRATEGY || "").trim();
  const root = worktree || cwd;
  return {
    root: root ? path.resolve(root) : null,
    branch: branch || null,
    strategy: strategy || null,
    fromWorktreeVar: Boolean(worktree),
  };
}

/**
 * Containment test performed on the REAL path.
 *
 * A literal string comparison is not enough: `<worktree>/link` may be a symlink
 * whose target is the operator's tree, and a write through it lands outside the
 * worktree while every string comparison insists it is inside. So resolve
 * symlinks on the deepest EXISTING ancestor — the file itself usually does not
 * exist yet on a create — and compare that.
 */
export function isInside(target, root) {
  if (!root || !target) return false;
  const abs = path.resolve(root, target);

  let probe = abs;
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }

  const suffix = path.relative(probe, abs);          // the not-yet-existing tail
  const resolved = suffix ? path.join(realProbe, suffix) : realProbe;
  const rel = path.relative(realRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Extract every filesystem target from a tool call.
 *
 * Returns `null` — distinct from `[]` — when the argument shape is not one this
 * file recognises. `[]` means "recognised, and it genuinely targets nothing";
 * `null` means "not understood". Both are blocked, with different reasons,
 * because collapsing them would let an unrecognised shape pass as harmless.
 */
export function targetsOf(input) {
  if (input === null || typeof input !== "object") return null;

  const out = [];
  let recognised = false;

  for (const key of TARGET_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) { out.push(v.split(":")[0]); recognised = true; }
    else if (key in input) recognised = true;      // present but unusable
  }

  for (const key of EDIT_LIST_KEYS) {
    const list = input[key];
    if (!Array.isArray(list)) continue;
    recognised = true;
    for (const entry of list) {
      if (typeof entry === "string" && entry.trim()) { out.push(entry.split(":")[0]); continue; }
      if (entry && typeof entry === "object") {
        for (const key2 of TARGET_KEYS) {
          const v = entry[key2];
          if (typeof v === "string" && v.trim()) { out.push(v.split(":")[0]); break; }
        }
      }
    }
  }

  return recognised ? out : null;
}

/** Pure decision function, exported so tests exercise it without an OMP runtime. */
export function evaluate(event, env = process.env, cwd = process.cwd()) {
  if (!MUTATING.has(event.toolName)) return null;

  // 1. Missing workspace environment.
  const ws = resolveWorkspace(env);
  if (!ws.root) {
    return block(
      "No PAPERCLIP_WORKSPACE_WORKTREE_PATH or PAPERCLIP_WORKSPACE_CWD in the environment.",
      "Write authority exists only inside an established attempt worktree. This run has none, " +
      "so it has no write authority at all. Block the attempt and name the unblock owner.",
    );
  }
  if (!fs.existsSync(ws.root)) {
    return block(`Declared workspace root ${ws.root} does not exist on disk.`);
  }

  // 2. Primary-tree cwd. If the run is executing in the repository's primary
  //    checkout rather than in a worktree, isolation did not happen — whatever
  //    the environment claims about itself.
  const realCwd = (() => { try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); } })();
  const realRoot = (() => { try { return fs.realpathSync(ws.root); } catch { return path.resolve(ws.root); } })();
  const relCwd = path.relative(realRoot, realCwd);
  if (relCwd.startsWith("..") || path.isAbsolute(relCwd)) {
    return block(
      `Working directory ${realCwd} is outside the assigned worktree ${realRoot}.`,
      "This run is executing in the primary tree or in another repository. Isolation was not " +
      "established; do not write in place.",
    );
  }

  // 3. Branch mismatch — the check the mount layer cannot make. A path can be
  //    inside the right worktree while the worktree sits on the wrong branch,
  //    and the write would then land on the operator's branch.
  if (ws.branch) {
    const dotGit = path.join(realRoot, ".git");
    let actual = null;
    try {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (m) gitDir = path.resolve(realRoot, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const rm = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      actual = rm ? rm[1] : head;
    } catch {
      return block(
        `Cannot read HEAD for the worktree at ${realRoot} to confirm the branch.`,
        `The workspace declares branch "${ws.branch}". An unverifiable branch is a load-bearing ` +
        "unknown, and unknown means blocked.",
      );
    }
    if (actual !== ws.branch) {
      return block(
        `Branch mismatch: the workspace declares "${ws.branch}" but HEAD is "${actual}".`,
        "Writing here would land on a branch this attempt was not granted. Block and report.",
      );
    }
  }

  // 4/5/6. Target shape, targetless mutation, symlink escape.
  const targets = targetsOf(event.input);
  if (targets === null) {
    return block(
      `Mutating tool "${event.toolName}" was called with an argument shape this guard does not recognise.`,
      "The write target could not be identified, so it could not be checked. An unrecognised " +
      "mutating shape is blocked rather than allowed: 'no path found' and 'no path involved' are " +
      "indistinguishable here, and only one of them is safe.",
    );
  }
  if (targets.length === 0) {
    return block(
      `Mutating tool "${event.toolName}" was called with no write target.`,
      "A mutation that names no path cannot be confined to the worktree.",
    );
  }
  for (const target of targets) {
    if (!isInside(target, realRoot)) {
      return block(
        `Write target ${target} resolves outside the attempt worktree ${realRoot}.`,
        "Write authority exists only inside the assigned worktree and branch. If this path is " +
        "reached through a symlink, that is precisely the escape this check exists to stop.",
      );
    }
  }
  return null;
}

export default function hook(pi) {
  pi.on("tool_call", async (event) => evaluate(event) ?? undefined);
}
