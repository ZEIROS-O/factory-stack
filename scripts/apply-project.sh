#!/usr/bin/env bash
# P1-B — bind X-Bookmarks as a Paperclip project with git_worktree isolation.
#
# THIS IS THE BOUNDARY. Everything in omp/ is defence in depth behind it.
#
# Before: the Engineer woke in an empty fallback workspace, was told in prose which
# repository to use and which uncommitted files not to touch, and had to build its
# own worktree with tools that were gated off. Isolation depended on the agent.
#
# After: Paperclip creates the worktree and branch, then places the agent inside it
# with PAPERCLIP_WORKSPACE_WORKTREE_PATH and PAPERCLIP_WORKSPACE_BRANCH set. The
# operator's uncommitted work stays in the primary tree, which the agent never enters.
# Isolation depends on the harness. That is doctrine §6 satisfied rather than asserted.
#
# BRANCH TEMPLATE — verified against workspace-runtime.js, not guessed.
#   Available: {{issue.id}} {{issue.identifier}} {{issue.title}} {{agent.id}}
#              {{agent.name}} {{project.id}} {{workspace.repoRef}} {{slug}}
#   sanitizeBranchName keeps [A-Za-z0-9._/-] and truncates at 120 chars.
#   `paperclip/` prefix means any such branch in X-Bookmarks is agent-created and
#   identifiable at a glance in `git branch`.
#
# WORKTREE LOCATION
#   worktreeParentDir defaults to <repoRoot>/.paperclip/worktrees — inside the repo.
#   Pointed outside it instead, so agent worktrees never appear as untracked noise in
#   the operator's `git status`.
#
# BASE REF LAYERING
#   The project workspace declares the repo's long-lived default (main). ZEI-1 needs
#   to branch from feat/new-bookmarks-snapshot, so it overrides baseRef per issue via
#   executionWorkspaceSettings. Project sets the default, issue states the exception.
#
# allowIssueOverride is TRUE on purpose: an issue must be able to declare its own
# baseRef. It could in principle also downgrade to operator_branch — but that yields
# no worktree, so omp/worktree-guard.js fails closed and blocks every write. The hole
# is covered by the layer below rather than by forbidding the field above.
#
# Idempotent. Creates nothing that already exists. Verifies by read-back.
set -euo pipefail

API="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
PROJECT_NAME="X-Bookmarks"
REPO_PATH="/home/lucascoh/X-Bookmarks"
DEFAULT_REF="main"
WORKTREE_PARENT="/home/lucascoh/.paperclip/worktrees/X-Bookmarks"
ISSUE_ID="cc4fc719-ef7c-4e7a-bc3f-2124e021ef8d"
ISSUE_BASE_REF="feat/new-bookmarks-snapshot"
# issue.goalId is derived from the project's goals once an issue is bound to a
# project. Binding ZEI-1 to a project with no goals silently cleared its goalId, so
# the project carries the company goal and issues inherit it structurally.
GOAL_ID="b73e84c0-0ec4-41dd-bf8f-cca8b80743e9"

curl -sf -m 5 "$API/api/health" > /dev/null || {
  echo "FATAL: Paperclip API unreachable at $API" >&2; exit 1; }

# --------------------------------------------------- instance prerequisite
# Isolated workspaces are behind an instance experimental flag. With it off, the
# server SILENTLY DELETES executionWorkspaceId / executionWorkspacePreference /
# executionWorkspaceSettings from both issue create and issue update, then returns
# 200 with the unchanged issue (services/issues.js:5312, :5610, :5850). It is also
# the dispatch-time gate on issue workspace settings (services/heartbeat.js:10677).
# Discovered the hard way: the first run of this script wrote projectId and nothing
# else, and only the read-back caught it.
#
# NOT enableWorktreeRunExecution — that one arms only when the Paperclip server
# itself runs inside a worktree (PAPERCLIP_IN_WORKTREE) and is unrelated to agent
# execution workspaces. Do not enable it here.
EXPERIMENTAL="$(curl -sf "$API/api/instance/settings/experimental")"
ISO="$(EXP="$EXPERIMENTAL" node -pe '
  const d = JSON.parse(process.env.EXP); (d.experimental || d).enableIsolatedWorkspaces === true')"
if [ "$ISO" != "true" ]; then
  echo "enableIsolatedWorkspaces is off — enabling (instance experimental setting)"
  curl -sf -X PATCH "$API/api/instance/settings/experimental" \
    -H 'content-type: application/json' -d '{"enableIsolatedWorkspaces":true}' > /dev/null
  ISO="$(curl -sf "$API/api/instance/settings/experimental" | node -pe '
    const d = JSON.parse(require("fs").readFileSync(0,"utf8")); (d.experimental || d).enableIsolatedWorkspaces === true')"
  [ "$ISO" = "true" ] || { echo "FATAL: could not enable enableIsolatedWorkspaces" >&2; exit 1; }
  echo "  enabled and verified"
else
  echo "enableIsolatedWorkspaces already on"
fi
[ -d "$REPO_PATH/.git" ] || { echo "FATAL: $REPO_PATH is not a git repository" >&2; exit 1; }
git -C "$REPO_PATH" rev-parse --verify "$DEFAULT_REF" > /dev/null 2>&1 || {
  echo "FATAL: $DEFAULT_REF does not exist in $REPO_PATH" >&2; exit 1; }
git -C "$REPO_PATH" rev-parse --verify "$ISSUE_BASE_REF" > /dev/null 2>&1 || {
  echo "FATAL: $ISSUE_BASE_REF does not exist in $REPO_PATH" >&2; exit 1; }

COMPANY="$(curl -sf "$API/api/companies" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].id')"

# ---------------------------------------------------------------- project
PROJECTS="$(curl -sf "$API/api/companies/$COMPANY/projects")"
PROJECT_ID="$(PROJECTS="$PROJECTS" NAME="$PROJECT_NAME" node -pe '
  const a = JSON.parse(process.env.PROJECTS);
  const arr = Array.isArray(a) ? a : (a.projects || []);
  (arr.find(p => p.name === process.env.NAME) || {}).id || ""')"

POLICY="$(WT="$WORKTREE_PARENT" node -pe '
  JSON.stringify({
    enabled: true,
    defaultMode: "isolated_workspace",
    allowIssueOverride: true,
    workspaceStrategy: {
      type: "git_worktree",
      branchTemplate: "paperclip/{{issue.identifier}}",
      worktreeParentDir: process.env.WT
    }
  })')"

if [ -z "$PROJECT_ID" ]; then
  BODY="$(NAME="$PROJECT_NAME" POLICY="$POLICY" GOAL="$GOAL_ID" node -pe '
    JSON.stringify({
      name: process.env.NAME,
      description: "X-Bookmarks. Agent work runs in git worktrees under " +
                   "/home/lucascoh/.paperclip/worktrees. The primary tree belongs to the operator.",
      status: "in_progress",
      icon: "folder",
      goalIds: [process.env.GOAL],
      executionWorkspacePolicy: JSON.parse(process.env.POLICY)
    })')"
  PROJECT_ID="$(curl -sf -X POST "$API/api/companies/$COMPANY/projects" \
    -H 'content-type: application/json' -d "$BODY" \
    | node -pe 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); (d.project||d).id')"
  echo "created project $PROJECT_NAME  $PROJECT_ID"
else
  curl -sf -X PATCH "$API/api/projects/$PROJECT_ID" -H 'content-type: application/json' \
    -d "$(POLICY="$POLICY" GOAL="$GOAL_ID" node -pe '
      JSON.stringify({ goalIds: [process.env.GOAL], executionWorkspacePolicy: JSON.parse(process.env.POLICY) })')" \
    > /dev/null
  echo "project $PROJECT_NAME exists — policy and goal reconciled  $PROJECT_ID"
fi

# ------------------------------------------------------ project workspace
WORKSPACES="$(curl -sf "$API/api/projects/$PROJECT_ID/workspaces")"
WS_ID="$(WS="$WORKSPACES" CWD="$REPO_PATH" node -pe '
  const a = JSON.parse(process.env.WS);
  const arr = Array.isArray(a) ? a : (a.workspaces || []);
  (arr.find(w => w.cwd === process.env.CWD) || {}).id || ""')"

if [ -z "$WS_ID" ]; then
  BODY="$(CWD="$REPO_PATH" REF="$DEFAULT_REF" node -pe '
    JSON.stringify({
      name: "primary",
      sourceType: "local_path",
      cwd: process.env.CWD,
      defaultRef: process.env.REF,
      isPrimary: true
    })')"
  WS_ID="$(curl -sf -X POST "$API/api/projects/$PROJECT_ID/workspaces" \
    -H 'content-type: application/json' -d "$BODY" \
    | node -pe 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); (d.workspace||d).id')"
  echo "created workspace primary -> $REPO_PATH  $WS_ID"
else
  echo "workspace exists -> $REPO_PATH  $WS_ID"
fi

# ------------------------------------------------------------- bind ZEI-1
curl -sf -X PATCH "$API/api/issues/$ISSUE_ID" -H 'content-type: application/json' \
  -d "$(PID="$PROJECT_ID" REF="$ISSUE_BASE_REF" node -pe '
    JSON.stringify({
      projectId: process.env.PID,
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", baseRef: process.env.REF }
      }
    })')" > /dev/null
echo "bound ZEI-1 -> project, isolated_workspace, baseRef $ISSUE_BASE_REF"

# ------------------------------------------------------------- verify
echo
echo "--- verifying by read-back ---"
curl -sf "$API/api/projects/$PROJECT_ID" | node -pe '
  const p = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const q = p.project || p, pol = q.executionWorkspacePolicy || {}, s = pol.workspaceStrategy || {};
  [["project", q.name],
   ["enabled", pol.enabled],
   ["defaultMode", pol.defaultMode],
   ["strategy", s.type],
   ["branchTemplate", s.branchTemplate],
   ["worktreeParentDir", s.worktreeParentDir]
  ].map(([k,v]) => "  " + String(k).padEnd(18) + " " + v).join("\n")'

curl -sf "$API/api/issues/$ISSUE_ID" | node -pe '
  const i = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const s = (i.executionWorkspaceSettings || {});
  [["issue", i.identifier],
   ["status", i.status],
   ["projectId", i.projectId ? "set" : "NULL"],
   ["goalId", i.goalId ? "set" : "NULL"],
   ["preference", i.executionWorkspacePreference],
   ["baseRef", (s.workspaceStrategy || {}).baseRef]
  ].map(([k,v]) => "  " + String(k).padEnd(18) + " " + v).join("\n")'

FAILED=0
curl -sf "$API/api/issues/$ISSUE_ID" | node -pe '
  const i = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const s = i.executionWorkspaceSettings || {};
  (i.projectId
    && i.executionWorkspacePreference === "isolated_workspace"
    && (s.workspaceStrategy || {}).baseRef) ? "ok" : "BAD"' \
  | grep -q ok || FAILED=1
[ "$FAILED" -eq 0 ] || { echo; echo "VERIFY FAILED — issue binding did not persist." >&2; exit 1; }

echo
echo "Project bound and verified. No worktree exists yet: Paperclip materializes it"
echo "on the next dispatch. Nothing has been re-dispatched by this script."
