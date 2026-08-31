#!/usr/bin/env bash
# Sync the superpowers skill pack from the Claude plugin cache into ~/.hermes/skills.
#
# WHY THIS EXISTS
#   OMP discovers superpowers live via its `claude-plugins` provider, so it is
#   always current and needs nothing. Hermes reads its own ~/.hermes/skills
#   directory, so it holds COPIES that silently rot. On 2026-08-31 Hermes was
#   missing 4 of the 14 skills outright, and the other 10 were a month stale and
#   contained only SKILL.md — none of the 37 companion files (scripts, reference
#   docs) that the SKILL.md bodies actually link to.
#
# NOTE: the plugin path is version-pinned. When superpowers updates, the version
# directory changes and this script must be repointed. It fails loudly rather
# than silently syncing nothing.
#
# Hermes caches the loaded skill set in ~/.hermes/.skills_prompt_snapshot.json at
# startup. After running this, RESTART THE HERMES GATEWAY or the new skills stay
# invisible to it.
set -euo pipefail

PLUGIN_ROOT="$HOME/.claude/plugins/cache/claude-plugins-official/superpowers"
HERMES_SKILLS="$HOME/.hermes/skills"

# Resolve the newest version directory rather than hardcoding one.
VERSION="$(ls -1 "$PLUGIN_ROOT" 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$VERSION" ]; then
  echo "FATAL: no superpowers version found under $PLUGIN_ROOT" >&2
  exit 1
fi
SRC="$PLUGIN_ROOT/$VERSION/skills"
if [ ! -d "$SRC" ]; then
  echo "FATAL: $SRC is not a directory (plugin layout changed?)" >&2
  exit 1
fi

echo "source: superpowers $VERSION"
mkdir -p "$HERMES_SKILLS"
stamp="$(date +%Y%m%d_%H%M%S)"
tar czf "$HOME/.hermes/skills-backup-$stamp.tar.gz" -C "$HOME/.hermes" skills
echo "backup: ~/.hermes/skills-backup-$stamp.tar.gz"

synced=0
for path in "$SRC"/*/; do
  skill="$(basename "$path")"
  rm -rf "${HERMES_SKILLS:?}/$skill"
  cp -r "$path" "$HERMES_SKILLS/$skill"
  synced=$((synced + 1))
done

# Verify byte-identical, or the sync is not trustworthy.
drift=0
for path in "$SRC"/*/; do
  skill="$(basename "$path")"
  diff -rq "$path" "$HERMES_SKILLS/$skill" > /dev/null || { echo "DRIFT: $skill" >&2; drift=$((drift + 1)); }
done

echo "synced $synced skills, $drift drifted"
[ "$drift" -eq 0 ] || exit 1
echo
echo "Skills on disk are current. Hermes will NOT see them until the gateway restarts:"
echo "  hermes gateway restart      # check for active sessions/cron first"
