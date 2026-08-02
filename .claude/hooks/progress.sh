#!/usr/bin/env bash
#
# Viewer for the per-session tool-progress timeline written by the PostToolUse
# hook (tool-progress.sh). Turns an opaque "33 actions" run into a readable
# "where did the wall-clock go" report — times in New York (per CLAUDE.md).
#
#   progress.sh show        # full timeline + totals + slowest steps (default)
#   progress.sh tail [N]    # last N lines (default 15)
#   progress.sh latest      # one-line heartbeat: what ran last
#
# Read-only. Never fails a turn.
set -uo pipefail

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
SLUG="local"
if [ -n "$REMOTE" ]; then
  case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac
fi

LOG=".claude/tmp/progress-${SLUG}.log"
LATEST=".claude/tmp/progress-${SLUG}.latest"
CMD="${1:-show}"

human() { # seconds -> "2m36s" / "45s"
  local s="${1:-0}"
  case "$s" in ''|*[!0-9]*) s=0;; esac
  if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s/60)) $((s%60)); else printf '%ds' "$s"; fi
}

if [ ! -f "$LOG" ]; then
  echo "אין עדיין יומן-התקדמות לסשן הזה."
  echo "(הלוגר נטען בפתיחת סשן חדש; קובץ היעד: $LOG)"
  exit 0
fi

case "$CMD" in
  latest)
    if [ -f "$LATEST" ]; then cat "$LATEST"; else echo "—"; fi
    ;;
  tail)
    N="${2:-15}"
    tail -n "$N" "$LOG" | while IFS=$'\t' read -r ep hh th run tool sum; do
      printf '%s  ריצה %-7s %-12s %s\n' "$hh" "$(human "$run")" "$tool" "$sum"
    done
    ;;
  show|*)
    total=0; n=0
    echo "ציר-זמן הסשן (שעון ניו יורק) — ⏳=ריצה איטית  🧠=חשיבה ארוכה"
    echo "────────────────────────────────────────────────────────────"
    while IFS=$'\t' read -r ep hh th run tool sum; do
      n=$((n+1)); total=$(( total + ${th:-0} + ${run:-0} ))
      flag=""
      [ "${run:-0}" -ge 30 ] && flag="$flag ⏳"
      [ "${th:-0}" -ge 30 ]  && flag="$flag 🧠"
      printf '%s  חשיבה %-7s ריצה %-7s %-12s %s%s\n' \
        "$hh" "$(human "$th")" "$(human "$run")" "$tool" "$sum" "$flag"
    done < "$LOG"
    echo "────────────────────────────────────────────────────────────"
    printf 'סה"כ %d פעולות · ~%s wall-clock.\n' "$n" "$(human "$total")"
    echo
    echo "הצעדים הכי איטיים (חשיבה+ריצה):"
    awk -F'\t' '{d=$3+$4; print d"\t"$2"\t"$5"\t"$6}' "$LOG" \
      | sort -rn | head -3 | while IFS=$'\t' read -r d hh tool sum; do
        printf '  %-7s %s  %-12s %s\n' "$(human "$d")" "$hh" "$tool" "$sum"
      done
    ;;
esac
exit 0
