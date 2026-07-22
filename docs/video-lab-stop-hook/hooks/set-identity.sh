#!/usr/bin/env bash
# Records the human's answer to "what is your smrtTask email?" for a SHARED
# Claude Code account. Caches it for TODAY (New-York day) in the backend so later
# sessions that day skip the question, and writes a local session file so THIS
# session's Stop hook routes the report as that worker.
#
# Usage:  .claude/hooks/set-identity.sh <smrttask-email>
#
# Guarded no-op (exit 0) when not a web session / not provisioned, so it can never
# fail a turn. See docs/user-routing-stop-hook-plan.md.
set -uo pipefail

EMAIL="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[ -z "$EMAIL" ] && { echo "set-identity: no email given — usage: set-identity.sh <email>"; exit 0; }
case "$EMAIL" in *@*.*) ;; *) echo "set-identity: '$EMAIL' does not look like an email — skipped"; exit 0 ;; esac

command -v curl >/dev/null 2>&1 || { echo "set-identity: curl missing — skipped"; exit 0; }
command -v jq   >/dev/null 2>&1 || { echo "set-identity: jq missing — skipped"; exit 0; }

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
[ -z "$REMOTE" ] && { echo "set-identity: not a web session — skipped"; exit 0; }
case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac

# Always write the local session file — this makes the Stop hook route correctly
# even if the backend cache POST fails.
mkdir -p .claude/tmp 2>/dev/null || true
echo "$EMAIL" > ".claude/tmp/claude-identity-${SLUG}.txt" 2>/dev/null || true

# Cache in the backend for the rest of the NY day (best-effort).
SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  BASE="${SMRTESY_BACKEND_URL%/}"
elif [ -n "${SMRTTASK_PROPOSAL_URL:-}" ]; then
  BASE="${SMRTTASK_PROPOSAL_URL%/}"; BASE="${BASE%/api/claude-session/proposal}"
else
  BASE=""
fi
case "$BASE" in ""|http://*|https://*) ;; *) BASE="https://$BASE" ;; esac

CLAUDE_ACCOUNT="$(printf '%s' "${CLAUDE_CODE_USER_EMAIL:-}" | tr '[:upper:]' '[:lower:]')"
if [ -n "$SECRET" ] && [ -n "$BASE" ] && [ -n "$CLAUDE_ACCOUNT" ]; then
  BODY="$(jq -n --arg claude_account "$CLAUDE_ACCOUNT" --arg worker_email "$EMAIL" \
    '{claude_account:$claude_account, worker_email:$worker_email}')"
  RESP="$(curl -sS -m 20 -L --post301 --post302 -X POST "$BASE/api/claude-session/identity" \
    -H "Content-Type: application/json" -H "X-Cron-Secret: $SECRET" \
    --data-binary "$BODY" 2>&1 || true)"
  echo "set-identity: cached $EMAIL for today → ${RESP:-<no response>}"
else
  echo "set-identity: recorded $EMAIL locally (backend cache not provisioned)"
fi
exit 0
