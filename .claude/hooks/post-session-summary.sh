#!/usr/bin/env bash
# Posts an AGENT-generated Hebrew summary to the smrtTask session-proposal
# endpoint, enriching the placeholder the Stop hook files. The summary is written
# by the Claude Code agent (on the user's Claude subscription) — ZERO paid API
# tokens. Called by the agent when the Stop hook blocks and asks for a summary.
#
# Usage (either form):
#   post-session-summary.sh "<topic>" "<summary>" "<next_step>"
#   post-session-summary.sh --json <path-to-json-file>   # {topic,summary,next_step}
#
# Resolves URL / secret / identity / session exactly like the Stop hook + the
# build-session-proposal.mjs builder, so it updates the SAME task (dedup tag
# claude-session:<session_id>). Silent, guarded no-op (exit 0) when not
# provisioned so it can never fail a turn. Prints the endpoint response so the
# agent can confirm success ("ok":true).
set -uo pipefail

command -v curl >/dev/null 2>&1 || { echo "post-summary: curl missing — skipped"; exit 0; }
command -v jq   >/dev/null 2>&1 || { echo "post-summary: jq missing — skipped"; exit 0; }

# ---- endpoint + secret (same resolution as the Stop hook) ----
SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTTASK_PROPOSAL_URL:-}" ]; then
  URL="$SMRTTASK_PROPOSAL_URL"
elif [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  URL="${SMRTESY_BACKEND_URL%/}/api/claude-session/proposal"
else
  URL=""
fi
case "$URL" in
  ""|http://*|https://*) ;;
  *) URL="https://$URL" ;;
esac
[ -z "$SECRET" ] && { echo "post-summary: no secret env (SMRTBOT_INTERNAL_SECRET/CRON_SECRET) — skipped"; exit 0; }
[ -z "$URL" ]    && { echo "post-summary: no backend URL env (SMRTESY_BACKEND_URL/SMRTTASK_PROPOSAL_URL) — skipped"; exit 0; }

# ---- gather topic / summary / next_step ----
TOPIC=""; SUMMARY=""; NEXT_STEP=""
if [ "${1:-}" = "--json" ]; then
  F="${2:-}"
  [ -f "$F" ] || { echo "post-summary: json file not found: $F — skipped"; exit 0; }
  TOPIC="$(jq -r '.topic // ""' "$F" 2>/dev/null || echo "")"
  SUMMARY="$(jq -r '.summary // ""' "$F" 2>/dev/null || echo "")"
  NEXT_STEP="$(jq -r '.next_step // ""' "$F" 2>/dev/null || echo "")"
else
  TOPIC="${1:-}"
  SUMMARY="${2:-}"
  NEXT_STEP="${3:-}"
fi
if [ -z "$TOPIC" ] && [ -z "$SUMMARY" ]; then
  echo "post-summary: nothing to post (empty topic+summary) — skipped"; exit 0
fi

# ---- session identity (same derivation as build-session-proposal.mjs) ----
REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
[ -z "$REMOTE" ] && { echo "post-summary: no CLAUDE_CODE_REMOTE_SESSION_ID — skipped"; exit 0; }
case "$REMOTE" in
  cse_*) SLUG="${REMOTE#cse_}";;
  *)     SLUG="$REMOTE";;
esac
SESSION_ID="$REMOTE"
SESSION_URL=""
[ -n "$SLUG" ] && SESSION_URL="https://claude.ai/code/session_${SLUG}"

# git branch from cwd (best-effort)
BRANCH=""
if [ -f .git/HEAD ]; then
  HEAD_CONTENT="$(cat .git/HEAD 2>/dev/null || true)"
  case "$HEAD_CONTENT" in
    ref:*) BRANCH="${HEAD_CONTENT##*/}";;
  esac
fi

# Repo name from the git remote (portable — NOT hardcoded, so the same hook
# reports the correct repo wherever it's installed). Fall back to cwd basename.
REPO=""
ORIGIN_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
if [ -n "$ORIGIN_URL" ]; then
  REPO="${ORIGIN_URL##*/}"; REPO="${REPO%.git}"
fi
[ -z "$REPO" ] && REPO="${PWD##*/}"
[ -z "$REPO" ] && REPO="repo"

USER_ID="${SMRTTASK_USER_ID:-}"
USER_EMAIL="${SMRTTASK_USER_EMAIL:-${CLAUDE_CODE_USER_EMAIL:-}}"

# Claude ACCOUNT identity that ran the chat — tracked separately from USER_EMAIL
# (which may be an overridden platform account used only for resolution). No
# dedicated display-name env exists, so the username is the login local-part.
CLAUDE_EMAIL="${CLAUDE_CODE_USER_EMAIL:-}"
CLAUDE_NAME=""
[ -n "$CLAUDE_EMAIL" ] && CLAUDE_NAME="${CLAUDE_EMAIL%%@*}"

# ---- build the body (jq --arg escapes everything safely) ----
BODY="$(jq -n \
  --arg session_id "$SESSION_ID" \
  --arg session_url "$SESSION_URL" \
  --arg user_id "$USER_ID" \
  --arg user_email "$USER_EMAIL" \
  --arg claude_user_email "$CLAUDE_EMAIL" \
  --arg claude_user_name "$CLAUDE_NAME" \
  --arg repo "$REPO" \
  --arg git_branch "$BRANCH" \
  --arg topic "$TOPIC" \
  --arg summary "$SUMMARY" \
  --arg next_step "$NEXT_STEP" \
  '{session_id:$session_id, session_url:$session_url, user_id:$user_id, user_email:$user_email, claude_user_email:$claude_user_email, claude_user_name:$claude_user_name, repo:$repo, git_branch:$git_branch, topic:$topic, summary:$summary, next_step:$next_step}')"

RESP="$(curl -sS -m 20 -L --post301 --post302 -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Cron-Secret: $SECRET" \
  --data-binary "$BODY" 2>&1 || true)"
echo "post-summary → ${RESP:-<no response>}"
exit 0
