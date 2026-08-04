#!/usr/bin/env bash
#
# PreToolUse deploy-queue gate — the backstop for the scripts/ship.sh push gate.
#
# When DEPLOY_QUEUE_ENABLED=1, a manual `git push` that advances origin/main
# with a server/** change redeploys the Railway backend and kills every other
# live console run — the exact thing the deploy queue exists to batch
# (docs/claude-console/deploy-queue-plan.md). scripts/ship.sh is the PRIMARY
# gate (it routes server changes to the queue); this hook only catches a run
# that pushes main by hand instead of calling ship.sh.
#
# Blocks (exit 2 → the AGENT, not a user prompt) only when ALL hold:
#   - DEPLOY_QUEUE_ENABLED=1            (feature armed; fully inert otherwise)
#   - the command is a `git push` targeting `main`
#   - the diff origin/main...HEAD touches server/**
# Frontend/docs pushes, branch pushes, and everything with the flag off pass
# through untouched.
#
# Fail-open on any infra weirdness (no jq/git, not a repo, no origin/main) — as
# with map-guard, a guard that breaks legit pushes gets disabled, not fixed.
# Emergency bypass: DEPLOY_GATE_SKIP=1 git push …  (then use ship.sh next time).

set -uo pipefail

# Inert unless the feature is armed — this is the master switch, same as the
# coordinator and ship.sh. With it unset the hook does nothing at all.
[ "${DEPLOY_QUEUE_ENABLED:-}" = "1" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

payload="$(cat 2>/dev/null || true)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# Only a `git push` in COMMAND position (line start, or after ; & | ( or env-var
# prefixes) — text that merely mentions the words is not gated. Same shape as
# map-guard so a multi-line/prefixed push cannot slip past.
printf '%s\n' "$cmd" | grep -Eq '(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?push([[:space:]]|$)' || exit 0

# Explicit bypass, in the command text or the environment.
case "$cmd" in *DEPLOY_GATE_SKIP=1*) exit 0 ;; esac
[ "${DEPLOY_GATE_SKIP:-0}" = "1" ] && exit 0

# Resolve the repo dir the push targets: `git -C <dir>` wins, then a leading
# `cd <dir>`, then the hook's own cwd (same resolution as map-guard).
dir="$(printf '%s' "$cmd" | sed -n 's/.*git[[:space:]]\{1,\}-C[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | head -1)"
if [ -z "$dir" ]; then
  dir="$(printf '%s' "$cmd" | sed -n 's/^[[:space:]]*cd[[:space:]]\{1,\}\([^&;|]*\).*/\1/p' | head -1 | xargs 2>/dev/null || true)"
fi
[ -d "${dir:-}" ] || dir="$PWD"
top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$top" ] && dir="$top"

git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
git -C "$dir" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

# Does this push target `main`? Either an explicit main refspec (`origin main`,
# `HEAD:main`, `main:main`, `refs/heads/main`), or a bare push while main is the
# checked-out branch.
targets_main=0
printf '%s\n' "$cmd" | grep -Eq 'push[[:space:]].*([[:space:]:/])main([[:space:]]|:|$)' && targets_main=1
if [ "$targets_main" -eq 0 ]; then
  cur="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ "$cur" = "main" ]; then
    # A bare `git push` / `git push origin` (no explicit refspec) pushes the
    # current branch = main. If a refspec IS present it named a non-main branch
    # (the explicit-main case is already handled above), so leave it alone.
    printf '%s\n' "$cmd" | grep -Eq 'push[[:space:]]+(-[^[:space:]]+[[:space:]]+)*origin[[:space:]]+[^[:space:]-]' || targets_main=1
  fi
fi
[ "$targets_main" -eq 1 ] || exit 0

# Server change in what would be pushed?
git -C "$dir" diff --name-only origin/main...HEAD 2>/dev/null | grep -q '^server/' || exit 0

{
  echo "deploy-gate: דחיפה ידנית ל-main עם שינוי server/** נחסמה (DEPLOY_QUEUE_ENABLED=1)."
  echo "שינויי-שרת עוברים דרך תור-הפריסה כדי לא לאתחל את ה-backend ולהרוג ריצות-קונסולה אחרות."
  echo "הרץ במקום זאת:  scripts/ship.sh <branch>  — הוא דוחף את הענף, קורא mark-ready, ועוצר."
  echo "(עקיפת חירום, רק אם באמת נדרש: DEPLOY_GATE_SKIP=1 git push …)"
} >&2
exit 2
