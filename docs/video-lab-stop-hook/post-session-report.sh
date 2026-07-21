#!/usr/bin/env bash
# Posts an AGENT-generated status report to the smrtPlan task-report endpoint.
# The backend attaches it to whichever task the reporting user currently has
# marked "in_progress" — no task id is sent from here; the backend finds it by
# user + org. The summary is written by the Claude Code agent (on the user's
# Claude subscription) — ZERO paid API tokens. Called by the agent when the
# Stop hook blocks and asks for a report.
#
# Usage:
#   post-session-report.sh "<summary>" "<status>"
#     status is one of: in_progress, blocked, done
#
# Resolves URL / secret / identity / session exactly like the Stop hook
# (video-lab-session-report.sh), so it targets the same endpoint. Silent,
# guarded no-op (exit 0) when not provisioned so it can never fail a turn.
# Prints the endpoint response so the agent can confirm success ("ok":true).
# "attached":false in the response is NOT an error — it just means the user
# had no in_progress task at the time; log it quietly.
#
# NOTE: this file is a TEMPLATE authored in the mrtesy-app repo purely to get
# a stable, linkable location. It is meant to be copied into the video-lab
# repo at .claude/hooks/post-session-report.sh — see README.md in this same
# docs folder for install steps.
set -uo pipefail

command -v curl >/dev/null 2>&1 || { echo "post-session-report: curl missing — skipped"; exit 0; }
command -v jq   >/dev/null 2>&1 || { echo "post-session-report: jq missing — skipped"; exit 0; }

# ---- endpoint + secret (same resolution as the Stop hook) ----
SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTPLAN_REPORT_URL:-}" ]; then
  URL="$SMRTPLAN_REPORT_URL"
elif [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  URL="${SMRTESY_BACKEND_URL%/}/api/claude-session/task-report"
else
  URL=""
fi
case "$URL" in
  ""|http://*|https://*) ;;
  *) URL="https://$URL" ;;
esac
[ -z "$SECRET" ] && { echo "post-session-report: no secret env (SMRTBOT_INTERNAL_SECRET/CRON_SECRET) — skipped"; exit 0; }
[ -z "$URL" ]    && { echo "post-session-report: no backend URL env (SMRTESY_BACKEND_URL/SMRTPLAN_REPORT_URL) — skipped"; exit 0; }

# ---- gather summary / status ----
SUMMARY="${1:-}"
STATUS="${2:-}"
if [ -z "$SUMMARY" ]; then
  echo "post-session-report: nothing to post (empty summary) — skipped"; exit 0
fi
case "$STATUS" in
  in_progress|blocked|done) ;;
  *)
    echo "post-session-report: status must be one of in_progress|blocked|done (got: \"$STATUS\") — defaulting to in_progress"
    STATUS="in_progress"
    ;;
esac

# ---- session identity (same derivation as the Stop hook) ----
REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
[ -z "$REMOTE" ] && { echo "post-session-report: no CLAUDE_CODE_REMOTE_SESSION_ID — skipped"; exit 0; }
case "$REMOTE" in
  cse_*) SLUG="${REMOTE#cse_}";;
  *)     SLUG="$REMOTE";;
esac
SESSION_ID="$REMOTE"
SESSION_URL=""
[ -n "$SLUG" ] && SESSION_URL="https://claude.ai/code/session_${SLUG}"

USER_ID="${SMRTTASK_USER_ID:-}"
USER_EMAIL="${SMRTTASK_USER_EMAIL:-${CLAUDE_CODE_USER_EMAIL:-}}"

# ---- build the body (jq --arg escapes everything safely) ----
BODY="$(jq -n \
  --arg session_id "$SESSION_ID" \
  --arg session_url "$SESSION_URL" \
  --arg user_id "$USER_ID" \
  --arg user_email "$USER_EMAIL" \
  --arg summary "$SUMMARY" \
  --arg status "$STATUS" \
  '{session_id:$session_id, session_url:$session_url, user_id:$user_id, user_email:$user_email, summary:$summary, status:$status}')"

RESP="$(curl -sS -m 20 -L --post301 --post302 -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Cron-Secret: $SECRET" \
  --data-binary "$BODY" 2>&1 || true)"
echo "post-session-report → ${RESP:-<no response>}"
exit 0
