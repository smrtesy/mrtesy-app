#!/usr/bin/env bash
#
# PreToolUse map-freshness gate ("the map is enforced, not remembered").
#
# Blocks a `git push` whose commits change the STRUCTURE the codebase map
# enumerates — a directory added or removed at the exact levels listed in
# docs/codebase-map.md — without touching docs/codebase-map.md in the same
# range. Deterministic tree comparison, zero AI, zero cost. The block goes to
# the AGENT (exit 2 + stderr), which updates the map and pushes again; it is
# not a user prompt.
#
# Watched levels (must mirror what the map actually enumerates):
#   src/components/<x>            server/src/modules/<x>
#   server/src/apps/<x>           supabase/functions/<x>
#   src/app/[locale]/(app)/<group>/<screen>
#
# Repo targeting: the push may run in a multi-repo session, so the repo is
# derived from the command itself (`git -C <dir>` first, then a leading
# `cd <dir>`), falling back to the hook's cwd — and the check only runs where
# a docs/codebase-map.md actually exists, so pushes in repos without a map
# (video-lab, voice-engine) are never touched.
#
# Fail-open by design: no jq / not a git repo / no origin/main / any git error
# → exit 0. A guard that can break pushes on infra weirdness would get
# disabled, not fixed. Emergency bypass: MAP_GUARD_SKIP=1 on the push command
# — then fix the map in the very next commit.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

payload="$(cat 2>/dev/null || true)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# Only care about pushes — `git push` in COMMAND position (start of a line or
# after ;, &, | or an env-var prefix), so text that merely mentions the words
# (echo/grep/docs) is not gated.
printf '%s\n' "$cmd" | grep -Eq '(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?push([[:space:]]|$)' || exit 0

# Explicit bypass, either in the command text or the environment.
case "$cmd" in *MAP_GUARD_SKIP=1*) exit 0 ;; esac
[ "${MAP_GUARD_SKIP:-0}" = "1" ] && exit 0

# Resolve the repo the push targets: `git -C <dir>` wins, then `cd <dir>`,
# then the hook's own cwd. xargs strips quotes/whitespace from the match.
dir="$(printf '%s' "$cmd" | sed -n 's/.*git[[:space:]]\{1,\}-C[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | head -1)"
if [ -z "$dir" ]; then
  dir="$(printf '%s' "$cmd" | sed -n 's/^[[:space:]]*cd[[:space:]]\{1,\}\([^&;|]*\).*/\1/p' | head -1 | xargs 2>/dev/null || true)"
fi
[ -d "${dir:-}" ] || dir="$PWD"

# Normalize to the repo root, so a push from a subdir (`cd server && git push`)
# still evaluates the whole repo and finds the map at its real location.
top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$top" ] && dir="$top"

# Only repos that carry a map are guarded.
[ -f "$dir/docs/codebase-map.md" ] || exit 0

git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
git -C "$dir" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0
base="$(git -C "$dir" merge-base HEAD origin/main 2>/dev/null || true)"
[ -n "$base" ] || exit 0
head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
[ -n "$head" ] || exit 0
[ "$base" = "$head" ] && exit 0

# The directory set the map enumerates, at a given revision. ls-tree -r lists
# FILES, so a level-k directory needs NF >= k+1 (a file directly at level k is
# not a directory there). Field-equality in awk (no regex), so bracket/paren
# path segments need no escaping.
map_dirs() {
  git -C "$dir" ls-tree -r --name-only "$1" 2>/dev/null | awk -F'/' '
    $1=="src" && $2=="components" && NF>=4 { print $1"/"$2"/"$3 }
    $1=="server" && $2=="src" && $3=="modules" && NF>=5 { print $1"/"$2"/"$3"/"$4 }
    $1=="server" && $2=="src" && $3=="apps" && NF>=5 { print $1"/"$2"/"$3"/"$4 }
    $1=="supabase" && $2=="functions" && NF>=4 { print $1"/"$2"/"$3 }
    $1=="src" && $2=="app" && $3=="[locale]" && $4=="(app)" && NF>=7 { print $1"/"$2"/"$3"/"$4"/"$5"/"$6 }
  ' | sort -u
}

base_dirs="$(map_dirs "$base")" || exit 0
head_dirs="$(map_dirs "$head")" || exit 0

added="$(comm -13 <(printf '%s\n' "$base_dirs" | sed '/^$/d') <(printf '%s\n' "$head_dirs" | sed '/^$/d') 2>/dev/null || true)"
removed="$(comm -23 <(printf '%s\n' "$base_dirs" | sed '/^$/d') <(printf '%s\n' "$head_dirs" | sed '/^$/d') 2>/dev/null || true)"
[ -z "$added$removed" ] && exit 0

# Structure changed — the map must have changed in the same range.
map_changed="$(git -C "$dir" diff --name-only "$base" "$head" -- docs/codebase-map.md 2>/dev/null || true)"
[ -n "$map_changed" ] && exit 0

{
  echo "map-guard: המבנה השתנה אבל docs/codebase-map.md לא עודכן באותם קומיטים — הדחיפה נחסמה."
  [ -n "$added" ] && { echo "תיקיות חדשות שהמפה צריכה לשקף:"; printf '  + %s\n' $added; }
  [ -n "$removed" ] && { echo "תיקיות שנמחקו ועדיין מופיעות במפה:"; printf '  - %s\n' $removed; }
  echo "עדכן את docs/codebase-map.md (כולל שורת ה-Verified), הוסף לקומיט, ודחוף שוב."
  echo "(עקיפת חירום, רק אם באמת נדרש: MAP_GUARD_SKIP=1 git push …)"
} >&2
exit 2
