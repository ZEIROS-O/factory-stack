#!/usr/bin/env bash
# Compile src/ into three project-specific AGENTS.md files.
#
#   delivered AGENTS.md = shared factory doctrine + role section
#
# The Paperclip adapter owns the platform contract. Copying it here duplicates
# and can contradict the adapter's current contract. The factory doctrine is
# still compiled into each output so no secondary project file must be loaded.
#
# This compiler NEVER publishes. Live publication is a declarative factory
# reconciliation action with exact readback and an immutable receipt.
set -euo pipefail

# `>/dev/null` because a set CDPATH makes `cd` echo the target and corrupt $D.
D="$(cd "$(dirname "$0")" > /dev/null && pwd)"
S="$D/src"
O="$D/out"
M="$D/manifest.sha256"
mode="${1:---write}"
case "$mode" in --write|--check) ;; *) echo "usage: $0 [--write|--check]" >&2; exit 2 ;; esac

roles=(hermes engineer reviewer)

verify_bundle() {
  local role="$1" out="$2"

  # The platform contract is injected by Paperclip and must not be copied here.
  if grep -q '^You are an agent at Paperclip company\.$' "$out"; then
    echo "FATAL: $role duplicates the adapter-owned Paperclip contract" >&2
    exit 1
  fi

  # No file may depend on a secondary instruction file being loaded.
  if grep -q 'DOCTRINE\.md' "$out"; then
    echo "FATAL: $role references an external instruction file" >&2
    exit 1
  fi

}

if [[ "$mode" == "--check" ]]; then
  [[ -d "$O" && -f "$M" ]] || { echo "instruction outputs or manifest are missing; run compile.sh --write" >&2; exit 1; }
  for role in "${roles[@]}"; do
    out="$O/AGENTS.$role.md"
    [[ -f "$out" ]] || { echo "instruction output missing: $out" >&2; exit 1; }
    if ! cmp -s <(cat "$S/_doctrine.md" "$S/_role_$role.md") "$out"; then
      echo "instruction bundle drift: out/AGENTS.$role.md is out of date" >&2
      exit 1
    fi
    verify_bundle "$role" "$out"
  done
  if ! cmp -s <(
    for role in "${roles[@]}"; do
      sha256sum "$O/AGENTS.$role.md" | sed "s#  $O/#  out/#"
    done
  ) "$M"; then
    echo "instruction manifest mismatch" >&2
    exit 1
  fi
  echo "instructions: generated bundles and manifest match"
  exit 0
fi

mkdir -p "$O"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
for role in "${roles[@]}"; do
  out="$tmp/AGENTS.$role.md"
  cat "$S/_doctrine.md" "$S/_role_$role.md" > "$out"
  verify_bundle "$role" "$out"
done
for role in "${roles[@]}"; do
  install -m 0644 "$tmp/AGENTS.$role.md" "$O/AGENTS.$role.md"
done
for role in "${roles[@]}"; do
  sha256sum "$O/AGENTS.$role.md" | sed "s#  $O/#  out/#"
done > "$tmp/manifest.sha256"
install -m 0644 "$tmp/manifest.sha256" "$M"
echo "instructions: wrote ${#roles[@]} deterministic bundles and manifest"
