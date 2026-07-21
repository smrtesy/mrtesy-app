#!/usr/bin/env bash
# Stop hook (video-lab) — guarantees every Claude Code session in this repo
# leaves a status update on the worker's CURRENT smrtPlan task. Two free
# mechanisms (NO paid API tokens — the summary is written by the agent on the
# user's Claude subscription):
#
#   1. ENFORCE the agent report. On the FIRST stop of a turn-cycle we block the
#      stop and instruct the agent to write a short summary + status and post
#      it via .claude/hooks/post-session-report.sh. The harness sets
#      `stop_hook_active` to true when it re-runs us after the agent
#      continued, which is our loop-guard — on that second pass we do NOT
#      block again.
#   2. SAFETY NET. On that second pass we fire-and-forget a minimal report
#      (status "in_progress", generic summary), so even a session where the
#      agent forgot still posts something. The backend attaches it to
#      whichever task the reporting user currently has marked "in_progress" —
#      no task id is sent from here; the backend finds it by user + org.
#
# Fully guarded: any missing env var / tool, or not-a-web-session, makes it a
# no-op that neither blocks nor fails a turn (exit 0).
#
# NOTE: this file is a TEMPLATE authored in the mrtesy-app repo purely to get
# a stable, linkable location. It is meant to be copied into the video-lab
# repo at .claude/hooks/video-lab-session-report.sh — see README.md in this
# same docs folder for the install steps and the settings.json wiring.
set -uo pipefail

INPUT="$(cat)"

# ---- endpoint + secret resolution (shared with post-session-report.sh) ----
SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTPLAN_REPORT_URL:-}" ]; then
  URL="$SMRTPLAN_REPORT_URL"
elif [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  URL="${SMRTESY_BACKEND_URL%/}/api/claude-session/task-report"
else
  URL=""
fi
# Normalize a schemeless host to https:// (Railway 301-redirects http→https and a
# POST does not replay the body across the redirect).
case "$URL" in
  ""|http://*|https://*) ;;
  *) URL="https://$URL" ;;
esac

# Provisioned = we have somewhere to post AND the tools to do it.
PROVISIONED=1
[ -z "$SECRET" ] && PROVISIONED=0
[ -z "$URL" ] && PROVISIONED=0
command -v node >/dev/null 2>&1 || PROVISIONED=0
command -v curl >/dev/null 2>&1 || PROVISIONED=0
command -v jq   >/dev/null 2>&1 || PROVISIONED=0

# Only a web (Claude Code on the web) session has a session id to key the
# report on. Local/CLI sessions → no-op.
[ -z "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ] && exit 0

# Nowhere to post / tools missing → never block, never fail.
[ "$PROVISIONED" != "1" ] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STOP_ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"

if [ "$STOP_ACTIVE" != "true" ]; then
  # FIRST stop: force the agent to report before it may stop. The reason text
  # is fed back to the agent as its next instruction; it runs the helper, then
  # tries to stop again (this time with stop_hook_active=true).
  jq -cn '{
    decision: "block",
    reason: ("לפני שאתה עוצר — דווח על סטטוס המשימה הנוכחית ב-smrtPlan (זה רץ על המנוי, ללא עלות API):\n1) כתוב סיכום קצר: מה נעשה בסשן הזה, ביחס למשימה שמסומנת \"in_progress\" אצל המשתמש ב-smrtPlan.\n2) קבע סטטוס: in_progress (עדיין בעבודה), blocked (תקוע/צריך קלט), או done (הושלם).\n3) הרץ בדיוק פקודה אחת:\n   .claude/hooks/post-session-report.sh \"<סיכום קצר>\" \"<in_progress|blocked|done>\"\n   (הימנע מתו גרש-כפול \" בתוך הטקסט; השתמש ״ אם צריך.)\n4) אם הפלט כולל \"ok\":true — עצור. אל תריץ שוב ואל תבצע פעולות נוספות. אם \"attached\":false, זה תקין — פשוט אין למשתמש משימה מסומנת in_progress כרגע.")
  }'
  exit 0
fi

# SECOND stop (agent already ran): fire-and-forget a minimal safety-net
# report — status "in_progress", generic summary — so even a session where the
# agent failed to post still leaves a trace on the user's current task.
SESSION_ID="${CLAUDE_CODE_REMOTE_SESSION_ID}"
case "$SESSION_ID" in
  cse_*) SLUG="${SESSION_ID#cse_}";;
  *)     SLUG="$SESSION_ID";;
esac
SESSION_URL="https://claude.ai/code/session_${SLUG}"
USER_ID="${SMRTTASK_USER_ID:-}"
USER_EMAIL="${SMRTTASK_USER_EMAIL:-${CLAUDE_CODE_USER_EMAIL:-}}"

PAYLOAD="$(jq -n \
  --arg session_id "$SESSION_ID" \
  --arg session_url "$SESSION_URL" \
  --arg user_id "$USER_ID" \
  --arg user_email "$USER_EMAIL" \
  --arg summary "עדכון אוטומטי מסשן Claude Code (video-lab) — הסוכן לא פרסם סיכום ידני." \
  --arg status "in_progress" \
  '{session_id:$session_id, session_url:$session_url, user_id:$user_id, user_email:$user_email, summary:$summary, status:$status}')"

if [ -n "$PAYLOAD" ]; then
  ( curl -sS -m 20 -L --post301 --post302 -X POST "$URL" \
      -H "Content-Type: application/json" \
      -H "X-Cron-Secret: $SECRET" \
      --data-binary "$PAYLOAD" >/dev/null 2>&1 || true ) &
fi

exit 0
