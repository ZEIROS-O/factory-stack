#!/usr/bin/env bash
# Launch OMP inside a Bubblewrap sandbox. Set as adapterConfig.command, so the
# Paperclip OMP adapter spawns THIS instead of `omp` and passes its argv through
# untouched (adapter execute.js builds args, then runAdapterExecutionTargetProcess
# spawns `command` with them).
#
# WHAT THIS ACTUALLY GUARANTEES
#   The filesystem is read-only except for a short, explicit writable list. The
#   central property is that the operator's primary X-Bookmarks tree and the
#   repository's SHARED git metadata (objects, refs, packed-refs) are mounted
#   read-only, so an agent inside cannot modify the operator's uncommitted work,
#   cannot commit, and cannot rewrite history — regardless of what it decides to
#   do, what its instructions say, or whether the in-process guard is loaded.
#   Only the worktree assigned to this run, and that worktree's own git metadata
#   directory, are writable.
#
#   Committing is therefore impossible from inside. That is deliberate: the only
#   sanctioned commit path is `factory promote`, which runs outside this sandbox
#   under operator control and commits exactly the reviewed paths.
#
# WHAT THIS DOES NOT GUARANTEE — read before trusting it
#   NETWORK IS NOT ISOLATED. The network namespace is deliberately left shared
#   because OMP needs to reach model providers. Anything reachable from this
#   machine is reachable from inside. Network confinement here is UNPROVEN; the
#   mitigation is credentials, not connectivity — see the strip list below. Do
#   not put production or external-effect credentials in this environment.
#
#   ~/.omp/agent is writable. OMP keeps its model database, config, and caches
#   there and does not run without them. It is shared across runs, so it is
#   residual shared state, not isolation. Named here rather than hidden.
set -euo pipefail

REAL_OMP="${FACTORY_REAL_OMP:-$(command -v omp || echo "$HOME/.bun/bin/omp")}"

# Version/help probes must not be sandboxed: the adapter uses them to decide the
# runtime is installed, before any workspace exists. A sandboxed failure there
# would read as "omp is missing" rather than "the probe was confined".
case "${1:-}" in
  --version|-v|--help|-h) exec "$REAL_OMP" "$@" ;;
esac

if [ ! -x "$REAL_OMP" ]; then
  echo "FATAL: omp not found (looked for '$REAL_OMP')" >&2
  exit 127
fi
command -v bwrap >/dev/null 2>&1 || {
  echo "FATAL: bwrap not installed. The sandbox is the boundary; refusing to run without it." >&2
  exit 127
}

WT="${PAPERCLIP_WORKSPACE_WORKTREE_PATH:-}"
CWD="${PAPERCLIP_WORKSPACE_CWD:-$PWD}"

args=(
  --unshare-pid --unshare-ipc --unshare-uts
  --die-with-parent          # sandbox dies with the adapter; no orphaned agents
  --new-session              # detach from the controlling tty (no TIOCSTI injection)
  --ro-bind / /
  --dev /dev
  --proc /proc
  --tmpfs /tmp               # fresh, private, discarded at exit
)

# ---------------------------------------------------------------- writable set
WT_REAL=""
if [ -n "$WT" ]; then
  [ -d "$WT" ] || { echo "FATAL: PAPERCLIP_WORKSPACE_WORKTREE_PATH=$WT does not exist" >&2; exit 78; }
  WT_REAL="$(readlink -f "$WT")"
  args+=( --bind "$WT_REAL" "$WT_REAL" )

  # A linked worktree's .git is a FILE pointing at <repo>/.git/worktrees/<name>.
  # That per-worktree directory holds this run's HEAD and index and must be
  # writable; the common git dir around it — objects, refs, packed-refs, and the
  # operator's own checkout state — must not be.
  GIT_COMMON="$(git -C "$WT_REAL" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  GIT_OWN="$(git -C "$WT_REAL" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  if [ -n "$GIT_COMMON" ] && [ -d "$GIT_COMMON" ]; then
    # Bind the operator's primary checkout read-only EXPLICITLY. `--ro-bind / /`
    # already covers it, but only incidentally: anything that later makes an
    # ancestor writable (a tmpfs, a broader bind) would silently take the
    # operator's tree with it. State the guarantee where it is meant, so it
    # cannot be lost as a side effect of an unrelated mount.
    REPO_ROOT="$(dirname "$GIT_COMMON")"
    [ -d "$REPO_ROOT" ] && args+=( --ro-bind "$REPO_ROOT" "$REPO_ROOT" )
    args+=( --ro-bind "$GIT_COMMON" "$GIT_COMMON" )
    if [ -n "$GIT_OWN" ] && [ -d "$GIT_OWN" ] && [ "$GIT_OWN" != "$GIT_COMMON" ]; then
      args+=( --bind "$GIT_OWN" "$GIT_OWN" )
    fi
  fi
else
  # FAIL-CLOSED BY OMISSION. No worktree means no writable repository path at
  # all: every repository write fails at the mount layer, before the in-process
  # guard is even consulted. A run with no established worktree has no write
  # authority, which is exactly what the Engineer's authority boundary requires.
  echo "omp-bwrap: no PAPERCLIP_WORKSPACE_WORKTREE_PATH — no writable repository path" >&2
fi

# OMP's own state. Required for it to start at all; see the caveat in the header.
for d in "$HOME/.omp/agent" "$HOME/.omp/logs" "$HOME/.omp/run" "$HOME/.omp/paperclip"; do
  [ -d "$d" ] && args+=( --bind "$d" "$d" )
done
# The adapter's per-agent session directory, wherever it placed it.
if [ -n "${PAPERCLIP_SESSION_DIR:-}" ] && [ -d "${PAPERCLIP_SESSION_DIR}" ]; then
  args+=( --bind "$PAPERCLIP_SESSION_DIR" "$PAPERCLIP_SESSION_DIR" )
fi

# ------------------------------------------------------- credential reduction
# The network is open, so credentials are the real containment boundary. Strip
# every variable granting an EXTERNAL, CONSEQUENTIAL effect — publishing,
# deploying, cloud control planes, source-forge writes, payments, SaaS records.
# Model-provider keys deliberately survive: without them there is no agent.
STRIP_EXACT="GITHUB_TOKEN GH_TOKEN GITHUB_PAT GITLAB_TOKEN NPM_TOKEN SSH_AUTH_SOCK
KUBECONFIG DOCKER_HOST GOOGLE_APPLICATION_CREDENTIALS VERCEL_TOKEN NETLIFY_AUTH_TOKEN"
STRIP_PREFIX="AWS_ AZURE_ GCP_ GCLOUD_ STRIPE_ NOTION_ AIRTABLE_ SLACK_ TWILIO_ SENDGRID_ LINEAR_ JIRA_"

for v in $STRIP_EXACT; do args+=( --unsetenv "$v" ); done
while IFS='=' read -r name _; do
  for p in $STRIP_PREFIX; do
    case "$name" in "$p"*) args+=( --unsetenv "$name" ); break ;; esac
  done
done < <(env)

args+=( --setenv FACTORY_SANDBOX 1 )
if [ -n "$WT_REAL" ]; then args+=( --chdir "$WT_REAL" ); else args+=( --chdir "$CWD" ); fi

exec bwrap "${args[@]}" -- "$REAL_OMP" "$@"
