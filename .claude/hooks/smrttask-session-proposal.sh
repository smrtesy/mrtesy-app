#!/usr/bin/env bash
# Stop hook — files a smrtTask "הצעה" summarizing this Claude Code chat.
# See CLAUDE.md → "smrtTask session proposals (Stop hook)".
#
# Fully guarded + fire-and-forget: any missing env var / tool, or any error,
# makes it exit 0 silently so it can NEVER block, delay, or fail a turn.
#
# Required env (set these in the Claude Code environment):
#   CRON_SECRET             shared secret, identical to the backend's CRON_SECRET
# Optional env:
#   SMRTTASK_PROPOSAL_URL   endpoint (default: https://app.smrtesy.com/api/claude-session/proposal)
set -uo pipefail

URL="${SMRTTASK_PROPOSAL_URL:-https://app.smrtesy.com/api/claude-session/proposal}"
SECRET="${CRON_SECRET:-}"

# No secret → feature not provisioned in this environment. Do nothing, quietly.
[ -z "$SECRET" ] && exit 0
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
