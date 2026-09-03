#!/usr/bin/env bash
# The SECOND sandbox: a read-only verifier that executes one declared acceptance
# command and reports its exit code. Invoked by the paperclip_review tool, never
# by an agent directly.
#
#   ops/omp-verify-bwrap.sh --worktree <abs path> [--cwd <rel>] -- argv...
#
# WHY THIS IS A SEPARATE SANDBOX FROM ops/omp-bwrap.sh
#   The Engineer's sandbox has a writable worktree, model-provider credentials,
#   and an open network, because an agent that cannot write or reach a model is
#   not an agent. None of that is true here. The command that DECIDES the verdict
#   must not be able to change the thing it is judging, and must not be able to
#   carry anything out. So this sandbox is strictly stronger on every axis:
#
#     read-only        EVERYTHING is read-only, the worktree included. The
#                      Engineer's sandbox makes the assigned worktree writable;
#                      this one does not. An acceptance command that mutates the
#                      tree to make itself pass fails at the mount layer.
#     no network       --unshare-all includes --unshare-net. Every acceptance
#                      command in the objective envelope is hermetic (ZEI-1:
#                      python3 -m pytest), and the envelope declares network
#                      "provider_only" with no external effects. A verifier needs
#                      no provider, so it gets no network at all. Unlike the
#                      Engineer sandbox — where network isolation is explicitly
#                      UNPROVEN because the namespace is deliberately shared —
#                      isolation here is real and is proven by test.
#     no credentials   --clearenv, then a minimal allowlist is set back. Not a
#                      strip list: a strip list fails open on the variable nobody
#                      thought of. There is nothing to exfiltrate and, with no
#                      network, nowhere to send it.
#
#   HOME KEEPS ITS REAL VALUE, DELIBERATELY. An earlier revision pointed it at
#   the private tmpfs, which read as safer and was not: `--ro-bind / /` already
#   mounts the operator's home read-only, so redirecting HOME granted no
#   additional protection against writes — it only broke path resolution that
#   depends on it. Python's user site-packages is derived from HOME, and on this
#   machine pytest lives in ~/.local/lib/python3.10/site-packages, so every one
#   of ZEI-1's six `python3 -m pytest` acceptance commands failed with "No module
#   named pytest" — six false BLOCKED verdicts from a sandbox that looked
#   stricter. A tmpfs over ~/.cache gives cache writes somewhere to land.
#
# WHAT THIS DOES NOT GUARANTEE
#   The command still executes arbitrary code with this user's CPU. Containment
#   here is about EFFECTS — no writes, no network, no credentials — not about
#   preventing computation. A command can still burn wall clock; the caller
#   imposes the timeout, not this script.
#
#   THE WHOLE FILESYSTEM IS READABLE. `--ro-bind / /` is inherited from the
#   Engineer sandbox for the same reason: an unknown command needs its
#   interpreter, libraries and certificates, and enumerating those is a losing
#   game. So an acceptance command CAN read the operator's files and could copy
#   what it reads into its own stdout, which this system captures and hashes.
#   The mitigation is upstream, not here: acceptance commands are argv arrays
#   inside the hash-bound objective envelope, so changing one changes the
#   envelope hash and invalidates the review. Stated rather than left implicit.
#
#   Because the worktree is read-only, tools that expect a writable rootdir
#   degrade rather than fail: pytest warns that it cannot create .pytest_cache
#   and continues, and PYTHONDONTWRITEBYTECODE stops __pycache__ attempts. That
#   degradation is deliberate and must never be "fixed" by making the tree
#   writable.
set -euo pipefail

WT=""; REL="."
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT="${2:-}"; shift 2 ;;
    --cwd)      REL="${2:-.}"; shift 2 ;;
    --)         shift; break ;;
    *) echo "verify: unexpected argument $1" >&2; exit 64 ;;
  esac
done

[ -n "$WT" ] || { echo "verify: --worktree is required" >&2; exit 64; }
[ $# -gt 0 ] || { echo "verify: no command given after --" >&2; exit 64; }
[ -d "$WT" ] || { echo "verify: worktree $WT does not exist" >&2; exit 78; }
command -v bwrap >/dev/null 2>&1 || {
  echo "verify: bwrap not installed. The sandbox is the boundary; refusing to run without it." >&2
  exit 127
}

WT_REAL="$(readlink -f "$WT")"

# Captured BEFORE --clearenv and handed back explicitly. See the HOME note above:
# resolution depends on it, and the read-only root already denies writes to it.
REAL_HOME="${HOME:-/home/$(id -un)}"

# THE INTERPRETER MUST BE THE ONE THE WORK WAS DONE WITH.
#
# The sandbox sets a fixed minimal PATH, which is right for isolation and wrong
# for judgement: on a machine whose toolchain is version-managed, `node`
# resolves to the distro build. Here that is /usr/bin/node v12.22.9, which
# rejects `--test` outright — a flag the Engineer's own v22 accepted with exit
# 0. Every Node-based acceptance criterion therefore failed inside the verifier
# for a reason that had nothing to do with the change under review.
#
# A verifier that runs the acceptance command under a different interpreter is
# not checking the claim; it is checking a different claim. So the directory of
# the caller's resolved interpreter is PREPENDED to the sandbox PATH — one
# directory, captured before --clearenv, and only when it really holds an
# executable of that name.
#
# This widens no boundary that matters. The root is already --ro-bind / /, so
# the binary was readable either way; what changes is only which of two
# readable binaries gets run. Writes, network and credentials are unaffected.
VERIFY_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for interp in node python3 python ruby; do
  resolved="$(command -v "$interp" 2>/dev/null || true)"
  [ -n "$resolved" ] || continue
  dir="$(dirname -- "$(readlink -f "$resolved")")"
  case ":$VERIFY_PATH:" in
    *":$dir:"*) ;;
    *) VERIFY_PATH="$dir:$VERIFY_PATH" ;;
  esac
done

# CONFINE THE cwd. `cwd` comes from the objective envelope, which is hash-bound,
# but a relative path is still resolved here and must not be able to walk out of
# the worktree — including through a symlink planted inside it.
RUN_DIR="$(readlink -f "$WT_REAL/$REL" 2>/dev/null || true)"
[ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] || { echo "verify: cwd '$REL' does not resolve inside the worktree" >&2; exit 78; }
case "$RUN_DIR" in
  "$WT_REAL"|"$WT_REAL"/*) ;;
  *) echo "verify: cwd '$REL' resolves to $RUN_DIR, outside worktree $WT_REAL" >&2; exit 78 ;;
esac

# MOUNT ORDER IS LOAD-BEARING. bwrap applies these in sequence, so the worktree
# bind must come AFTER `--tmpfs /tmp`: a worktree living under /tmp (every test
# fixture, and any operator who parks one there) is otherwise masked by the
# tmpfs and the run dies with "Can't chdir". Do not reorder for tidiness.
exec bwrap \
  --unshare-all \
  --die-with-parent \
  --new-session \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --tmpfs "$REAL_HOME/.cache" \
  --ro-bind "$WT_REAL" "$WT_REAL" \
  --clearenv \
  --setenv PATH "$VERIFY_PATH" \
  --setenv HOME "$REAL_HOME" \
  --setenv TMPDIR /tmp \
  --setenv LANG "${LANG:-C.UTF-8}" \
  --setenv LC_ALL "${LC_ALL:-C.UTF-8}" \
  --setenv PYTHONDONTWRITEBYTECODE 1 \
  --setenv FACTORY_VERIFIER 1 \
  --chdir "$RUN_DIR" \
  -- "$@"
