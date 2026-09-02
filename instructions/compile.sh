#!/usr/bin/env bash
# Compile src/ into the role bundles declared by bundles.json.
#
#   delivered AGENTS.<role>.md = ordered concatenation of the declared fragments
#
# bundles.json is the single machine-owned source of composition: roles (in
# key order), fragment membership and order, and the maxBytes caps that keep
# the resident prompt small. Nothing about composition is hardcoded here.
#
# The Paperclip adapter owns the platform contract. Copying it here duplicates
# and can contradict the adapter's current contract. The core is compiled
# into each output so no secondary project file must be loaded at runtime.
#
# This compiler NEVER publishes. Live publication is a declarative factory
# reconciliation action with exact readback and an immutable receipt.
set -euo pipefail

# `>/dev/null` because a set CDPATH makes `cd` echo the target and corrupt $D.
D="$(cd "$(dirname "$0")" > /dev/null && pwd)"
S="$D/src"
O="$D/out"
B="$D/bundles.json"
M="$D/manifest.sha256"
mode="${1:---write}"
case "$mode" in --write|--check) ;; *) echo "usage: $0 [--write|--check]" >&2; exit 2 ;; esac

# node -e for JSON parsing: node is a hard dependency of this repo; jq is not.
[[ -f "$B" ]] || { echo "FATAL: missing bundles.json" >&2; exit 1; }
mapfile -t roles < <(node -e '
  const fs = require("fs");
  const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!b || b.version !== 1 || !b.bundles || typeof b.bundles !== "object"
      || !b.maxBytes || typeof b.maxBytes !== "object") process.exit(1);
  process.stdout.write(Object.keys(b.bundles).join("\n") + "\n");
' "$B") || true
[[ "${#roles[@]}" -gt 0 ]] || { echo "FATAL: bundles.json declares no roles" >&2; exit 1; }

# One declared fragment list per role, as newline-separated names.
fragments_of() {
  node -e '
    const fs = require("fs");
    const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(b.bundles[process.argv[2]].join("\n") + "\n");
  ' "$B" "$1"
}

# A maxBytes value by key (role name or fragment filename); empty if unset.
cap_of() {
  node -e '
    const fs = require("fs");
    const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = b.maxBytes[process.argv[2]];
    if (v !== undefined) process.stdout.write(String(v));
  ' "$B" "$1"
}

size_ok() { # size_ok <key> <file> — enforce a maxBytes cap, report actual.
  local key="$1" file="$2" actual cap
  cap="$(cap_of "$key")"
  [[ -n "$cap" ]] || return 0
  actual="$(wc -c < "$file")"
  if (( actual > cap )); then
    echo "FATAL: $key is $actual bytes, over the $cap cap ($file)" >&2
    exit 1
  fi
}

check_no_duplicate_headings() { # one `## ` section per name in a compiled bundle.
  local dups
  dups="$(grep '^## ' "$1" | sort | uniq -d || true)"
  if [[ -n "$dups" ]]; then
    echo "FATAL: $2 has duplicate '## ' headings:" >&2
    echo "$dups" >&2
    exit 1
  fi
}

forbidden_patterns() { # per-role leak guards, one regex per line.
  case "$1" in
    hermes)
      # Engineer receipt frames must never reach the intake role.
      echo 'EXECUTION_RECEIPT_CLAIMS'
      # OMP goal-loop material is Engineer-only.
      echo 'goal\.complete'
      # The intake role has no delegation surface; delegation text leaks scope.
      echo 'subagent'
      # `task` tool usage is Engineer-only.
      echo '\btask\b'
      # Personal memory and personal projects must not enter a worker prompt.
      echo 'SOUL\.md'
      echo '~/\.claude'
      echo '\bLou\b'
      echo '\bZEIROS\b'
      ;;
    engineer)
      # The Engineer receives no intake history; Hermes-named material leaks it.
      echo 'Hermes'
      echo 'intake'
      # Draft authorship belongs upstream; the Engineer only receives envelopes.
      echo 'EngineerHandoffDraft'
      # Personal memory and personal projects must not enter a worker prompt.
      echo 'SOUL\.md'
      echo '~/\.claude'
      echo '\bLou\b'
      echo '\bZEIROS\b'
      ;;
    reviewer)
      # The Reviewer has no delegation surface and must not be told to try.
      echo 'subagent'
      echo 'delegate'
      # The Reviewer audits receipt claims; it never emits frames.
      echo 'EXECUTION_RECEIPT_CLAIMS_V1---'
      # OMP goal-loop material is Engineer-only.
      echo 'goal\.complete'
      # The Reviewer assesses; prescribing fixes is a role violation.
      echo 'repair'
      ;;
    *)
      echo "FATAL: no forbidden-pattern set for role '$1'" >&2
      exit 1
      ;;
  esac
}

verify_bundle() {
  local role="$1" out="$2" re

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

  # Role-scoped content must not leak into another role's bundle.
  while IFS= read -r re; do
    [[ -n "$re" ]] || continue
    if grep -qiE "$re" "$out"; then
      echo "FATAL: $role bundle matches forbidden pattern '$re'" >&2
      exit 1
    fi
  done < <(forbidden_patterns "$role")

  # A duplicated `## ` section makes the compiled bundle ambiguous.
  check_no_duplicate_headings "$out" "$role"
}

compose() { # compose <role> <dest> — exact ordered concatenation of fragments.
  local role="$1" dest="$2" frag file
  : > "$dest"
  while IFS= read -r frag; do
    [[ -n "$frag" ]] || continue
    if [[ "$frag" == */* || "$frag" == *..* ]]; then
      echo "FATAL: $role declares unsafe fragment path '$frag'" >&2
      exit 1
    fi
    file="$S/$frag"
    [[ -f "$file" ]] || { echo "FATAL: $role declares missing fragment '$frag'" >&2; exit 1; }
    cat "$file" >> "$dest"
  done < <(fragments_of "$role")
  size_ok "$role" "$dest"
}

# Orphan detection: every src/*.md must be part of at least one bundle.
mapfile -t declared_frags < <(node -e '
  const fs = require("fs");
  const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write([...new Set(Object.values(b.bundles).flat())].join("\n") + "\n");
' "$B") || true
shopt -s nullglob
for f in "$S"/*.md; do
  base="$(basename "$f")"
  if ! printf '%s\n' "${declared_frags[@]}" | grep -qx -- "$base"; then
    echo "FATAL: src/$base is not referenced by any bundle in bundles.json" >&2
    exit 1
  fi
  # Per-fragment caps (e.g. _core.md) apply wherever maxBytes names a fragment.
  size_ok "$base" "$f"
done
shopt -u nullglob

if [[ "$mode" == "--check" ]]; then
  [[ -d "$O" && -f "$M" ]] || { echo "instruction outputs or manifest are missing; run compile.sh --write" >&2; exit 1; }
  tmp="$(mktemp -d)"
  trap 'rm -rf -- "$tmp"' EXIT
  for role in "${roles[@]}"; do
    out="$O/AGENTS.$role.md"
    [[ -f "$out" ]] || { echo "instruction output missing: $out" >&2; exit 1; }
    # Mode is ADVISORY here, never fatal. `--write` installs 0444 so a stray
    # hand-edit in a working tree hits a read-only file, but Git records only
    # the executable bit: every clone and every checkout materializes these as
    # 0644, so a fresh tree would fail a mode gate it cannot possibly satisfy.
    # The real hand-edit defence is the byte comparison below — an edit changes
    # the bytes and fails the drift check regardless of mode.
    if [[ "$(stat -c '%a' "$out")" != "444" ]]; then
      echo "note: $out is mode $(stat -c '%a' "$out"), not 0444 (expected after a checkout); run compile.sh --write to restore" >&2
    fi
    compose "$role" "$tmp/AGENTS.$role.md"
    if ! cmp -s "$tmp/AGENTS.$role.md" "$out"; then
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
  compose "$role" "$tmp/AGENTS.$role.md"
  verify_bundle "$role" "$tmp/AGENTS.$role.md"
done
for role in "${roles[@]}"; do
  # rm first: the destination is 0444 from a previous run and cannot be opened
  # for write; install replaces it atomically.
  rm -f "$O/AGENTS.$role.md"
  install -m 0444 "$tmp/AGENTS.$role.md" "$O/AGENTS.$role.md"
done
for role in "${roles[@]}"; do
  sha256sum "$O/AGENTS.$role.md" | sed "s#  $O/#  out/#"
done > "$tmp/manifest.sha256"
install -m 0644 "$tmp/manifest.sha256" "$M"
for role in "${roles[@]}"; do
  cap="$(cap_of "$role")"
  echo "instructions: AGENTS.$role.md is $(wc -c < "$O/AGENTS.$role.md") bytes (cap ${cap:-unset})"
done
echo "instructions: wrote ${#roles[@]} deterministic bundles and manifest"
