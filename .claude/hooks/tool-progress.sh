#!/usr/bin/env bash
#
# PostToolUse (all tools) — the tool-progress visibility timeline.
#
# WHY: on Claude Code web the UI collapses a long run into an opaque counter
# ("33 actions, 5 tools"). You can't tell whether the wall-clock went into a slow
# `npm install`, heavy model thinking over a big context, or a stuck loop. This
# hook appends ONE line per tool call to a per-session timeline so the run
# becomes readable after the fact via `.claude/hooks/progress.sh show`.
#
# Each line records (TSV): epoch, HH:MM:SS in New York time (per CLAUDE.md),
# "think" seconds (model/queue time since the previous tool ended), "run"
# seconds (this tool's own execution time, from the PreToolUse start-stamp),
# the tool name, and a short summary of the input.
#
# Pure-local: writes only to the gitignored .claude/tmp/. No network, no paid
# tokens. Emits NOTHING on stdout (PostToolUse stdout would be fed back to the
# model — we stay silent) and always exits 0. Missing jq / any error → no-op.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
SLUG="local"
if [ -n "$REMOTE" ]; then
  case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac
fi

mkdir -p .claude/tmp 2>/dev/null || exit 0

LOG=".claude/tmp/progress-${SLUG}.log"
LATEST=".claude/tmp/progress-${SLUG}.latest"
PREV=".claude/tmp/progress-${SLUG}.prevend"

payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

tool="$(printf '%s' "$payload" | jq -r '.tool_name // "?"' 2>/dev/null || echo '?')"

tuid="$(printf '%s' "$payload" | jq -r '.tool_use_id // ""' 2>/dev/null || true)"
[ -n "$tuid" ] || tuid="_single"
tuid="$(printf '%s' "$tuid" | tr -c 'A-Za-z0-9_.-' '_')"

# Best single-field summary of what the tool was asked to do.
summary="$(printf '%s' "$payload" | jq -r '
  (.tool_input.command
   // .tool_input.file_path
   // .tool_input.pattern
   // .tool_input.description
   // .tool_input.query
   // .tool_input.prompt
   // "")
  | gsub("[\n\r\t]+"; " ") | .[0:72]' 2>/dev/null || true)"

now="$(date -u +%s)"

# run = this tool's own execution time (now - its PreToolUse start-stamp).
STARTF=".claude/tmp/progress-${SLUG}.start.${tuid}"
run=0
if [ -f "$STARTF" ]; then
  s="$(cat "$STARTF" 2>/dev/null || echo "$now")"
  case "$s" in ''|*[!0-9]*) s="$now";; esac
  run=$(( now - s ))
  rm -f "$STARTF" 2>/dev/null || true
fi
[ "$run" -lt 0 ] && run=0

# think = time between the previous tool ending and this tool starting
# (approximates model reasoning + queue time — the cost that balloons on a big
# context). start-of-this-tool ~= now - run.
think=0
if [ -f "$PREV" ]; then
  p="$(cat "$PREV" 2>/dev/null || echo "$now")"
  case "$p" in ''|*[!0-9]*) p="$now";; esac
  startstamp=$(( now - run ))
  think=$(( startstamp - p ))
fi
[ "$think" -lt 0 ] && think=0
printf '%s' "$now" > "$PREV" 2>/dev/null || true

hhmmss="$(TZ='America/New_York' date -d "@$now" +%H:%M:%S 2>/dev/null || date +%H:%M:%S)"

printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$hhmmss" "$think" "$run" "$tool" "$summary" >> "$LOG" 2>/dev/null || true
printf 'אחרון: %s "%s" — %s ניו יורק · ריצה %ss (חשיבה %ss לפני)\n' \
  "$tool" "$summary" "$hhmmss" "$run" "$think" > "$LATEST" 2>/dev/null || true

exit 0
