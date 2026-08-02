#!/usr/bin/env bash
#
# PreToolUse (all tools) — start-stamp for the tool-progress visibility timeline.
#
# Records the start epoch of each tool call so the PostToolUse logger
# (tool-progress.sh) can report each tool's OWN execution time, separately from
# the model "think" time that elapsed before it. Keyed by tool_use_id so
# parallel tool calls don't clobber each other's start time.
#
# Pure-local: writes only to the gitignored .claude/tmp/. No network, no paid
# tokens. Emits NOTHING on stdout and always exits 0 — it can never block,
# delay, or influence a tool call. Missing jq / any error → silent no-op.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
SLUG="local"
if [ -n "$REMOTE" ]; then
  case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac
fi

mkdir -p .claude/tmp 2>/dev/null || exit 0

payload="$(cat 2>/dev/null || true)"
tuid="$(printf '%s' "$payload" | jq -r '.tool_use_id // ""' 2>/dev/null || true)"
[ -n "$tuid" ] || tuid="_single"
tuid="$(printf '%s' "$tuid" | tr -c 'A-Za-z0-9_.-' '_')"

printf '%s' "$(date -u +%s)" > ".claude/tmp/progress-${SLUG}.start.${tuid}" 2>/dev/null || true
exit 0
