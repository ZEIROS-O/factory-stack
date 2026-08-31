#!/usr/bin/env bash
# Compile src/ into three SELF-CONTAINED AGENTS.md files and push them.
#
#   delivered AGENTS.md = platform contract (verbatim) + shared doctrine + role section
#
# There is deliberately no runtime dependency on any secondary instruction file.
# Silent non-delivery of a second file is unacceptable, so the doctrine is
# duplicated into all three outputs at build time instead of referenced.
#
# GOTCHA: `paperclipai agent update --payload-json '{"instructionsBundle":...}'`
# returns 200 and silently does nothing. `instructions-file:put` is the only
# write path that actually persists. Do not "simplify" this back.
set -euo pipefail

# `>/dev/null` because a set CDPATH makes `cd` echo the target and corrupt $D.
D="$(cd "$(dirname "$0")" > /dev/null && pwd)"
S="$D/src"
O="$D/out"
PC="$D/../node_modules/.bin/paperclipai"
mkdir -p "$O"

# Agent ids are resolved by name at run time rather than hardcoded, so this
# survives a rebuilt instance.
COMPANY="${PAPERCLIP_COMPANY_ID:-$("$PC" company list --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].id')}"
AGENTS_JSON="$("$PC" agent list --company-id "$COMPANY" --json)"

agent_id() {
  node -pe '
    const list = JSON.parse(process.env.AGENTS_JSON);
    const arr = Array.isArray(list) ? list : (list.agents || []);
    const hit = arr.find(a => a.name === process.argv[1]);
    if (!hit) { console.error(`no agent named ${process.argv[1]}`); process.exit(1); }
    hit.id
  ' "$1"
}
export AGENTS_JSON

declare -A NAMES=(
  [hermes]="Hermes Generalist"
  [engineer]="OMP Engineer"
  [reviewer]="OMP Reviewer"
)

contract_bytes="$(wc -c < "$S/_platform_contract.md")"

for role in hermes engineer reviewer; do
  out="$O/AGENTS.$role.md"
  cat "$S/_platform_contract.md" "$S/_doctrine.md" "$S/_role_$role.md" > "$out"

  # The platform contract must survive byte-for-byte as the file's prefix.
  if ! head -c "$contract_bytes" "$out" | cmp -s - "$S/_platform_contract.md"; then
    echo "FATAL: $role platform contract is not verbatim" >&2
    exit 1
  fi

  # No file may depend on a secondary instruction file being loaded.
  if grep -q 'DOCTRINE\.md' "$out"; then
    echo "FATAL: $role references an external instruction file" >&2
    exit 1
  fi

  id="$(agent_id "${NAMES[$role]}")"
  "$PC" agent instructions-file:put "$id" \
    --path AGENTS.md --content-file "$out" --json > /dev/null

  echo "$role: $(wc -c < "$out") bytes -> ${NAMES[$role]}"
done
