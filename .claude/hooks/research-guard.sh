#!/usr/bin/env bash
# Stop hook — hard enforcement of phase 3 (closure) of the two-phase research
# protocol (CLAUDE.md rule 12).
#
# If a research plan is OPEN when the turn tries to end, block (at most 3x per
# research, then give up gracefully like longtask-guard) and instruct the agent
# to close properly: every question answered/empirical, the deliverable exists
# at its contract path, the consumer check passed — then `research.sh close`
# (which validates all of that mechanically), or `research.sh abandon` with the
# user's explicit say-so.
#
# Absolute no-op when no research plan is open (the normal case). Coexists with
# the other Stop hooks (own counter, independent of stop_hook_active semantics).
# Any error / missing jq → exit 0.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

# Anchored on the project root (see research.sh).
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
DIR="$ROOT/.claude/research"
PLAN="$DIR/active.json"
COUNTER="$DIR/guard.count"

# Normal case: no open research → zero overhead.
[ -f "$PLAN" ] || exit 0
jq empty "$PLAN" 2>/dev/null || exit 0
[ "$(jq -r '.status // ""' "$PLAN" 2>/dev/null)" = "open" ] || exit 0

INPUT="$(cat 2>/dev/null || true)"
# Loop guard: when the harness re-runs the hook after we already blocked in
# this turn-cycle, do not block again.
ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"
[ "$ACTIVE" = "true" ] && exit 0

C="$(cat "$COUNTER" 2>/dev/null || echo 0)"
case "$C" in ''|*[!0-9]*) C=0;; esac
if [ "$C" -ge 3 ] 2>/dev/null; then
  # Nagged enough — degrade gracefully rather than trapping the session.
  exit 0
fi
echo $((C + 1)) > "$COUNTER" 2>/dev/null || true

SLUG="$(jq -r '.slug // "research"' "$PLAN" 2>/dev/null)"
OPENQ="$(jq -r '[.questions[]? | select(.status=="open")] | length' "$PLAN" 2>/dev/null || echo "?")"
OUTP="$(jq -r '.output_path // ""' "$PLAN" 2>/dev/null)"
CC="$(jq -r '.consumer_check // "pending"' "$PLAN" 2>/dev/null)"

jq -n --arg slug "$SLUG" --arg openq "$OPENQ" --arg outp "$OUTP" --arg cc "$CC" \
  '{decision:"block",
    reason:("יש מחקר פתוח (\"" + $slug + "\") שלא נסגר כדין — פרוטוקול המחקר, שלב 3 (CLAUDE.md כלל 12). מצב: " + $openq + " שאלות פתוחות; תוצר בנתיב-החוזה: " + (if $outp == "" then "לא הוגדר" else $outp end) + "; בדיקת-צרכן: " + $cc + ". לפני סיום: (1) סמן כל שאלה answered/empirical — .claude/hooks/research.sh answer <i> <status>; (2) ודא שהתוצר קיים בדיוק בנתיב-החוזה; (3) בצע בדיקת-צרכן והרץ consumer-pass; (4) הרץ .claude/hooks/research.sh close — הוא מאמת הכל מכנית. אם המשתמש הורה במפורש לעצור את המחקר — .claude/hooks/research.sh abandon \"<סיבה>\" ודווח לו.")}'
exit 0
