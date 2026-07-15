#!/usr/bin/env bash
# Stop hook — files a smrtTask "הצעה" summarizing this Claude Code chat.
# See CLAUDE.md → "smrtTask session proposals (Stop hook)".
#
# Fully guarded + fire-and-forget: any missing env var / tool, or any error,
# makes it exit 0 silently so it can NEVER block, delay, or fail a turn.
#
# Required env in the Claude Code environment (copy the values from the backend):
#   the shared secret — ONE of:
#     CRON_SECRET  or  SMRTBOT_INTERNAL_SECRET   (backend accepts either)
#   the backend base URL — ONE of:
#     SMRTESY_BACKEND_URL  or  SMRTTASK_PROPOSAL_URL (full endpoint)
#     (SMRTESY_BACKEND_URL = the backend's SMRTESY_PUBLIC_URL / the app's
#      NEXT_PUBLIC_BACKEND_URL, e.g. https://<app>.up.railway.app)
#
# The endpoint lives on the Express backend (Railway), NOT on the Next.js app at
# app.smrtesy.com. No baked-in default on purpose — a wrong host silently 404s.
set -uo pipefail

SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"

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
