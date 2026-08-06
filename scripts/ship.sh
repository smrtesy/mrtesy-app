#!/usr/bin/env bash
#
# ship.sh — the single shipping path for a finished console-run change.
#
# A console run works on a feature branch. When the change is done AND the full
# pre-push protocol (CLAUDE.md) has passed on that branch, the run calls
#
#     scripts/ship.sh <branch> [title]
#
# instead of pushing to main by hand. This one script is the push-gate for the
# deploy queue (docs/claude-console/deploy-queue-plan.md).
#
# The one fact that decides everything: does the branch's diff vs origin/main
# touch server/** ? That is exactly what makes a push redeploy the Railway
# backend — the redeploy that kills every other live console run. So it is the
# queue's membership rule.
#
#   DEPLOY_QUEUE_ENABLED=1  AND  diff touches server/**
#     -> push the BRANCH, POST /claude-deploy/mark-ready, STOP. main is not
#        touched. The background coordinator merges the whole 'ready' batch and
#        redeploys ONCE instead of once per server fix.
#   otherwise (flag off, or no server change)
#     -> today's behavior: sync main, --no-ff merge the branch into main, push.
#        Frontend/docs go straight to main; they never redeploy the backend.
#
# Inert until the flag is flipped: with DEPLOY_QUEUE_ENABLED unset every path is
# the direct push, so shipping this script changes nothing.
#
# mark-ready env (all injected into a console run by runner.ts): SMRTESY_BACKEND_URL,
# SMRTBOT_INTERNAL_SECRET, CLAUDE_THREAD_ID, CLAUDE_RUN_ID.

set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
TITLE="${2:-$BRANCH}"

if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "ship.sh: could not determine which branch to ship — pass it: scripts/ship.sh <branch>" >&2
  exit 1
fi
if [ "$BRANCH" = "main" ]; then
  echo "ship.sh: refusing to ship 'main' as a feature branch — pass the feature branch name" >&2
  exit 1
fi

git fetch origin main --quiet

# Deterministic membership test — no guessing, exactly what the coordinator and
# the backup hook check.
server_changed() {
  git diff --name-only origin/main...HEAD 2>/dev/null | grep -q '^server/'
}

if [ "${DEPLOY_QUEUE_ENABLED:-}" = "1" ] && server_changed; then
  echo "[ship] server/** change + queue armed → routing to the deploy queue (main untouched)"

  git push origin "$BRANCH"

  : "${SMRTESY_BACKEND_URL:?ship.sh: SMRTESY_BACKEND_URL unset — cannot reach mark-ready (not inside a console run?)}"
  : "${SMRTBOT_INTERNAL_SECRET:?ship.sh: SMRTBOT_INTERNAL_SECRET unset — cannot reach mark-ready}"
  : "${CLAUDE_THREAD_ID:?ship.sh: CLAUDE_THREAD_ID unset — not running inside a console thread}"

  # Build the JSON body safely. jq is present in the run env; fall back to a plain
  # interpolation (branch/title are simple tokens) if it somehow is not.
  if command -v jq >/dev/null 2>&1; then
    body="$(jq -cn \
      --arg t "$CLAUDE_THREAD_ID" \
      --arg r "${CLAUDE_RUN_ID:-}" \
      --arg b "$BRANCH" \
      --arg ti "$TITLE" \
      '{thread_id:$t, run_id:(if $r=="" then null else $r end), branch:$b, title:$ti}')"
  else
    body="{\"thread_id\":\"$CLAUDE_THREAD_ID\",\"run_id\":\"${CLAUDE_RUN_ID:-}\",\"branch\":\"$BRANCH\",\"title\":\"$TITLE\"}"
  fi

  resp="$(curl -sS -X POST "$SMRTESY_BACKEND_URL/api/claude-deploy/mark-ready" \
    -H "content-type: application/json" \
    -H "x-cron-secret: $SMRTBOT_INTERNAL_SECRET" \
    -d "$body")"
  echo "[ship] mark-ready → ${resp:-<no body>}"
  echo "[ship] queued. The coordinator will merge the batch and deploy once — nothing else to do."
  exit 0
fi

# Direct path — today's --no-ff workflow (CLAUDE.md "Push target — main by default").
echo "[ship] no server/** change (or queue disabled) → merging '$BRANCH' into main directly"
# Which surface the ship-status watcher should confirm — decided NOW, while HEAD is
# still the feature branch: after the merge below, `git diff origin/main...HEAD` is
# empty (main contains the branch), so server_changed would always read false.
if server_changed; then SHIP_SURFACE=railway; else SHIP_SURFACE=vercel; fi
git checkout main
git merge origin/main --ff-only
git merge --no-ff "$BRANCH" -m "Merge $BRANCH into main"
if ! git push origin main; then
  echo "ship.sh: push to main was rejected — fetch origin main and redo the --no-ff merge onto it" >&2
  exit 1
fi
MAIN_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
git checkout "$BRANCH"
git push origin "$BRANCH"
echo "[ship] merged '$BRANCH' into main and pushed. Verify Production advanced (/api/deploy-info)."

# Arm the ship-status watcher so the thread's rail dot goes green only once the
# production build for THIS push is confirmed live (red if it fails). Best-effort:
# only inside a console run (the env is injected there), and a failure never fails
# the ship. A server change on this path (queue disabled) redeploys Railway, so it
# is watched on Railway; a frontend/docs push is watched on Vercel.
if [ -n "${CLAUDE_THREAD_ID:-}" ] && [ -n "${SMRTESY_BACKEND_URL:-}" ] && [ -n "${SMRTBOT_INTERNAL_SECRET:-}" ] && [ -n "$MAIN_SHA" ]; then
  if command -v jq >/dev/null 2>&1; then
    ship_body="$(jq -cn --arg t "$CLAUDE_THREAD_ID" --arg s "$MAIN_SHA" --arg su "$SHIP_SURFACE" --arg b "$BRANCH" \
      '{thread_id:$t, sha:$s, surface:$su, branch:$b}')"
  else
    ship_body="{\"thread_id\":\"$CLAUDE_THREAD_ID\",\"sha\":\"$MAIN_SHA\",\"surface\":\"$SHIP_SURFACE\",\"branch\":\"$BRANCH\"}"
  fi
  curl -sS -X POST "$SMRTESY_BACKEND_URL/api/claude-deploy/mark-shipped" \
    -H "content-type: application/json" \
    -H "x-cron-secret: $SMRTBOT_INTERNAL_SECRET" \
    -d "$ship_body" >/dev/null 2>&1 \
    && echo "[ship] ship-status armed ($SHIP_SURFACE, ${MAIN_SHA:0:7}) — the rail dot will confirm when it goes live" \
    || echo "[ship] ship-status mark-shipped failed (non-fatal)"
fi
