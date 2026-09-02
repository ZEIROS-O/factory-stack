#!/usr/bin/env bash
# Launch Hermes inside a Bubblewrap sandbox, pinned to the Paperclip-only
# Hermes profile. Set as adapterConfig.hermesCommand, so the Hermes adapter
# spawns THIS instead of `hermes` and passes its argv through untouched
# (adapter execute.js builds args, then runChildProcess spawns the command
# with them). Forwards every argument ("$@") unchanged and execs the real
# hermes binary.
#
# WHAT THIS ACTUALLY GUARANTEES
#   The Paperclip Hermes Generalist has NO repository write authority: the
#   assigned workspace is mounted READ-ONLY, so whatever Hermes decides to
#   do, it cannot edit any working tree. Its entire effect on the world is
#   text, Paperclip API calls, and its own profile state.
#
#   Profile selection is deterministic: HERMES_HOME is pinned here — before
#   argv is even considered — to ~/.hermes/profiles/paperclip-hermes, so the
#   operator's personal Hermes home is never the runtime home, whatever flag
#   order or ambient config would otherwise select.
#
#   The operator's personal Hermes state at ~/.hermes is MASKED, not merely
#   unused: config.yaml, SOUL.md, memories/, sessions/, .env, and auth.json
#   each get an empty file or tmpfs bound over them, so no mis-resolution can
#   read the operator's personality, memory, credentials, or history.
#   ~/.hermes itself stays traversable because Hermes resolves the profiles
#   ROOT from the default home (~/.hermes/profiles); the personal siblings
#   are masked individually, never the parent wholesale.
#
# WHAT THIS DOES NOT GUARANTEE — read before trusting it
#   NETWORK IS NOT ISOLATED. Hermes needs model providers and research, so
#   the network namespace is shared, as in ops/omp-bwrap.sh. Confinement is
#   credentials, not connectivity — see the strip list below. Model-provider
#   credentials deliberately survive; the PERSONAL hermes auth.json does not,
#   so the profile must hold its own provider credentials (or inherit them
#   from the environment).
#
#   The whole filesystem stays readable via --ro-bind / / (interpreters,
#   models registries, CA bundles). Personal state NOT in the mask list below
#   — e.g. ~/.hermes/shared/nous_auth.json, which all profiles under the
#   same root share for provider auth — remains readable. Named, not hidden.
#
# EXIT CODES (fail closed, each distinct)
#   127  bwrap not installed — the sandbox is the boundary; refuse without it
#   126  the real hermes binary is missing or not executable
#    65  invalid profile name (grammar or traversal shaped)
#    78  the profile directory does not exist — run `factory materialize --apply`
#    66  a supplied workspace path is not an existing directory
#    73  the mask file cannot be created; refusing to run unmasked
set -euo pipefail

REAL_HERMES="${FACTORY_REAL_HERMES:-$(command -v hermes || echo "$HOME/.local/bin/hermes")}"

# Version/help probes must not be sandboxed: the adapter uses them to decide
# the runtime is installed, before any workspace exists. A sandboxed failure
# there reads as "hermes is missing" rather than "the probe was confined".
case "${1:-}" in
  --version|-v|--help|-h) exec "$REAL_HERMES" "$@" ;;
esac

if [ ! -x "$REAL_HERMES" ]; then
  echo "FATAL: hermes not found (looked for '$REAL_HERMES')" >&2
  exit 126
fi
command -v bwrap >/dev/null 2>&1 || {
  echo "FATAL: bwrap not installed. The sandbox is the boundary; refusing to run without it." >&2
  exit 127
}

# The default Hermes root. FACTORY_HERMES_ROOT exists so tests can redirect
# the profiles root exactly like lib/materialize.js does; unset, this is the
# operator's real ~/.hermes, whose profiles/ Hermes resolves from.
HERMES_ROOT="${FACTORY_HERMES_ROOT:-$HOME/.hermes}"

# The Paperclip Hermes profile. Hermes profile names use their own grammar —
# ^[a-z0-9][a-z0-9_-]{0,63}$ (dots are NOT valid, unlike OMP) — read from the
# launcher (hermes_cli/gateway.py profile detection). FACTORY_HERMES_PROFILE
# exists so tests and future roles can redirect it; the factory default is
# the one profile lib/materialize.js materializes.
PROFILE="${FACTORY_HERMES_PROFILE:-paperclip-hermes}"
case "$PROFILE" in
  *..*) echo "FATAL: invalid Hermes profile name '$PROFILE'" >&2; exit 65 ;;
esac
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || {
  echo "FATAL: invalid Hermes profile name '$PROFILE'" >&2; exit 65; }
PROFILE_DIR="$HERMES_ROOT/profiles/$PROFILE"
[ -d "$PROFILE_DIR" ] || {
  echo "FATAL: Hermes profile $PROFILE_DIR does not exist." >&2
  echo "       Run 'factory materialize --apply' to create it." >&2
  exit 78; }

# ------------------------------------------------------------------ workspace
# The assigned workspace is READ-ONLY: Hermes investigates, it does not edit.
# Only an env-supplied path is treated as the workspace — the adapter runs
# the wrapper with its configured cwd, which is Paperclip-owned scratch and
# must stay writable below. A workspace that is not an existing directory is
# a configuration error, not a sandbox tuning problem.
WS="${PAPERCLIP_WORKSPACE_WORKTREE_PATH:-${PAPERCLIP_WORKSPACE_CWD:-}}"
WS_REAL=""
if [ -n "$WS" ]; then
  [ -d "$WS" ] || { echo "FATAL: workspace $WS is not an existing directory" >&2; exit 66; }
  WS_REAL="$(readlink -f "$WS")"
fi

# The wrapper's own cwd: writable when Paperclip owns it (the adapter's
# configured workdir under ~/.paperclip — Hermes scratch space), read-only
# otherwise (a repository path must never be writable to Hermes).
CWD_REAL="$(readlink -f "$PWD")"
case "$CWD_REAL" in
  "$HOME"/.paperclip/*) CWD_WRITABLE=1 ;;
  *) CWD_WRITABLE="" ;;
esac

# The shared empty file bound over masked personal files. Verified against
# bwrap 0.6.1: --ro-bind /dev/null over a regular-file target fails (EACCES
# on open), so the source must be a real empty file.
EMPTY_MASK="$HOME/.cache/factory/empty-mask"
mkdir -p "$(dirname "$EMPTY_MASK")" 2>/dev/null || true
[ -f "$EMPTY_MASK" ] || : > "$EMPTY_MASK" 2>/dev/null || {
  echo "FATAL: cannot create mask file $EMPTY_MASK; refusing to run unmasked" >&2
  exit 73; }

args=(
  --unshare-pid --unshare-ipc --unshare-uts
  --die-with-parent          # sandbox dies with the adapter; no orphaned agents
  --new-session              # detach from the controlling tty (no TIOCSTI injection)
  --ro-bind / /
  --dev /dev
  --proc /proc
  --tmpfs /tmp               # writable temp, private, discarded at exit
)

# -------------------------------------------------------------- writable set
# The profile IS the runtime home: config, SOUL.md, sessions, caches, and
# state.db all live inside it, so it is bound writable.
args+=( --bind "$PROFILE_DIR" "$PROFILE_DIR" )
# Paperclip-owned scratch cwd (see above). Writable only under ~/.paperclip.
if [ -n "$CWD_WRITABLE" ] && [ "$CWD_REAL" != "$PROFILE_DIR" ]; then
  args+=( --bind "$CWD_REAL" "$CWD_REAL" )
fi
# A per-run session directory, if the harness provides one (symmetric with
# ops/omp-bwrap.sh; the Hermes adapter does not set it today).
if [ -n "${PAPERCLIP_SESSION_DIR:-}" ] && [ -d "${PAPERCLIP_SESSION_DIR}" ]; then
  args+=( --bind "${PAPERCLIP_SESSION_DIR}" "${PAPERCLIP_SESSION_DIR}" )
fi

# The assigned workspace, READ-ONLY. Never --bind: Hermes must not be able to
# write it, whatever its instructions or tool choices say.
if [ -n "$WS_REAL" ]; then
  args+=( --ro-bind "$WS_REAL" "$WS_REAL" )
fi

# ------------------------------------------------- personal Hermes state mask
# The operator's personal ~/.hermes content, masked individually so that
# ~/.hermes itself — and the profiles/ root Hermes resolves from it — stays
# traversable. Files get the empty mask over them; directories get a tmpfs
# (empty, and inert: with HERMES_HOME pinned to the profile, none of these
# paths is ever resolved at runtime — this is the backstop that holds even
# if pinning drifts).
for f in config.yaml SOUL.md .env auth.json; do
  [ -e "$HOME/.hermes/$f" ] && args+=( --ro-bind "$EMPTY_MASK" "$HOME/.hermes/$f" )
done
for d in memories cron sessions; do
  [ -d "$HOME/.hermes/$d" ] && args+=( --tmpfs "$HOME/.hermes/$d" )
done

# ------------------------------------------------------- credential reduction
# The network is open, so credentials are the real containment boundary. Strip
# every variable granting an EXTERNAL, CONSEQUENTIAL effect — publishing,
# deploying, cloud control planes, source-forge writes, payments, SaaS
# records. Model-provider keys deliberately survive: without them there is no
# agent. Kept byte-identical to ops/omp-bwrap.sh; the two scripts must not
# diverge silently — test/unit/sandbox-masking.test.js asserts list parity.
STRIP_EXACT="GITHUB_TOKEN GH_TOKEN GITHUB_PAT GITLAB_TOKEN NPM_TOKEN SSH_AUTH_SOCK
KUBECONFIG DOCKER_HOST GOOGLE_APPLICATION_CREDENTIALS VERCEL_TOKEN NETLIFY_AUTH_TOKEN"
STRIP_PREFIX="AWS_ AZURE_ GCP_ GCLOUD_ STRIPE_ NOTION_ AIRTABLE_ SLACK_ TWILIO_ SENDGRID_ LINEAR_ JIRA_"

for v in $STRIP_EXACT; do args+=( --unsetenv "$v" ); done
while IFS='=' read -r name _; do
  for p in $STRIP_PREFIX; do
    case "$name" in "$p"*) args+=( --unsetenv "$name" ); break ;; esac
  done
done < <(env)

# Markers, and the deterministic profile pin. HERMES_HOME is set HERE, before
# argv is considered, so no flag order or ambient config can select the
# operator's personal home.
args+=( --setenv FACTORY_SANDBOX 1 )
args+=( --setenv FACTORY_HERMES_SANDBOX 1 )
args+=( --setenv HERMES_HOME "$PROFILE_DIR" )

if [ -n "$WS_REAL" ]; then args+=( --chdir "$WS_REAL" ); else args+=( --chdir "$CWD_REAL" ); fi

exec bwrap "${args[@]}" -- "$REAL_HERMES" "$@"
