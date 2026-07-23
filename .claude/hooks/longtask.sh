#!/usr/bin/env bash
# Agent-run helper for the "long-task auto-resume on token exhaustion" mechanism.
#
# A "long task" is any multi-step job that might outlive the current usage
# window (subscription token limit). Because Claude Code gives NO reliable hook
# signal for "the session stopped because tokens ran out" (and no reset time),
# we cannot react AFTER exhaustion. Instead we arm the resume UP FRONT: the agent
# drops a checkpoint here + arms a self-binding hourly watchdog Routine. If the
# session then dies from a usage limit, the Routine keeps firing (hourly) and the
# first firing after the window resets continues the task from the checkpoint —
# in the SAME conversation (the Routine self-binds to this session by default).
#
# All of this runs on the user's Claude subscription — ZERO paid API tokens
# (creating/deleting Routines and continuing the chat are agent actions).
#
# Usage:
#   longtask.sh arm  "<title>" "<state>" ["<max_hours>"]   # start / re-arm
#   longtask.sh record-trigger "<trigger_id>"              # after create_trigger
#   longtask.sh update "<state>"                           # refresh progress note
#   longtask.sh tick                                       # watchdog: bump attempt
#   longtask.sh show                                       # print checkpoint JSON
#   longtask.sh done                                       # mark finished + clean up
#
# Guarded no-op (exit 0) when not a web session / jq missing, so it never fails a
# turn. See CLAUDE.md → "Long-task auto-resume on token exhaustion".
set -uo pipefail

command -v jq >/dev/null 2>&1 || { echo "longtask: jq missing — skipped"; exit 0; }

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
[ -z "$REMOTE" ] && { echo "longtask: not a web session — skipped"; exit 0; }
case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac
SESSION_URL=""; [ -n "$SLUG" ] && SESSION_URL="https://claude.ai/code/session_${SLUG}"

mkdir -p .claude/tmp 2>/dev/null || true
CK=".claude/tmp/longtask-${SLUG}.json"
COUNTER=".claude/tmp/longtask-guard-${SLUG}.count"

now_epoch() { date -u +%s; }
now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }

CMD="${1:-}"; shift || true

# The prompt the watchdog Routine fires (hourly) into THIS session. Kept in sync
# with CLAUDE.md. <SLUG> is substituted so the resumed turn finds its checkpoint.
watchdog_prompt() {
  cat <<EOF
[המשך אוטומטי של משימה ארוכה — watchdog]
המשימה הזו נועדה להמשיך את עצמה אחרי שהטוקנים התאפסו. פעל בדיוק כך:
1) הרץ: .claude/hooks/longtask.sh tick
2) אם הפלט כולל NO_CHECKPOINT או EXPIRED או status=done — המשימה נגמרה/פגה. קרא את trigger_id מהפלט והרץ delete_trigger עליו כדי לבטל את ה-Routine הזה, ואל תעשה שום דבר נוסף. עצור.
3) אחרת (status=open) — הגעת לכאן ולכן יש טוקנים. המשך את המשימה מהמצב שמתואר ב-.claude/tmp/longtask-${SLUG}.json ומהשיחה הזו (זו אותה שיחה, יש לך את כל ההקשר).
4) אם סיימת את כל המשימה: הרץ delete_trigger על trigger_id, ואז .claude/hooks/longtask.sh done. עצור.
5) אם לא סיימת בתור הזה: הרץ .claude/hooks/longtask.sh update "<מצב עדכני קצר>" — ה-Routine ימשיך אוטומטית בשעה הבאה.
EOF
}

case "$CMD" in
  arm)
    TITLE="${1:-משימה ארוכה}"; STATE="${2:-}"; MAX_HOURS="${3:-24}"
    case "$MAX_HOURS" in ''|*[!0-9]*) MAX_HOURS=24 ;; esac
    [ "$MAX_HOURS" -lt 1 ] 2>/dev/null && MAX_HOURS=24
    NOW="$(now_epoch)"; EXP=$(( NOW + MAX_HOURS * 3600 ))
    # Preserve an existing trigger_id if this is a re-arm of the same task.
    PREV_TRIG=""; [ -f "$CK" ] && PREV_TRIG="$(jq -r '.trigger_id // ""' "$CK" 2>/dev/null || echo "")"
    # Atomic write (temp + mv) so a jq failure never truncates a good checkpoint
    # (which on a re-arm would drop the recorded trigger_id).
    if jq -n \
      --arg session_id "$REMOTE" --arg session_url "$SESSION_URL" \
      --arg title "$TITLE" --arg state "$STATE" \
      --arg trigger_id "$PREV_TRIG" \
      --arg created_at "$(now_iso)" --arg updated_at "$(now_iso)" \
      --argjson expires_epoch "$EXP" --arg expires_at "$(date -u -d "@$EXP" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || now_iso)" \
      --argjson max_attempts "$MAX_HOURS" \
      '{session_id:$session_id, session_url:$session_url, title:$title, state:$state,
        status:"open", trigger_id:$trigger_id, attempts:0, max_attempts:$max_attempts,
        expires_epoch:$expires_epoch, expires_at:$expires_at,
        created_at:$created_at, updated_at:$updated_at}' > "$CK.tmp" 2>/dev/null; then
      mv "$CK.tmp" "$CK"
    else
      rm -f "$CK.tmp" 2>/dev/null || true
      echo "longtask: failed to write checkpoint — skipped"; exit 0
    fi
    rm -f "$COUNTER" 2>/dev/null || true   # fresh task → reset the guard's nag counter
    echo "longtask: checkpoint armed → $CK  (status=open, expires_at=$(date -u -d "@$EXP" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "+${MAX_HOURS}h"))"
    echo
    echo "עכשיו חמש את ה-Routine להמשך. קרא ל-create_trigger עם הפרמטרים הבאים (אל תגדיר persistent_session_id — ברירת המחדל נצמדת לסשן הזה):"
    echo "  name:            \"המשך משימה ארוכה — ${TITLE}\""
    echo "  cron_expression: \"0 * * * *\""
    echo "  prompt: |"
    watchdog_prompt | sed 's/^/    /'
    echo
    echo "אחרי שתקבל trigger_id, הרץ מיד: .claude/hooks/longtask.sh record-trigger <trigger_id>"
    ;;

  record-trigger)
    TRIG="${1:-}"
    [ -z "$TRIG" ] && { echo "longtask: record-trigger needs a <trigger_id> — skipped"; exit 0; }
    [ -f "$CK" ] || { echo "longtask: no checkpoint to record onto ($CK) — run 'arm' first"; exit 0; }
    TMP="$(jq --arg t "$TRIG" --arg u "$(now_iso)" '.trigger_id=$t | .updated_at=$u' "$CK" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$CK"
    rm -f "$COUNTER" 2>/dev/null || true   # armed → stop nagging
    echo "longtask: recorded trigger_id=$TRIG on $CK — resume is now armed."
    ;;

  update)
    STATE="${1:-}"
    [ -f "$CK" ] || { echo "longtask: no checkpoint to update ($CK)"; exit 0; }
    TMP="$(jq --arg s "$STATE" --arg u "$(now_iso)" '.state=$s | .updated_at=$u' "$CK" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$CK"
    echo "longtask: checkpoint state updated."
    ;;

  tick)
    if [ ! -f "$CK" ]; then echo "NO_CHECKPOINT (nothing to resume)"; echo "trigger_id="; exit 0; fi
    # A corrupt/unparseable checkpoint → treat as no-checkpoint so the watchdog
    # self-terminates instead of resuming the task on garbage state.
    if ! jq empty "$CK" 2>/dev/null; then
      TRIG="$(grep -o '"trigger_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$CK" 2>/dev/null | grep -o 'trig_[A-Za-z0-9_-]*' | head -1 || true)"
      echo "trigger_id=${TRIG:-}"; echo "NO_CHECKPOINT (corrupt)"; exit 0
    fi
    STATUS="$(jq -r '.status // "open"' "$CK" 2>/dev/null || echo open)"
    TRIG="$(jq -r '.trigger_id // ""' "$CK" 2>/dev/null || echo "")"
    ATTEMPTS="$(jq -r '.attempts // 0' "$CK" 2>/dev/null || echo 0)"
    MAXA="$(jq -r '.max_attempts // 24' "$CK" 2>/dev/null || echo 24)"
    EXP="$(jq -r '.expires_epoch // 0' "$CK" 2>/dev/null || echo 0)"
    NOW="$(now_epoch)"
    ATTEMPTS=$(( ATTEMPTS + 1 ))
    TMP="$(jq --argjson a "$ATTEMPTS" --arg u "$(now_iso)" '.attempts=$a | .updated_at=$u' "$CK" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$CK"
    echo "trigger_id=$TRIG"
    echo "status=$STATUS attempt=$ATTEMPTS/$MAXA"
    if [ "$STATUS" = "done" ]; then echo "status=done (finished)"; fi
    if { [ "$EXP" -gt 0 ] && [ "$NOW" -ge "$EXP" ]; } 2>/dev/null; then echo "EXPIRED (time budget reached)"; fi
    if [ "$ATTEMPTS" -ge "$MAXA" ] 2>/dev/null; then echo "EXPIRED (max attempts reached)"; fi
    ;;

  show)
    [ -f "$CK" ] && cat "$CK" || echo "NO_CHECKPOINT"
    ;;

  done)
    if [ -f "$CK" ]; then
      TRIG="$(jq -r '.trigger_id // ""' "$CK" 2>/dev/null || echo "")"
      echo "trigger_id=$TRIG"
      echo "longtask: task marked done — delete the Routine with delete_trigger($TRIG) if not already, then this checkpoint is removed."
      rm -f "$CK" 2>/dev/null || true
    else
      echo "trigger_id="
      echo "longtask: no checkpoint present — nothing to clean up."
    fi
    rm -f "$COUNTER" 2>/dev/null || true
    ;;

  *)
    echo "longtask: unknown command '${CMD:-}'. Use: arm | record-trigger | update | tick | show | done"
    ;;
esac
exit 0
