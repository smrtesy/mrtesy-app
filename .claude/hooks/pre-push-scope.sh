#!/usr/bin/env bash
#
# pre-push-scope.sh — decide which pre-push checks a branch's diff actually needs,
# so the heavy `npm install && npm run build` runs ONLY when a change can affect
# a build, not on every push. Run it at the start of the pre-push protocol; it
# prints a recommendation and exits 0 (advisory — it never blocks a push).
#
# WHY: `npm install && npm run build` is minutes of wall-clock, and on the web
# container it dominates a session. A docs-only / .claude-only / migrations-only
# change physically cannot break the Next.js build or the server tsc build, so
# running it there is pure waste. This classifier scopes the build to the files
# that can actually break it.
#
# Classification of the changed files (vs origin/main):
#   FRONTEND build  (npm install && npm run build)  ← src/**, package.json,
#       package-lock.json, next.config.*, tsconfig*.json, .eslintrc*,
#       tailwind/postcss config, src/messages/**
#   SERVER build    (cd server && npm run build)     ← server/**
#   NONE (skip build; commit + push)                 ← docs/**, *.md, .claude/**,
#       supabase/migrations/** (SQL, not built), .github/**, and other non-build
#       assets. Edge functions (supabase/functions/**) are deployed by a GitHub
#       Action and have no local npm build — flagged as a note, not a build.
#
# Greps (Step 2) and the sub-agent review (Step 3) still apply to ANY non-trivial
# change — this script only scopes the expensive BUILD step, nothing else.
#
# Usage:  .claude/hooks/pre-push-scope.sh [base]      # base defaults to origin/main
set -uo pipefail

BASE="${1:-origin/main}"

# Resolve the diff base. Prefer the merge-base with origin/main; fall back
# gracefully so the script is useful even without network / on a fresh clone.
range=""
if git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then
  mb="$(git merge-base "$BASE" HEAD 2>/dev/null || true)"
  [ -n "$mb" ] && range="$mb"
fi

if [ -n "$range" ]; then
  files="$(git diff --name-only "$range"...HEAD 2>/dev/null || true)"
else
  # No usable base — consider committed diff vs HEAD's upstream, else everything
  # currently uncommitted. Err on the side of "build" when we truly can't tell.
  files="$(git diff --name-only HEAD 2>/dev/null || true)"
  [ -z "$files" ] && files="$(git diff --name-only 2>/dev/null || true)"
fi

# Always include staged + unstaged working-tree changes not yet committed.
extra="$( { git diff --name-only; git diff --cached --name-only; } 2>/dev/null | sort -u || true)"
files="$(printf '%s\n%s\n' "$files" "$extra" | sed '/^$/d' | sort -u)"

if [ -z "$files" ]; then
  echo "SCOPE: none"
  echo "לא נמצאו קבצים שהשתנו מול $BASE — אין מה לבנות. המשך ל-commit/push."
  exit 0
fi

need_frontend=0
need_server=0
need_edge=0
only_safe=1   # 1 while every file is a known no-build path

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    server/*)
      need_server=1; only_safe=0 ;;
    supabase/functions/*)
      need_edge=1; only_safe=0 ;;
    src/*|package.json|package-lock.json|next.config.*|tsconfig*.json|\
    .eslintrc*|tailwind.config.*|postcss.config.*)
      need_frontend=1; only_safe=0 ;;
    docs/*|*.md|.claude/*|supabase/migrations/*|.github/*|.gitignore|\
    LICENSE*|*.txt|public/*)
      : ;;  # known non-build asset — no build implication on its own
    *)
      # Unknown path at repo root or elsewhere: be conservative, suggest frontend
      # build (the default full check) rather than risk skipping a real breakage.
      need_frontend=1; only_safe=0 ;;
  esac
done <<EOF
$files
EOF

echo "קבצים שהשתנו מול $BASE:"
printf '%s\n' "$files" | sed 's/^/  /'
echo "────────────────────────────────────────────"

if [ "$only_safe" -eq 1 ]; then
  echo "SCOPE: none"
  echo "כל השינויים הם docs / .claude / migrations / assets — לא נבנים."
  echo "דלג על ה-build. הרץ רק greps/סקירה אם רלוונטי, ואז commit + push."
  exit 0
fi

echo "SCOPE:$([ "$need_frontend" -eq 1 ] && echo ' frontend')$([ "$need_server" -eq 1 ] && echo ' server')$([ "$need_edge" -eq 1 ] && echo ' edge')"
echo
if [ "$need_frontend" -eq 1 ]; then
  echo "• FRONTEND — הרץ:  npm install --no-audit --no-fund && npm run build"
fi
if [ "$need_server" -eq 1 ]; then
  echo "• SERVER   — הרץ:  cd server && npm install --no-audit --no-fund && npm run build"
fi
if [ "$need_edge" -eq 1 ]; then
  echo "• EDGE     — אין build מקומי; נפרס ב-GitHub Action. ודא ייבוא npm:/jsr: (לא esm.sh)."
fi
exit 0
