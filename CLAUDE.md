# CLAUDE.md

Operating instructions for Claude working in this repo. Read this at the start
of every session before touching code.

## Response language — always Hebrew

Always respond to the user in **Hebrew**, in every reply, regardless of the
language of their message, the codebase, or these (English) instructions. This
is the user's standing preference and it applies to **all** sessions —
including Claude Code on the web, which does not load personal `~/.claude`
config, so this repo-level rule is what enforces it there. Write all prose
directed at the user (chat replies, explanations, questions, summaries) in
Hebrew. Code, identifiers, file paths, and commit/PR text keep following the
existing repo conventions (English where the repo already uses English) — only
the text you address to the user is Hebrew.

## smrtTask task-ingest mode (trigger-gated)

If the user's first message in the session begins with the phrase
**"עדכון משימות"**, read `CLAUDE-smrttask-ingest.md` before doing
anything else and follow it for the entire session. The first action
in that mode is to send the user an explicit acknowledgement that the
file is active and that the rules apply (project matching, table
preview, no DB writes without explicit approval). Do not invoke
that flow unless the trigger phrase is present at the start.

## smrtTask session proposals (Stop hook)

**Requirement:** every Claude Code chat in this repo must leave a trace in
smrtTask. When a chat here stops, a "הצעה" (proposal) is filed into the
user's smrtTask inbox summarizing the session: the topic discussed, where it
happened (repo / branch), a verbatim deep link back to the web chat, and a
proposed next step to close the discussion/action.

This is enforced by a **`Stop` hook**, not by Claude remembering to do it —
the harness runs the hook on every turn-end, so it fires reliably even if the
session ends abruptly. Claude following a CLAUDE.md line alone would be
best-effort; the hook is the real mechanism. Moving parts:

- **`.claude/settings.json`** → `hooks.Stop` runs
  `.claude/hooks/smrttask-session-proposal.sh`.
- **`.claude/hooks/smrttask-session-proposal.sh`** — fully guarded,
  fire-and-forget wrapper. Reads the hook JSON on stdin, builds the request
  body, and POSTs it detached so it never delays or fails a turn. Exits 0
  silently whenever `CRON_SECRET` (or `node`/`curl`) is missing.
- **`.claude/hooks/build-session-proposal.mjs`** — derives everything from the
  environment: `session_id`/`session_url` from `CLAUDE_CODE_REMOTE_SESSION_ID`
  (`cse_<slug>` → `https://claude.ai/code/session_<slug>`), `user_email` from
  `CLAUDE_CODE_USER_EMAIL`, `git_branch` from `.git/HEAD`, and a compact
  transcript from `transcript_path`.
- **`POST /api/claude-session/proposal`** (server
  `modules/smrttask/routes/claude-session.ts`) — machine-to-machine, gated by
  the shared `x-cron-secret` header (same pattern as `/sync/run-scheduled`, no
  JWT). Resolves the user → primary org → smrttask entitlement, summarizes the
  transcript with Haiku, and **upserts one task per session** keyed by the tag
  `claude-session:<session_id>` (`task_type: "followup"`, `status: "inbox"`,
  `priority: "low"`, `manually_verified: false`, the deep link in
  `action_links`). Repeated Stop calls refresh the same task's content; a
  status the user changed (archived/dismissed) is never overwritten.

**Provisioning (one-time):** the endpoint lives on the **Express backend
(Railway)**, not on the Next.js app at `app.smrtesy.com` (that host has no
`/api/claude-session` route and would 404). Set two things in the Claude Code
environment, copying the values from the Railway backend's service variables:
- the shared secret — `SMRTBOT_INTERNAL_SECRET` (or `CRON_SECRET`). The backend
  accepts either (`process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET`);
  Railway currently provisions `SMRTBOT_INTERNAL_SECRET`, so copy that value.
- the backend base URL — `SMRTESY_BACKEND_URL`, set to the value of the
  backend's `SMRTESY_PUBLIC_URL` (same as the app's `NEXT_PUBLIC_BACKEND_URL`,
  e.g. `https://<app>.up.railway.app`); the hook builds
  `…/api/claude-session/proposal` from it. Or set the full
  `SMRTTASK_PROPOSAL_URL` directly. Include the `https://` scheme — a
  schemeless value makes curl use `http://`, which Railway 301-redirects and a
  POST does not replay (the hook now normalizes a missing scheme to `https://`
  and follows redirects, but set it correctly anyway).

**Identity override (often required):** the endpoint files the proposal for the
smrtesy *platform* account, which may differ from the Claude Code *login* email
(e.g. a `@maor.org` Claude login vs a `@gmail.com` platform account). When they
differ, set one of `SMRTTASK_USER_ID` (most robust — bypasses email lookup) or
`SMRTTASK_USER_EMAIL` in the Claude Code environment; otherwise the hook sends
`CLAUDE_CODE_USER_EMAIL` and the backend 404s with "user not found". The
backend resolves email via a single `listUsers({ perPage: 1000 })` + local
match (the repo's proven pattern; a paginated `{ page }` loop did not resolve).

There is no baked-in URL default on purpose (a wrong host silently 404s every
turn). A missing secret **or** URL makes the hook a silent no-op. The backend
also hard-fails the auth check when neither secret env var is set, so an unset
secret can never leave the route open.

## Push target — main by default

The user has standing authorization to push fixes directly to `main` once the
pre-push protocol (below) is clean. Workflow on a feature branch is:

1. Run the full pre-push protocol on the feature branch (build, greps,
   sub-agent review).
2. `git fetch origin main` and merge `origin/main` into the feature branch
   first — confirm no merge conflicts and the build still passes.
3. Give `main` its **own distinct commit** — never a shared SHA with the
   feature branch. Merge the feature branch into `main` with `--no-ff` so
   `main` gets a fresh merge commit even when a fast-forward is possible:

   ```
   git checkout main && git merge origin/main --ff-only   # sync main first
   git merge --no-ff <feature-branch> -m "Merge <feature-branch> into main"
   git push origin main
   git checkout <feature-branch> && git push origin <feature-branch>
   ```

   Do **NOT** fast-forward `main` to the feature branch's tip (the old
   workflow). That left `main` and the feature branch pointing at the
   *identical* SHA, and Vercel de-duplicates deployments by commit SHA:
   when both refs are pushed near-simultaneously, whichever branch's
   webhook Vercel processes first "claims" the single build. If the
   feature branch wins that race the build is published as a **Preview**
   and `main`'s **Production** deployment never advances — the fix silently
   ships to a preview URL only. A `--no-ff` merge gives `main` a
   main-only SHA, so its push always produces its own Production build and
   there is no race. (This bit us on the whatsapp-receipts push: the fix
   built as a Preview and Production stayed on the previous commit.)

If the merge produces conflicts, stop and surface them to the user
instead of resolving silently. If the post-merge build fails, fix the
failures on the feature branch before touching `main`.

Verify each push actually succeeded — read git's own exit status, not a
piped command's. `git push … | tail` reports `tail`'s exit code (0) even
when the push was rejected (non-fast-forward), which silently hides a
failed push. If a push is rejected, `git fetch origin main` and redo the
`--no-ff` merge onto the updated `main` before retrying.

After pushing `main`, confirm Production actually advanced: curl
`https://app.smrtesy.com/api/deploy-info` and check `commit_short` matches
the SHA you pushed (Vercel takes a few minutes to build). If it's stuck on
the old commit or shows the fix as a Preview only, the one-click recovery
is Vercel dashboard → the built deployment's `⋯` → **Promote to Production**.

This overrides the "never push to a different branch without explicit
permission" line in the harness's git-branch instructions — that explicit
permission is now standing for `main`.

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

### Step 4 — Update app status if you touched an app's files

If this push includes changes to `server/src/apps/<slug>/` or any feature
clearly owned by a specific app, update that app's status via:

```
PATCH /api/admin/apps/<slug>/status
body: {
  stage:      "<שלב נוכחי: רעיון|בניה|טסט|מאור|לקוחות>",
  summary:    "<מה המצב עכשיו — בעברית פשוטה, משפט-שניים>",
  next_steps: ["<מה הבא 1>", "<מה הבא 2>"],
  blockers:   ["<חוסם אם יש>"]
}
```

Valid stages (in order): `רעיון` → `בניה` → `טסט` → `מאור` → `לקוחות`

Use the `api()` helper or call the endpoint directly. If the status hasn't
materially changed (e.g. a one-line bugfix), skip this step. If you added a
significant feature, milestone, or changed direction — update it.

### Step 5 — Self-check on commit hygiene

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

## Product principles — apply across the whole system

- **Preserve deep links — never strip a URL down to its domain**.
  The user's instruction (May 2026): "the whole point of this system is
  to be as efficient as possible — instead of giving me a general link
  to the main domain of the site, give me the original link I sent that
  leads directly to where I want to go." This is system-wide, not a
  merge-only rule. Whenever any AI-generated content (task descriptions,
  checklist items, summaries, suggestion bodies, reminders, etc.)
  references something the user linked to, **emit the exact deep URL
  verbatim** — including query params, fragments, message IDs, doc IDs.
  Never paraphrase `https://site.com/products/foo?ref=bar` down to
  `site.com`. If a checklist item maps to multiple links, list them
  all on the item. Same applies to Gmail message URLs, Drive doc IDs,
  Calendar event links, WhatsApp message links. **One click should
  always land the user on the right page**, not the homepage.

  Where to enforce: every Sonnet/Haiku system prompt that produces
  user-facing text. When you write a new AI prompt, add an explicit
  "preserve URLs verbatim" clause. When you review an existing one
  that doesn't have it, add it.

- **Compact, minimal UI — every new feature defaults to collapsed/quiet**.
  The user's instruction (June 2026, prompted by the WhatsApp search bar):
  keep the interface compact and minimal — don't add permanent chrome that
  sits on screen taking space when it isn't in use. When you add any
  feature with a surface (search, filters, sort controls, bulk actions,
  advanced options, etc.):
  - **Default to collapsed.** Show a small icon button (next to the title
    / in the header), and reveal the full control only when the user
    clicks it. The WhatsApp chat search is the reference implementation:
    a `Search` icon by the list, click → the input row expands; close
    (X / Escape) → it collapses and resets. See
    `src/components/smrttask/whatsapp/WhatsAppReader.tsx`.
  - Prefer icon buttons + tooltips over always-on labelled inputs.
  - Don't stack rows of controls above content. One quiet entry point
    that expands on demand beats a permanent toolbar.
  - Reuse existing density/spacing of the surrounding screen — match the
    neighbours, don't introduce a bulkier pattern.
  When in doubt, the smaller, hidden-until-needed version is the right
  call. This applies to every app/screen, not just WhatsApp.

## Project conventions worth remembering

- **Tabs-workspace panes (router-based)**: sidebar screens render as
  component panes via `src/lib/panes/registry.tsx`; unregistered routes
  fall back to an iframe pane automatically (this fallback is permanent —
  detail routes, /projects, /settings and /admin use it by design). When
  you add or change a screen that can render in a pane:
  - Register it in the registry with a wrapper that mirrors the route
    page's markup 1:1.
  - Use `useScreenSearchParams` / `useScreenPathname` / `useScreenRouter`
    and `PaneLink` from `@/lib/panes/nav` instead of next/navigation and
    next/link — they are byte-identical outside a pane.
  - Never write `document.body` / `documentElement` attributes without a
    `useOptionalPaneNav()` guard (in a pane they leak onto the top window).
  - No `100dvh`/viewport heights inside pane-capable screens — use
    `h-full` (chat-style screens get `fullHeight: true` in the registry).
  - Links that should open a SIBLING tab (not swap the pane) go through
    `OpenTabLink`. See docs/router-panes-plan.md for the full picture.

- **Edge function imports — NEVER use `https://esm.sh/...`**. The
  `Deploy to Supabase` GitHub Action (`.github/workflows/*.yml`) bundles
  every function on each push to `main` by hitting esm.sh, which
  intermittently returns HTTP 522 (Cloudflare Tunnel down) and breaks the
  whole deploy with `Error: failed to create the graph` /
  `Import 'https://esm.sh/...' failed: 522`. Use the Deno-native
  specifiers Supabase Edge Runtime supports directly instead:
  - Supabase client → `import { createClient } from "npm:@supabase/supabase-js@2";`
  - Type-only edge runtime decl → `import "jsr:@supabase/functions-js/edge-runtime.d.ts";`
  - Anthropic SDK / Google APIs → `npm:@anthropic-ai/sdk`, `npm:googleapis`, etc.
  This bug has now bitten us twice; if you ever see `Error: failed to create
  the graph ... Import 'https://esm.sh/... failed: 522`, the fix is a
  one-line `sed` across `supabase/functions/*/index.ts`.
- **i18n**: every user-visible string goes through `useTranslations()` /
  `getTranslations()` and resolves to a key in `src/messages/{he,en}.json`.
  Never write `locale === "he" ? "..." : "..."` ternaries. If a key is
  missing, add it to both files in the same commit that uses it.
- **API client**: frontend → backend always goes through `api()` from
  `@/lib/api/client.ts`, which auto-attaches `Authorization` and
  `X-Org-Id`. Raw `fetch()` to `/api/*` is a bug.
- **Org scoping**: every backend route that touches user/tenant data
  requires `requireAuth + requireOrg + requireApp("<app-slug>")` — the
  per-app slug, e.g. `requireApp("smrttask")` or `requireApp("smrtvoice")`
  (the legacy `"smrtesy"` slug was renamed to `"smrttask"` in migration
  `20260518000004`). Exceptions: admin routes (`requireSuperAdmin`) and
  per-user-no-org routes (`/api/me/*`).
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

## Planning / design docs — commit and share a GitHub link

The user strongly prefers reading docs **on GitHub**, not in chat or as
attachments. Whenever you author a substantial doc — a `docs/*-plan.md`,
a design spec, an investigation write-up — **commit it to the repo and
push**, then give the user the GitHub link to the file (on the branch you
pushed to, e.g. `https://github.com/smrtesy/mrtesy-app/blob/<branch>/docs/<file>.md`).
A docs-only commit doesn't need the full pre-push build protocol (it
touches no code) — just commit and push. Do this by default for any plan
you write for approval, so the user can read it comfortably before saying
go.

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
