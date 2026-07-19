#!/usr/bin/env bash
#
# PreToolUse cost guard.
#
# Forces an explicit "ask" confirmation before any Bash command that would spend
# PAID API / LLM tokens billed to the user. Enforces the CLAUDE.md rule
# "Cost approval — explicit, up-front, non-negotiable": the agent's own work runs
# on the user's Claude subscription (free), but shelling out to a paid endpoint
# (Anthropic / Voyage / Google GenAI APIs, or the server-side batch extractor)
# costs real money and must be approved with its cost stated first.
#
# Reads the PreToolUse hook JSON on stdin. If the Bash command contains a cost
# marker, emits a permissionDecision:"ask"; otherwise stays silent and lets the
# normal permission flow proceed. Guarded so it can never hard-fail a turn.

set -euo pipefail

# jq is required to parse the hook payload; without it, fail open (no-op).
command -v jq >/dev/null 2>&1 || exit 0

payload="$(cat 2>/dev/null || true)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# Substrings that mean the command hits a paid, token-metered endpoint.
markers=(
  "info/extract/batch"
  "api.anthropic.com"
  "api.voyageai.com"
  "generativelanguage.googleapis.com"
  "/api/quick-action"
)

for m in "${markers[@]}"; do
  case "$cmd" in
    *"$m"*)
      jq -cn '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "פעולה זו מפעילה טוקנים בתשלום (API/LLM) שמחויבים אליך — יש לאשר את העלות מראש (ראה CLAUDE.md, סעיף \"Cost approval\")."
        }
      }'
      exit 0
      ;;
  esac
done

# No cost marker — let the normal permission flow handle it.
exit 0
