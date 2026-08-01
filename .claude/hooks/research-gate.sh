#!/usr/bin/env bash
# PreToolUse hook (matcher: WebSearch|WebFetch|Bash) — hard enforcement of phase 1
# of the two-phase research protocol (CLAUDE.md rule 12).
#
# Bash is in the matcher because `curl https://example.com/...` is research too,
# and a gate that only sees WebSearch/WebFetch is walked around by one shell call.
# Since the matcher cannot express "curl only", the tool routing lives here:
# WebSearch / WebFetch always count; Bash counts only for curl|wget against an
# external http(s) URL; every other tool exits immediately, so ordinary Bash never
# spends the research budget. Production/internal traffic is not research and is
# never gated (agent proxy / localhost / our backend / our Supabase project /
# app.smrtesy.com / *.up.railway.app) — plan import, task reports and DB reads all
# hit these; genuine external documentation reads stay gated under a plan.
#
# NOT every search is research. The gate's logic:
#   1. A *filled* research plan is open (.claude/research/active.json)  → allow.
#   2. No plan: every session gets a FREE budget of a few web calls
#      (default 10, override RESEARCH_GATE_FREE) for casual lookups —
#      link checks, help answers, one-off verifications              → allow.
#      The counter is keyed on the hook payload's session_id, and a SUBAGENT
#      reports the SAME session_id as the main thread (measured 7/2026; the
#      field that distinguishes them is agent_id). So the budget is ONE POOL
#      shared by the main thread and every subagent. That is deliberate:
#      research fanned out to subagents is still research, and a per-agent
#      pool would let a sweep evade the gate just by delegating. The default
#      was raised 5 -> 10 because a shared pool of 5 breaks under Opus 5's
#      readier delegation (3 agents x 2 lookups + main thread = 7), which
#      would fire the gate on legitimate work until `waive` became routine —
#      i.e. the gate dies quietly. 10 keeps the shared pool without that.
#   3. Beyond the free budget with no plan — that's a research-shaped
#      pattern. Deny, with instructions: research.sh start (real research)
#      or research.sh waive "<reason>" (logged, grants a few more calls).
#
# Fails OPEN (exit 0 = allow) on any error / missing jq — never breaks a turn.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

# Anchored on the project root (see research.sh) so the gate and the plan can
# never disagree about where the plan lives.
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
DIR="$ROOT/.claude/research"
PLAN="$DIR/active.json"
WAIVER="$DIR/waiver.count"
WLOG="$DIR/waivers.log"
FREE_LIMIT="${RESEARCH_GATE_FREE:-10}"
case "$FREE_LIMIT" in ''|*[!0-9]*) FREE_LIMIT=10;; esac
mkdir -p "$DIR" 2>/dev/null || true

INPUT="$(cat 2>/dev/null || true)"

# --- tool routing: what counts as a research call at all ---
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")"
case "$TOOL" in
  WebSearch|WebFetch) ;;
  Bash)
    CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")"
    [ -n "$CMD" ] || exit 0
    printf '%s' "$CMD" | grep -Eq '(^|[^[:alnum:]_/-])(curl|wget)([^[:alnum:]_-]|$)' || exit 0
    printf '%s' "$CMD" | grep -Eq 'https?://' || exit 0
    # Production/internal traffic is NOT research: agent proxy, localhost, our
    # backend, and our Supabase project (REST/auth) — plan import, task reports,
    # DB reads all hit these and must never spend the research budget.
    printf '%s' "$CMD" | grep -Eq '__agentproxy|localhost|127\.0\.0\.1|HTTPS_PROXY|SMRTESY_BACKEND_URL|SUPABASE_URL|\.supabase\.co|app\.smrtesy\.com|\.up\.railway\.app' && exit 0
    ;;
  "") ;;                                  # no tool_name in the payload → treat as a web call
  *) exit 0 ;;                             # any other tool never spends the budget
esac

SESSION="$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")"
[ -z "$SESSION" ] && SESSION="${CLAUDE_CODE_REMOTE_SESSION_ID:-local}"
SESSION="$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-64)"
FREE_COUNT_FILE="$DIR/free-${SESSION}.count"

# 1) A filled, open research plan → the search is part of the research. Allow.
plan_is_open_and_filled() {
  [ -f "$PLAN" ] || return 1
  jq empty "$PLAN" 2>/dev/null || return 1
  [ "$(jq -r '.status // ""' "$PLAN" 2>/dev/null)" = "open" ] || return 1
  for f in decision consumer output_path stop_condition; do
    v="$(jq -r ".$f // \"\"" "$PLAN" 2>/dev/null)"
    case "$v" in ""|*TODO*) return 1;; esac
  done
  qn="$(jq -r '.questions | length' "$PLAN" 2>/dev/null || echo 0)"
  [ "${qn:-0}" -ge 1 ] 2>/dev/null || return 1
  nbad="$(jq -r '[.questions[]? | select((.q // "" | . == "" or contains("TODO")) or (.source // "" | . == "" or contains("TODO")))] | length' "$PLAN" 2>/dev/null || echo 1)"
  [ "${nbad:-1}" -eq 0 ] 2>/dev/null || return 1
  return 0
}
if plan_is_open_and_filled; then exit 0; fi

# Scaffolded-but-unfilled plan → the agent started phase 1 and tried to search
# before finishing it. Block with a precise "finish the plan" message.
if [ -f "$PLAN" ] && [ "$(jq -r '.status // ""' "$PLAN" 2>/dev/null)" = "open" ]; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",
    permissionDecisionReason:"פרוטוקול המחקר: קיימת תוכנית-מחקר פתוחה אבל היא לא מלאה (שדות TODO). השלם את כל השדות ב-.claude/research/active.json, הרץ .claude/hooks/research.sh check, ורק אז חפש. (שלב 1 לפני שלב 2 — CLAUDE.md כלל 12.)"}}'
  exit 0
fi

# 2) Waiver granted earlier → consume one and allow.
if [ -f "$WAIVER" ]; then
  W="$(cat "$WAIVER" 2>/dev/null || echo 0)"
  case "$W" in ''|*[!0-9]*) W=0;; esac
  if [ "$W" -gt 0 ] 2>/dev/null; then
    echo $((W - 1)) > "$WAIVER" 2>/dev/null || true
    exit 0
  fi
fi

# 3) Free per-session budget for casual, non-research lookups.
C="$(cat "$FREE_COUNT_FILE" 2>/dev/null || echo 0)"
case "$C" in ''|*[!0-9]*) C=0;; esac
if [ "$C" -lt "$FREE_LIMIT" ] 2>/dev/null; then
  echo $((C + 1)) > "$FREE_COUNT_FILE" 2>/dev/null || true
  exit 0
fi

# 4) Research-shaped usage with no plan → deny with instructions.
jq -n --arg free "$FREE_LIMIT" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",
  permissionDecisionReason:("פרוטוקול המחקר (CLAUDE.md כלל 12): חצית את מכסת " + $free + " קריאות-הרשת החופשיות של הסשן בלי תוכנית-מחקר — זה דפוס של מחקר. שתי אפשרויות: (א) אם זה מחקר — הרץ .claude/hooks/research.sh start \"<slug>\", מלא את .claude/research/active.json (ההחלטה, הצרכן, שאלות סגורות + מקור מוסמך לכל אחת, מה לא חוקרים, נתיב-התוצר ממפת התוצרים ב-docs/pipeline.md, תנאי עצירה), הרץ check — והחיפושים ייפתחו. (ב) אם אלו באמת בדיקות חד-פעמיות שאינן מחקר — הרץ .claude/hooks/research.sh waive \"<סיבה>\" [n] (נרשם ללוג גלוי).")}}'
exit 0
