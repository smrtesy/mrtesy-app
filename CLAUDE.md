# CLAUDE.md

Operating instructions for Claude working in this repo. Read this at the start
of every session before touching code.

## Pre-push review protocol — non-negotiable

Before `git push` on any branch with non-trivial changes (anything beyond a
typo or formatting), run the full sequence below. Do not ask the user
permission to run it — run it. Do not push without it.

The goal is to catch bugs in the same session that introduced them, so the
user never sees a stream of "push → bot finds bug → push again" round trips.
The standard is **zero findings from Claude Code Review on the first push.**

### Step 1 — Real build (not just tsc)

```
npm install --no-audit --no-fund && npm run build
```

**`npm run build` is the only authoritative check.** It runs the
Next.js production build which combines TypeScript checking, ESLint
(with `react-hooks/exhaustive-deps`, `@typescript-eslint/no-unused-vars`,
etc. — rules that catch what tsc alone misses), and JSX/MDX compilation.
Vercel runs exactly the same pipeline; if it passes locally, it passes
there.

Do NOT lean on `tsc --noEmit` as the only check. In this sandbox tsc
fails on missing `node_modules` and reports "Cannot find module 'react'"
type errors that are environmental, masking real type errors and giving
a false-clean signal. Install first, build second.

Catching ESLint errors here saves a deploy cycle. Real categories that
have slipped past in this repo: `@typescript-eslint/no-unused-vars`
(unused props after refactor), `react-hooks/exhaustive-deps` (hooks
referenced in callbacks but missing from deps), `TS2451` duplicate
declarations from parallel agent edits, double-imports.

Treat any new error in files this branch touched as a blocker.
Pre-existing errors in unrelated files are not your problem this session.

If `npm install` is slow on a given sandbox, accept the cost once per
session — every subsequent build reuses the install. Iterating with
`tsc --noEmit` between fixes is fine after the initial install, since
tsc resolves node_modules from there.

### Step 2 — Targeted greps for the categories of bug that slip past me

For each category, grep before push. These are the patterns that produced
real bugs in this repo's history (commit `705d2eb` fixed four of them in
one go — every one was preventable with a 30-second grep).

| Category | What to grep for | Why |
|---|---|---|
| Hardcoded constants left over from single-tenant builds | `grep -rn '"1wDog\|noreply@maor\|@maor.org\|chanoch'` in changed files' neighbors | The Drive folder fallback footgun; my_emails hardcoding; etc. |
| Schema CHECK constraints I might violate | `grep -rn "CHECK (" supabase/migrations/ \| grep <table>` for any table I'm inserting to | `created_by IN ('user','claude','system')` would have caught the `"onboarding"` bug |
| API defaults I'm relying on without knowing them | Read the docs page or local wrapper for any Google/Supabase/SDK call whose filter behavior I just changed | Gmail `q` searching all labels by default would have caught the missing `in:inbox` |
| Semantic mismatch between UI strings and backend filter direction | Read the i18n key the user-visible label resolves to, then trace the trigger value all the way through `parseSkipRules` (or the equivalent runtime check) | The skip-rule `to=` vs `from=` bug |
| Insert/update without `{ error }` destructuring | `grep -n "await supabase.from.*\\.\\(insert\\|update\\|upsert\\)(" -A0` in changed files | Silent CHECK violations, silent RLS denials |

### Step 3 — Sub-agent code review

Spawn an `Explore` or `general-purpose` agent with a focused prompt:

> Review the staged diff of branch `<branch>` at `/home/user/mrtesy-app`.
> Read every changed file in full. For each change, ask:
>
> 1. Does any UI string the user sees promise something the backend doesn't deliver?
> 2. Does any DB write hit a CHECK / NOT NULL / FK / unique constraint that
>    I'm not honoring? Cross-check by reading the relevant migration file.
> 3. Does any removed code (especially filter clauses, fallbacks, validation)
>    leave the surrounding logic silently broken?
> 4. Does any new code reference a value that's hardcoded in a way that
>    breaks for non-original tenants? (folder IDs, emails, account names)
> 5. Does any `await` on a query swallow the `{ error }` field?
> 6. Are there off-by-one / inclusive-exclusive / time-window asymmetries?
>    (e.g. lookback parameterized but lookahead hardcoded)
>
> For each finding, cite file:line, state what breaks and when, rate
> severity HIGH/MED/LOW, and propose a one-line fix. Cap report at 600
> words. Do not propose stylistic nits.

Treat any HIGH or MED finding as a blocker. Fix it in the same branch
before push. LOW is judgment — fix if cheap, ignore if not.

### Step 4 — Self-check on commit hygiene

- Are there 3+ commits where each fixes the previous? Squash before push,
  or at least keep the noise out of `main` (use `git rebase -i` only if user
  has explicitly authorized).
- Did I leave a temporary `console.log`, `TODO`, or commented-out block?
- Did I add a file that should never be committed (`.env`, credentials)?

## What this is NOT

This is not "ask the user before pushing." The user has already approved
that I push to feature branches. The point is to push higher-quality work,
not to add friction.

This is not "run every test in the repo." If there's a test suite that's
relevant to the change, run it. Don't run the whole suite for a one-file
change.

## Why this exists

PR #1 went through four rounds of "Claude Code Review finds bugs, I fix,
push again" because I skipped this protocol. Thirteen real bugs across
those rounds — every single one of which a 1-minute grep, schema read,
or sub-agent review would have caught locally.

The user explicitly told me they no longer want to rely on the GitHub
Claude Code Review bot as the quality gate. **The sub-agent review I run
in Step 3 of this protocol IS the gate.** The bot may stay enabled as a
silent safety net — if it ever surfaces a finding I missed, the protocol
itself is broken and needs strengthening. The default expectation is
that the bot finds nothing because I caught it first.

This is not about avoiding work. It's about doing the work *before* the
push, in one session, so the user sees a clean PR instead of a stream
of fix-up commits.

## Product naming convention

All product names follow the pattern **`smrt` + English word**:
- `smrt` is always lowercase, no space, attached directly to the word
- The following word is a valid English word, either `camelCase` (e.g. `smrtTask`) or all-lowercase (e.g. `smrtcrm`)
- Correct: `smrtTask`, `smrtCRM`, `smrtHR`, `smrtMail`
- Incorrect: `SmartTask`, `smrt-task`, `smrttsk` (abbreviation), `smrtמשימות`
- The platform itself is **smrtesy** (the name, not subject to this rule)
- App slugs in the DB follow the same pattern (lowercase): `smrttask`, `smrtcrm`

## Project conventions worth remembering

- **i18n**: every user-visible string goes through `useTranslations()` /
  `getTranslations()` and resolves to a key in `src/messages/{he,en}.json`.
  Never write `locale === "he" ? "..." : "..."` ternaries. If a key is
  missing, add it to both files in the same commit that uses it.
- **API client**: frontend → backend always goes through `api()` from
  `@/lib/api/client.ts`, which auto-attaches `Authorization` and
  `X-Org-Id`. Raw `fetch()` to `/api/*` is a bug.
- **Org scoping**: every backend route that touches user/tenant data
  requires `requireAuth + requireOrg + requireApp("smrtesy")` unless it's
  an admin route (`requireSuperAdmin`) or a per-user-no-org route
  (`/api/me/*`).
- **Service-role Supabase**: use `createAdminSupabaseClient()` from
  `@/lib/supabase/admin.ts`. Never instantiate `createClient` with the
  service key inline in a page or component.
- **Skip rules**: addresses entered by users go to `rules_memory` with
  trigger `from=<email>` for emails and `domain=<dom>` for domains.
  `created_by` must be one of `('user','claude','system')`. Always
  destructure `{ error }` from the insert.
- **Gmail queries**: include `in:inbox` unless you have a documented
  reason to scan other labels. Gmail's `q` parameter searches all labels
  by default (excluding Trash/Spam).
- **Drive scanning**: opt-in only. If `user_settings.drive_folder_id` is
  null and no explicit folder is passed, return `[]` and skip — never
  fall back to a hardcoded folder ID.

## Migration discipline

When you write SQL DDL (CREATE/ALTER/DROP) or DML that the user wants
persisted, create a numbered file under `supabase/migrations/` named
`YYYYMMDDHHMMSS_<slug>.sql` and tell the user to run it via Supabase
CLI. Do not call `mcp__supabase__apply_migration` on a production
project without explicit user authorization.

## When the user is mid-onboarding and stuck

The (app)/layout.tsx redirects to /onboarding when `onboarding_completed
= false`. Super-admins are exempt (we wired this in PR #1). If a regular
user is stuck:

- Light reset: set `onboarding_completed = false`, clear
  `initial_scan_*` flags. They restart at step 1 with credentials intact.
- Medium reset: also delete `user_credentials` for Gmail/Drive/Calendar
  + set the `*_connected` booleans to false. They re-OAuth.
- Full reset: delete the auth.users row in a transaction that first
  removes org/app_memberships/user_settings/user_credentials. Supabase
  cascades for product tables.

Always confirm scope with AskUserQuestion before doing any of these.
