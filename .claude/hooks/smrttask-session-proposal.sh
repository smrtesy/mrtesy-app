#!/usr/bin/env bash
# Stop hook — files a smrtTask "הצעה" summarizing this Claude Code chat.
# See CLAUDE.md → "smrtTask session proposals (Stop hook)".
#
# Fully guarded + fire-and-forget: any missing env var / tool, or any error,
# makes it exit 0 silently so it can NEVER block, delay, or fail a turn.
#
# Required env (set these in the Claude Code environment):
#   CRON_SECRET             shared secret, identical to the backend's CRON_SECRET
#   and ONE of the endpoint locators:
#     SMRTTASK_PROPOSAL_URL   full endpoint URL, OR
#     SMRTESY_BACKEND_URL     the Express backend base (same value as the app's
#                             NEXT_PUBLIC_BACKEND_URL, e.g. https://<app>.up.railway.app)
#
# NOTE: the endpoint lives on the Express backend (Railway), NOT on the Next.js
# app at app.smrtesy.com — that host has no /api/claude-session route. There is
# deliberately no baked-in default: a wrong host would silently 404 every turn.
set -uo pipefail

SECRET="${CRON_SECRET:-}"
if [ -n "${SMRTTASK_PROPOSAL_URL:-}" ]; then
  URL="$SMRTTASK_PROPOSAL_URL"
elif [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  URL="${SMRTESY_BACKEND_URL%/}/api/claude-session/proposal"
else
  URL=""
fi

# Not provisioned in this environment → do nothing, quietly.
[ -z "$SECRET" ] && exit 0
[ -z "$URL" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT="$(cat)"
PAYLOAD="$(printf '%s' "$INPUT" | node "$HOOK_DIR/build-session-proposal.mjs" 2>/dev/null || true)"
[ -z "$PAYLOAD" ] && exit 0

# Fire-and-forget: detach so the network round-trip never delays the user.
( curl -sS -m 20 -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "X-Cron-Secret: $SECRET" \
    --data-binary "$PAYLOAD" >/dev/null 2>&1 || true ) &

exit 0
