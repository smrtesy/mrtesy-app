#!/usr/bin/env bash
# Stop hook — enforcer for the "long-task auto-resume" mechanism.
#
# It does NOTHING for a normal session: if there is no OPEN long-task checkpoint
# for this session it exits immediately (the 99% case → zero overhead, zero risk).
#
# When an OPEN checkpoint EXISTS but its resume Routine was never armed
# (trigger_id empty), it blocks the stop ONCE and feeds the agent an instruction
# to arm it via create_trigger + record-trigger. A shell hook cannot call the MCP
# create_trigger tool itself, so this block-and-instruct is the only way to make
# the arming reliable instead of best-effort.
#
# Loop-guard: it blocks at most $MAX_BLOCKS times per session (a local counter),
# so a failure to arm degrades gracefully to "just work without a Routine" instead
# of nagging forever. Independent of the harness's stop_hook_active flag, so it
# coexists with the smrttask summary Stop hook without fighting over it.
#
# Fully guarded: not a web session / jq missing / any error → exit 0 (never block,
# never fail a turn). See CLAUDE.md → "Long-task auto-resume on token exhaustion".
set -uo pipefail

# Consume stdin so the hook input pipe never breaks (payload itself is unused).
cat >/dev/null 2>&1 || true

command -v jq >/dev/null 2>&1 || exit 0

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
[ -z "$REMOTE" ] && exit 0
case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac

CK=".claude/tmp/longtask-${SLUG}.json"
COUNTER=".claude/tmp/longtask-guard-${SLUG}.count"
MAX_BLOCKS=3

# No open long-task checkpoint → nothing to enforce.
[ -f "$CK" ] || exit 0
STATUS="$(jq -r '.status // ""' "$CK" 2>/dev/null || echo "")"
[ "$STATUS" = "open" ] || exit 0

# Already armed (Routine recorded) → nothing to do.
TRIG="$(jq -r '.trigger_id // ""' "$CK" 2>/dev/null || echo "")"
[ -n "$TRIG" ] && exit 0

# Loop-guard: stop nagging after MAX_BLOCKS.
COUNT=0; [ -f "$COUNTER" ] && COUNT="$(tr -dc '0-9' < "$COUNTER" 2>/dev/null || echo 0)"
[ -z "$COUNT" ] && COUNT=0
if [ "$COUNT" -ge "$MAX_BLOCKS" ] 2>/dev/null; then exit 0; fi
echo $(( COUNT + 1 )) > "$COUNTER" 2>/dev/null || true

TITLE="$(jq -r '.title // "משימה ארוכה"' "$CK" 2>/dev/null || echo "משימה ארוכה")"

# Block once and instruct the agent to arm the resume Routine.
jq -cn --arg ck "$CK" --arg title "$TITLE" '{
  decision: "block",
  reason: ("יש משימה ארוכה פתוחה (\"" + $title + "\") בלי Routine להמשך אוטומטי — חמש אותו עכשיו לפני שאתה עוצר, כדי שאם ייגמרו הטוקנים הריצה תתחדש לבד:\n1) הרץ: .claude/hooks/longtask.sh arm \"" + $title + "\" \"<תיאור קצר של מה נעשה ומה נשאר>\"  — זה ידפיס את הפרמטרים ל-create_trigger.\n2) קרא ל-create_trigger עם אותם פרמטרים (cron \"0 * * * *\", בלי persistent_session_id).\n3) הרץ: .claude/hooks/longtask.sh record-trigger <trigger_id>\nאם המשימה כבר הסתיימה — הרץ .claude/hooks/longtask.sh done ואל תחמש כלום. מקור האמת: " + $ck + ".")
}' 2>/dev/null || exit 0
exit 0
