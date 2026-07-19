#!/usr/bin/env bash
# Stop hook — guarantees every Claude Code chat leaves a *summarized* smrtTask
# "הצעה". Two free mechanisms (NO paid API tokens — the summary is written by
# the agent on the user's Claude subscription):
#
#   1. ENFORCE the agent summary. On the FIRST stop of a turn-cycle we block the
#      stop and instruct the agent to write a short Hebrew summary and post it via
#      .claude/hooks/post-session-summary.sh. The harness sets `stop_hook_active`
#      to true when it re-runs us after the agent continued, which is our
#      loop-guard — on that second pass we do NOT block again.
#   2. SAFETY NET. On that second pass we fire-and-forget a minimal metadata
#      trace, so even a session where the agent failed to post still leaves a
#      row. The backend does a partial update: a summary-less trace NEVER
#      clobbers the agent's richer summary.
#
# Fully guarded: any missing env var / tool, or not-a-web-session, makes it a
# no-op that neither blocks nor fails a turn (exit 0). See CLAUDE.md →
# "smrtTask session proposals (Stop hook)".
set -uo pipefail

INPUT="$(cat)"

# ---- endpoint + secret resolution (shared with post-session-summary.sh) ----
SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTTASK_PROPOSAL_URL:-}" ]; then
  URL="$SMRTTASK_PROPOSAL_URL"
elif [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  URL="${SMRTESY_BACKEND_URL%/}/api/claude-session/proposal"
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

# Only a web (Claude Code on the web) session has a deep link worth filing and a
# session id to key the task on. Local/CLI sessions → no-op.
[ -z "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ] && exit 0

# Nowhere to post / tools missing → never block, never fail.
[ "$PROVISIONED" != "1" ] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STOP_ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"

if [ "$STOP_ACTIVE" != "true" ]; then
  # FIRST stop: force the agent to summarize before it may stop. The reason text
  # is fed back to the agent as its next instruction; it runs the helper, then
  # tries to stop again (this time with stop_hook_active=true).
  jq -cn '{
    decision: "block",
    reason: ("לפני שאתה עוצר — סכם את הסשן ל-smrtTask (זה רץ על המנוי, ללא עלות API):\n1) כתוב סיכום קצר בעברית: נושא, 2-3 משפטים מה נדון/נעשה, וצעד המשך מוצע. שמור קישורים עמוקים מלאים אם רלוונטי.\n2) הרץ בדיוק פקודה אחת:\n   .claude/hooks/post-session-summary.sh \"<נושא קצר>\" \"<סיכום 2-3 משפטים>\" \"<צעד המשך>\"\n   (הימנע מתו גרש-כפול \" בתוך הטקסט; השתמש ״ אם צריך.)\n3) אם הפלט כולל \"ok\":true — עצור. אל תריץ שוב ואל תבצע פעולות נוספות.")
  }'
  exit 0
fi

# SECOND stop (agent already ran): fire-and-forget the minimal safety-net trace,
# then allow the stop. build-session-proposal.mjs emits metadata only (no
# topic/summary), so the backend's partial update leaves any agent summary intact.
PAYLOAD="$(printf '%s' "$INPUT" | node "$HOOK_DIR/build-session-proposal.mjs" 2>/dev/null || true)"
if [ -n "$PAYLOAD" ]; then
  ( curl -sS -m 20 -L --post301 --post302 -X POST "$URL" \
      -H "Content-Type: application/json" \
      -H "X-Cron-Secret: $SECRET" \
      --data-binary "$PAYLOAD" >/dev/null 2>&1 || true ) &
fi

exit 0
