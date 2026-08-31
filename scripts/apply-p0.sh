#!/usr/bin/env bash
# P0 — restore execution to the OMP agents and bind the mechanical boundary.
#
# Idempotent. Resolves ids by name so it survives a rebuilt instance. Verifies by
# reading back: a PATCH that returns 200 and does nothing is a known Paperclip
# failure mode (see README gotchas), so nothing here trusts a status code.
#
# WHAT IT CHANGES AND WHY
#   approvalMode  write -> yolo    Headless runs have no UI to approve. `write` did
#                                  not make exec reviewable, it made it impossible:
#                                  ZEI-1 spent $5.57 over six runs with zero writes.
#   configFiles   -> engineer.policy.yml
#                                  The boundary that replaces the approval prompt.
#                                  Strict overlay: missing file = hard startup error.
#   hooks         -> worktree-guard.js
#                                  Path confinement for write/edit, which bash
#                                  patterns cannot express.
#   skills        UNCHANGED        An earlier draft of this script cut 12 -> 3 to
#                                  shrink the standing prompt. That was based on a
#                                  wrong inference and is reverted.
#
# WHY SKILLS ARE LEFT ALONE (measured, not assumed)
#   OMP already does progressive disclosure. Its runtime docs: skills are exposed as
#   "lightweight metadata in the system prompt (name + description)" with "on-demand
#   content via the `read` tool against `skill://...`". Measured across the Engineer's
#   12 skills: ~1,998 bytes of name+description, ~500 tokens total, and not one
#   carries `alwaysApply: true`. Bodies never enter the prompt unless the model asks.
#   Trimming to 3 would have saved ~375 tokens (~1% of the standing prompt) at the
#   cost of the orchestration lane. Do not re-introduce that trim.
#
#   The 39,415-token standing prompt is therefore NOT skills. Remaining candidates,
#   in order of likely size: OMP's base system prompt, the ~30 native tool schemas,
#   AGENTS.md (2,782 tok, measured), and the Paperclip contract template. Unresolved
#   — measure it from the session JSONL before acting on it.
set -euo pipefail

API="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
REPO="$(cd "$(dirname "$0")/.." > /dev/null && pwd)"
POLICY="$REPO/omp/engineer.policy.yml"
GUARD="$REPO/omp/worktree-guard.js"

[ -f "$POLICY" ] || { echo "FATAL: missing $POLICY" >&2; exit 1; }
[ -f "$GUARD"  ] || { echo "FATAL: missing $GUARD"  >&2; exit 1; }

curl -sf -m 5 "$API/api/health" > /dev/null || {
  echo "FATAL: Paperclip API unreachable at $API" >&2
  echo "  The control plane must be up before this can apply." >&2
  exit 1
}

COMPANY="$(curl -sf "$API/api/companies" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].id')"
AGENTS="$(curl -sf "$API/api/companies/$COMPANY/agents")"
export AGENTS

agent_id() { node -pe '
  const a = JSON.parse(process.env.AGENTS);
  const arr = Array.isArray(a) ? a : (a.agents || []);
  const hit = arr.find(x => x.name === process.argv[1]);
  if (!hit) { console.error("no agent named " + process.argv[1]); process.exit(1); }
  hit.id' "$1"; }

ENGINEER="$(agent_id "OMP Engineer")"
REVIEWER="$(agent_id "OMP Reviewer")"

# Merge into the CURRENT adapterConfig rather than replacing it: instructionsFilePath
# and the other managed instruction-bundle keys must survive untouched.
patch_agent() {
  local id="$1" name="$2" patch="$3" cur next body
  cur="$(curl -sf "$API/api/agents/$id" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).adapterConfig)')"
  next="$(CUR="$cur" PATCH="$patch" node -pe '
    const cur = JSON.parse(process.env.CUR), p = JSON.parse(process.env.PATCH);
    JSON.stringify({ ...cur, ...p })')"
  body="$(NEXT="$next" node -pe 'JSON.stringify({ adapterConfig: JSON.parse(process.env.NEXT) })')"
  curl -sf -X PATCH "$API/api/agents/$id" -H 'content-type: application/json' -d "$body" > /dev/null
  echo "  patched $name"
}

echo "company:  $COMPANY"
echo "engineer: $ENGINEER"
echo "reviewer: $REVIEWER"
echo

patch_agent "$ENGINEER" "OMP Engineer" "$(POLICY="$POLICY" GUARD="$GUARD" node -pe '
  JSON.stringify({
    approvalMode: "yolo",
    autoApprove: true,
    configFiles: process.env.POLICY,
    hooks: process.env.GUARD
  })')"

patch_agent "$REVIEWER" "OMP Reviewer" '{"approvalMode":"yolo","autoApprove":true}'

echo
echo "--- verifying by read-back ---"
FAIL=0
for pair in "$ENGINEER:OMP Engineer" "$REVIEWER:OMP Reviewer"; do
  id="${pair%%:*}"; name="${pair#*:}"
  out="$(curl -sf "$API/api/agents/$id" | NAME="$name" node -pe '
    const a = JSON.parse(require("fs").readFileSync(0, "utf8")), c = a.adapterConfig || {};
    const rows = [
      ["approvalMode", c.approvalMode],
      ["configFiles",  c.configFiles || "(none)"],
      ["hooks",        c.hooks || "(none)"],
      ["skills",       (c.skills || "").split(",").filter(Boolean).length + " skills"],
    ];
    rows.map(([k, v]) => "  " + process.env.NAME + "  " + k.padEnd(13) + " " + v).join("\n")')"
  echo "$out"
  echo "$out" | grep -q "approvalMode  yolo" || { echo "  FAIL: $name approvalMode did not persist" >&2; FAIL=1; }
done
[ "$FAIL" -eq 0 ] || { echo; echo "VERIFY FAILED — the PATCH returned 200 but did not persist." >&2; exit 1; }

echo
echo "P0 applied and verified."
echo
echo "NOT yet safe to re-dispatch ZEI-1. The Engineer has no worktree to be confined"
echo "to, so worktree-guard.js fails closed on every write by design. Land the project"
echo "git_worktree execution-workspace policy first, then re-dispatch."
