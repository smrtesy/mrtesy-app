#!/bin/bash
# SessionStart hook. Two jobs:
#   1. Install npm deps so `npm run build`/lint and the pre-push protocol are
#      ready immediately (output → stderr so stdout stays clean for the context
#      JSON below).
#   2. Per-user routing: for a SHARED (non-manager) Claude Code account, inject an
#      instruction so the agent asks "what is your smrtTask email?" ONCE PER
#      New-York DAY (cached in the backend). The manager account is exempt.
#      See docs/user-routing-stop-hook-plan.md.
#
# Guarded: not a web session / missing tools / not provisioned → deps still
# install, identity injection is simply skipped. Never fails the turn.
set -uo pipefail

# Web/remote sessions only — never run installs on a local dev machine.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# stdout must stay clean for the SessionStart additionalContext JSON, so send all
# install output to stderr.
npm install --no-audit --no-fund 1>&2 2>/dev/null || true

# ---- per-user routing: inject the identity question when needed ----
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

emit_context() {
  jq -cn --arg c "$1" \
    '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$c}}' 2>/dev/null || true
}

SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  BASE="${SMRTESY_BACKEND_URL%/}"
elif [ -n "${SMRTTASK_PROPOSAL_URL:-}" ]; then
  BASE="${SMRTTASK_PROPOSAL_URL%/}"; BASE="${BASE%/api/claude-session/proposal}"
else
  BASE=""
fi
case "$BASE" in ""|http://*|https://*) ;; *) BASE="https://$BASE" ;; esac
[ -z "$SECRET" ] && exit 0
[ -z "$BASE" ] && exit 0

CLAUDE_LOGIN="$(lower "${CLAUDE_CODE_USER_EMAIL:-}")"
[ -z "$CLAUDE_LOGIN" ] && exit 0
MANAGER_CLAUDE_EMAIL="$(lower "${SMRTTASK_MANAGER_CLAUDE_EMAIL:-}")"

# Per-user routing is OFF until a manager is configured. With no manager set we
# must NOT prompt every account for identity (that would disrupt all sessions on
# merge) — behave exactly as before (the Stop hook still files a plain proposal).
[ -z "$MANAGER_CLAUDE_EMAIL" ] && exit 0

# Manager account → no identity question (we know who it is).
if [ "$CLAUDE_LOGIN" = "$MANAGER_CLAUDE_EMAIL" ]; then
  exit 0
fi

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac

# Already identified today? (backend cache) → record locally, tell the agent.
ENC_ACCOUNT="$(printf '%s' "$CLAUDE_LOGIN" | jq -sRr @uri)"
WORKER="$(curl -sS -m 15 -L "$BASE/api/claude-session/identity?claude_account=$ENC_ACCOUNT" \
  -H "X-Cron-Secret: $SECRET" 2>/dev/null | jq -r '.worker_email // ""' 2>/dev/null || echo "")"

if [ -n "$WORKER" ] && [ "$WORKER" != "null" ]; then
  mkdir -p .claude/tmp 2>/dev/null || true
  [ -n "$SLUG" ] && echo "$WORKER" > ".claude/tmp/claude-identity-${SLUG}.txt" 2>/dev/null || true
  emit_context "זיהוי המשתמש להיום כבר ידוע: ${WORKER}. אין צורך לשאול שוב היום. דיווח הסשן ייוחס לעובד זה אוטומטית — המשך כרגיל בבקשת המשתמש."
  exit 0
fi

# Not identified yet today → present the saved list and ask.
MANAGER_SMRTTASK_EMAIL="${SMRTTASK_MANAGER_EMAIL:-${SMRTTASK_USER_EMAIL:-}}"
LIST=""
if [ -n "$MANAGER_SMRTTASK_EMAIL" ]; then
  ENC_MGR="$(printf '%s' "$MANAGER_SMRTTASK_EMAIL" | jq -sRr @uri)"
  LIST="$(curl -sS -m 15 -L "$BASE/api/claude-session/known-workers?manager_email=$ENC_MGR" \
    -H "X-Cron-Secret: $SECRET" 2>/dev/null \
    | jq -r '.workers // [] | to_entries | map("\(.key+1). \(.value.email)") | .[]' 2>/dev/null || echo "")"
fi

ASK="לפני כל דבר אחר בסשן הזה: זהה מי המשתמש. שאל אותו בשפה שבה כתב (עברית או אנגלית): \"מה האימייל שלך ב-smrtTask?\"."
if [ -n "$LIST" ]; then
  ASK="$ASK"$'\n'"בחר מהרשימה (מספר) או הקלד אימייל חדש:"$'\n'"$LIST"
else
  ASK="$ASK"$'\n'"(אין עדיין רשימה שמורה — בקש שיקליד את האימייל.)"
fi
ASK="$ASK"$'\n'"כשהמשתמש עונה, הרץ פעם אחת בדיוק: .claude/hooks/set-identity.sh <email> — ואז המשך לטפל בבקשה שלו. אל תדלג על השאלה הזו."

emit_context "$ASK"
exit 0
