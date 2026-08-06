#!/usr/bin/env bash
#
# PreToolUse feature-registry gate ("a channel-gated feature is enforced,
# not remembered") — feature-channels plan, step 5.
#
# Blocks a `git push` whose commits introduce a NEW channel-gated feature in
# CODE without registering it in src/lib/feature-registry.ts in the same diff
# range. "New feature in code" = either
#   (a) a newly-added component file in the versioned-fork pattern — a file
#       whose name ends in V2 (e.g. FooV2.tsx), OR
#   (b) a new `<FeatureGate featureId="…">` usage whose featureId is not
#       present in src/lib/feature-registry.ts.
# Both only block while src/lib/feature-registry.ts is UNCHANGED in the same
# range (touch the registry in the same commit → no block). The block goes to
# the AGENT (exit 2 + stderr), which adds the entry and pushes again.
#
# It also WARNS (exit 0, stderr only — never blocks) when the push touches a
# file that a registry entry's codeRef points at: the change may need to land
# in both a V1 and a V2 of that feature.
#
# It can only see `git diff` — it CANNOT and does not try to validate the
# `feature_channels` DB state (impossible from git). It enforces the
# CODE structure alone.
#
# Repo targeting mirrors map-guard.sh: the repo is derived from the command
# (`git -C <dir>` first, then a leading `cd <dir>`), falling back to the hook's
# cwd, and the check only runs where src/lib/feature-registry.ts exists — so
# pushes in repos without the registry are never touched.
#
# Fail-open by design: no jq / not a git repo / no origin/main / any git error
# → exit 0. A guard that breaks pushes on infra weirdness gets disabled, not
# fixed. Emergency bypass: FEATURE_GUARD_SKIP=1 on the push command.

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
case "$cmd" in *FEATURE_GUARD_SKIP=1*) exit 0 ;; esac
[ "${FEATURE_GUARD_SKIP:-0}" = "1" ] && exit 0

# Resolve the repo the push targets: `git -C <dir>` wins, then `cd <dir>`,
# then the hook's own cwd. xargs strips quotes/whitespace from the match.
dir="$(printf '%s' "$cmd" | sed -n 's/.*git[[:space:]]\{1,\}-C[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | head -1)"
if [ -z "$dir" ]; then
  dir="$(printf '%s' "$cmd" | sed -n 's/^[[:space:]]*cd[[:space:]]\{1,\}\([^&;|]*\).*/\1/p' | head -1 | xargs 2>/dev/null || true)"
fi
[ -d "${dir:-}" ] || dir="$PWD"

# Normalize to the repo root so a push from a subdir still evaluates the whole
# repo and finds the registry at its real location.
top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$top" ] && dir="$top"

# Only repos that carry the registry are guarded.
[ -f "$dir/src/lib/feature-registry.ts" ] || exit 0

git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
git -C "$dir" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0
base="$(git -C "$dir" merge-base HEAD origin/main 2>/dev/null || true)"
[ -n "$base" ] || exit 0
head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
[ -n "$head" ] || exit 0
[ "$base" = "$head" ] && exit 0

REG="src/lib/feature-registry.ts"

# The files this push changes, and the raw diff body (for added lines).
changed_files="$(git -C "$dir" diff --name-only "$base" "$head" 2>/dev/null || true)"
[ -n "$changed_files" ] || exit 0
diff_body="$(git -C "$dir" diff "$base" "$head" 2>/dev/null || true)"
[ -n "$diff_body" ] || exit 0

# Added lines only (drop the "+++ b/file" header lines).
added_lines="$(printf '%s\n' "$diff_body" | grep -E '^\+' | grep -v '^\+\+\+' 2>/dev/null || true)"

# Was the registry itself touched in this range? If so, no block — the author
# is registering something in the same commit.
registry_changed="$(git -C "$dir" diff --name-only "$base" "$head" -- "$REG" 2>/dev/null || true)"

# --- BLOCK CHECK (skipped entirely when the registry changed) --------------
if [ -z "$registry_changed" ]; then
  # (a) newly-added component files in the versioned-fork pattern (…V2.<ext>).
  new_v2="$(git -C "$dir" diff --name-status --diff-filter=A "$base" "$head" 2>/dev/null \
    | awk '{ print $2 }' | grep -E 'V2\.(tsx|ts|jsx|js)$' 2>/dev/null || true)"

  # (b) new <FeatureGate featureId="…"> usages (JSX uses `featureId=`, the
  #     registry definition uses `featureId:` — the `=` keeps them apart).
  new_gate_ids="$(printf '%s\n' "$added_lines" \
    | grep -oE 'featureId="[^"]*"' 2>/dev/null \
    | sed 's/^featureId="//; s/"$//' | sort -u || true)"

  # featureIds registered in the registry at HEAD.
  registered_ids="$(git -C "$dir" show "$head:$REG" 2>/dev/null \
    | sed -n 's/.*featureId:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u || true)"

  unregistered=""
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    printf '%s\n' "$registered_ids" | grep -qxF "$id" || unregistered="$unregistered $id"
  done <<EOF
$new_gate_ids
EOF

  if [ -n "$new_v2" ] || [ -n "${unregistered// /}" ]; then
    {
      echo "feature-registry-guard: פיצ'ר חדש בקוד אינו רשום ב-$REG — הוסף לו רשומה באותו commit."
      [ -n "$new_v2" ] && { echo "קומפוננטות בדפוס גרסה חדש (…V2):"; printf '  + %s\n' $new_v2; }
      [ -n "${unregistered// /}" ] && { echo "featureId חדש ב-<FeatureGate> שאינו במרשם:"; printf '  + %s\n' $unregistered; }
      echo "(עקיפת חירום, רק אם באמת נדרש: FEATURE_GUARD_SKIP=1 git push …)"
    } >&2
    exit 2
  fi
fi

# --- WARNING (never blocks): did the push touch a registered codeRef? -------
registered_refs="$(git -C "$dir" show "$head:$REG" 2>/dev/null \
  | sed -n 's/.*codeRef:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"

touched_refs=""
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$ref" in
      */) case "$f" in "$ref"*) touched_refs="$touched_refs $ref" ;; esac ;;
      *)  [ "$f" = "$ref" ] && touched_refs="$touched_refs $ref" ;;
    esac
  done <<EOF
$changed_files
EOF
done <<EOF
$registered_refs
EOF

if [ -n "${touched_refs// /}" ]; then
  {
    echo "feature-registry-guard: יש כאן פיצ'ר רשום (אולי V1/V2) — בדוק אם התיקון צריך להיכנס לשתי הגרסאות."
    printf '  · %s\n' $touched_refs | sort -u
  } >&2
fi
exit 0
