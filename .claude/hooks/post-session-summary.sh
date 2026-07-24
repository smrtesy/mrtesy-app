#!/usr/bin/env bash
# Agent-run helper that files the session report, ROUTED by who ran the chat.
# The summary is written by the Claude Code agent (on the user's Claude
# subscription) — ZERO paid API tokens. See docs/user-routing-stop-hook-plan.md.
#
# Usage (either form):
#   post-session-summary.sh "<topic>" "<summary>" "<next_step>" ["<status>"]
#   post-session-summary.sh --json <path>   # {topic,summary,next_step,status}
#     status ∈ in_progress|blocked|done  (default in_progress; used only when a
#     task-report attaches to an in-progress task)
#
# Routing (by CLAUDE_CODE_USER_EMAIL + the per-day identity):
#   • MANAGER account  → "combination": try task-report; if nothing was in
#                        progress (attached:false) fall back to a proposal.
#   • WORKER (identified) → task-report as the worker (the backend also files a
#                        deduped proposal to the plan manager).
#   • FALLBACK (non-manager, not yet identified today) → a plain proposal under
#                        the account's own resolution — never lose a trace.
#
# Silent, guarded no-op (exit 0) when not provisioned. Prints each endpoint
# response so the agent can confirm "ok":true.
set -uo pipefail

command -v curl >/dev/null 2>&1 || { echo "post-summary: curl missing — skipped"; exit 0; }
command -v jq   >/dev/null 2>&1 || { echo "post-summary: jq missing — skipped"; exit 0; }

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

# ---- endpoint base + secret ----
SECRET="${CRON_SECRET:-${SMRTBOT_INTERNAL_SECRET:-}}"
if [ -n "${SMRTESY_BACKEND_URL:-}" ]; then
  BASE="${SMRTESY_BACKEND_URL%/}"
elif [ -n "${SMRTTASK_PROPOSAL_URL:-}" ]; then
  BASE="${SMRTTASK_PROPOSAL_URL%/}"; BASE="${BASE%/api/claude-session/proposal}"
else
  BASE=""
fi
case "$BASE" in ""|http://*|https://*) ;; *) BASE="https://$BASE" ;; esac
[ -z "$SECRET" ] && { echo "post-summary: no secret env — skipped"; exit 0; }
[ -z "$BASE" ]   && { echo "post-summary: no backend URL env — skipped"; exit 0; }
PROPOSAL_URL="$BASE/api/claude-session/proposal"
TASKREPORT_URL="$BASE/api/claude-session/task-report"
IDENTITY_URL="$BASE/api/claude-session/identity"

# ---- gather topic / summary / next_step / status ----
TOPIC=""; SUMMARY=""; NEXT_STEP=""; STATUS="in_progress"
if [ "${1:-}" = "--json" ]; then
  F="${2:-}"; [ -f "$F" ] || { echo "post-summary: json file not found: $F — skipped"; exit 0; }
  TOPIC="$(jq -r '.topic // ""' "$F" 2>/dev/null || echo "")"
  SUMMARY="$(jq -r '.summary // ""' "$F" 2>/dev/null || echo "")"
  NEXT_STEP="$(jq -r '.next_step // ""' "$F" 2>/dev/null || echo "")"
  S="$(jq -r '.status // ""' "$F" 2>/dev/null || echo "")"; [ -n "$S" ] && STATUS="$S"
else
  TOPIC="${1:-}"; SUMMARY="${2:-}"; NEXT_STEP="${3:-}"
  [ -n "${4:-}" ] && STATUS="$4"
fi
case "$STATUS" in in_progress|blocked|done) ;; *) STATUS="in_progress" ;; esac
if [ -z "$TOPIC" ] && [ -z "$SUMMARY" ]; then
  echo "post-summary: nothing to post (empty topic+summary) — skipped"; exit 0
fi

# ---- session identity ----
REMOTE="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
[ -z "$REMOTE" ] && { echo "post-summary: no CLAUDE_CODE_REMOTE_SESSION_ID — skipped"; exit 0; }
case "$REMOTE" in cse_*) SLUG="${REMOTE#cse_}";; *) SLUG="$REMOTE";; esac
SESSION_ID="$REMOTE"
SESSION_URL=""; [ -n "$SLUG" ] && SESSION_URL="https://claude.ai/code/session_${SLUG}"

# repo (from git remote — portable) + branch
REPO=""; ORIGIN_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
if [ -n "$ORIGIN_URL" ]; then REPO="${ORIGIN_URL##*/}"; REPO="${REPO%.git}"; fi
[ -z "$REPO" ] && REPO="${PWD##*/}"; [ -z "$REPO" ] && REPO="repo"
BRANCH=""
if [ -f .git/HEAD ]; then
  HC="$(cat .git/HEAD 2>/dev/null || true)"; case "$HC" in ref:*) BRANCH="${HC##*/}";; esac
fi

# Claude account that ran the chat (shown on the proposal)
CLAUDE_EMAIL="${CLAUDE_CODE_USER_EMAIL:-}"
CLAUDE_NAME=""; [ -n "$CLAUDE_EMAIL" ] && CLAUDE_NAME="${CLAUDE_EMAIL%%@*}"

# ---- decide the role + resolution identity ----
MANAGER_CLAUDE_EMAIL="$(lower "${SMRTTASK_MANAGER_CLAUDE_EMAIL:-}")"
MANAGER_SMRTTASK_EMAIL="${SMRTTASK_MANAGER_EMAIL:-${SMRTTASK_USER_EMAIL:-}}"
CLAUDE_LOGIN="$(lower "$CLAUDE_EMAIL")"

ROLE="fallback"
RESOLVE_ID="${SMRTTASK_USER_ID:-}"
RESOLVE_EMAIL="${SMRTTASK_USER_EMAIL:-$CLAUDE_EMAIL}"

if [ -z "$MANAGER_CLAUDE_EMAIL" ]; then
  # Per-user routing OFF (no manager configured) → behave exactly as before:
  # a plain proposal under the account's own resolution. No identity lookup.
  ROLE="fallback"
elif [ "$CLAUDE_LOGIN" = "$MANAGER_CLAUDE_EMAIL" ]; then
  ROLE="manager"
  RESOLVE_ID="${SMRTTASK_MANAGER_USER_ID:-${SMRTTASK_USER_ID:-}}"
  RESOLVE_EMAIL="$MANAGER_SMRTTASK_EMAIL"
else
  # Worker identity for today: local session file first, then the backend cache.
  WORKER=""
  IDFILE=".claude/tmp/claude-identity-${SLUG}.txt"
  [ -f "$IDFILE" ] && WORKER="$(tr -d '[:space:]' < "$IDFILE" 2>/dev/null || true)"
  if [ -z "$WORKER" ] && [ -n "$CLAUDE_EMAIL" ]; then
    WORKER="$(curl -sS -m 15 -L "$IDENTITY_URL?claude_account=$(printf '%s' "$CLAUDE_LOGIN" | jq -sRr @uri)" \
      -H "X-Cron-Secret: $SECRET" 2>/dev/null | jq -r '.worker_email // ""' 2>/dev/null || echo "")"
  fi
  if [ -n "$WORKER" ] && [ "$WORKER" != "null" ]; then
    ROLE="worker"; RESOLVE_ID=""; RESOLVE_EMAIL="$WORKER"
  fi
fi

# ---- helpers to POST each endpoint ----
post_task_report() {
  local body
  body="$(jq -n \
    --arg session_id "$SESSION_ID" --arg session_url "$SESSION_URL" \
    --arg user_id "$RESOLVE_ID" --arg user_email "$RESOLVE_EMAIL" \
    --arg claude_user_email "$CLAUDE_EMAIL" --arg claude_user_name "$CLAUDE_NAME" \
    --arg summary "$SUMMARY" --arg status "$STATUS" \
    '{session_id:$session_id, session_url:$session_url, user_id:$user_id, user_email:$user_email, claude_user_email:$claude_user_email, claude_user_name:$claude_user_name, summary:$summary, status:$status}')"
  curl -sS -m 20 -L --post301 --post302 -X POST "$TASKREPORT_URL" \
    -H "Content-Type: application/json" -H "X-Cron-Secret: $SECRET" \
    --data-binary "$body" 2>&1 || true
}
post_proposal() {
  local body
  body="$(jq -n \
    --arg session_id "$SESSION_ID" --arg session_url "$SESSION_URL" \
    --arg user_id "$RESOLVE_ID" --arg user_email "$RESOLVE_EMAIL" \
    --arg claude_user_email "$CLAUDE_EMAIL" --arg claude_user_name "$CLAUDE_NAME" \
    --arg repo "$REPO" --arg git_branch "$BRANCH" \
    --arg topic "$TOPIC" --arg summary "$SUMMARY" --arg next_step "$NEXT_STEP" \
    '{session_id:$session_id, session_url:$session_url, user_id:$user_id, user_email:$user_email, claude_user_email:$claude_user_email, claude_user_name:$claude_user_name, repo:$repo, git_branch:$git_branch, topic:$topic, summary:$summary, next_step:$next_step}')"
  curl -sS -m 20 -L --post301 --post302 -X POST "$PROPOSAL_URL" \
    -H "Content-Type: application/json" -H "X-Cron-Secret: $SECRET" \
    --data-binary "$body" 2>&1 || true
}

# ---- route ----
case "$ROLE" in
  manager|worker)
    RESP="$(post_task_report)"
    echo "post-summary [$ROLE] task-report → ${RESP:-<no response>}"
    # No in-progress task to attach to → fall back to a proposal so the session
    # still leaves a trace (manager: own inbox; worker: own inbox).
    # NOTE: jq's // treats false as absent — 'attached // empty' returned "" for
    # attached:false, silently skipping the proposal fallback (bug found 2026-07-24).
    ATTACHED="$(printf '%s' "$RESP" | jq -r 'if has("attached") then (.attached|tostring) else "" end' 2>/dev/null || echo "")"
    if [ "$ATTACHED" = "false" ]; then
      RESP2="$(post_proposal)"
      echo "post-summary [$ROLE] no in-progress task → proposal → ${RESP2:-<no response>}"
    fi
    ;;
  *)
    RESP="$(post_proposal)"
    echo "post-summary [fallback] proposal → ${RESP:-<no response>}"
    ;;
esac
exit 0
