# Codebase map — smrtesy platform

> **Loaded into every Claude session** via the `@docs/codebase-map.md` import in
> CLAUDE.md — all surfaces, including the in-app Claude console (which runs inside
> a clone of this repo). Purpose: answer "where is X" instantly, so no session
> re-explores the tree to get oriented.
>
> **Maintenance rules:** (1) any structural change — app/module/screen/table/route
> added, moved, or renamed — updates this file **in the same commit**; (2) keep it
> an index, under ~200 lines — area detail belongs in `.claude/rules/<area>.md`
> (path-scoped, loads only when touching that area) and in `docs/*.md`;
> (3) `PROJECT_GUIDE.md` is superseded by this file. Verified: 2026-07-31.

## The three engines

Code runs in three places. Every change must go to the right one.

| Engine | Code | Deploys | Notes |
|---|---|---|---|
| Frontend (Next.js, app router) | `src/` | **Vercel** — auto on push to `main`, serves app.smrtesy.com | Verify deploys via `/api/deploy-info` (returns `commit_short`) |
| Backend (Express) | `server/` | **Railway** — auto on push to `main`, starts `node dist/index.js` | Hosts cron jobs, machine endpoints, and the in-app Claude console runner |
| Edge Functions (Deno) | `supabase/functions/` | **GitHub Action** `.github/workflows/deploy-supabase.yml` — auto on push to `main` | Never import from `https://esm.sh/...` (see `.claude/rules/edge-functions.md`) |

Shared: **Supabase** = Postgres DB + auth. Migrations in `supabase/migrations/`
(forward-only, 250+ files). Secrets exist **twice** — Railway env for `server/`,
Supabase secrets for edge functions; rotating a key means updating both. Some
runtime secrets also live in the DB (`app_secrets`, edited at
`/admin/apps/<slug>/secrets`, env-var fallback).

## The apps

Registry: `src/lib/apps/registry.ts` (`APPS`). Per app the same three homes —
route group `src/app/[locale]/(app)/(<slug>)/…`, components
`src/components/<slug>/`, server module `server/src/modules/<slug>/`.

| App | Screens (route group) | What it is |
|---|---|---|
| smrttask | `/tasks`, `/calendar`, `/projects`, `/log`, `/whatsapp`, `/sms`, `/daily-report`, `/day-tools`, `/knowledge`, `/transcription-experiment` | Core: AI task extraction from Gmail/WhatsApp/Drive/Calendar/SMS |
| smrtcrm | `/crm` | CRM |
| smrtreach | `/reach` | Outreach/campaigns |
| smrtbot | `/bots` | Bots (web bot at `src/app/api/bot/web/[key]`) |
| smrtplan | `/plan` | Planning engine (plans, dependency matrix, experiments) |
| smrtvault | `/vault` | Vault |
| smrtinfo | `/info` | Info extraction center |
| smrtstudio | `/studio` (console), `/studio/projects` (+`/[id]` — voice/image/video tabs), `/studio/models`, `/studio/research`; plus the absorbed voice screens at `/voice/*` (deep URLs kept; `/voice` itself redirects to `/studio/projects`) | Content studio — build plan: `docs/studio-build-plan.md`. **smrtVoice was absorbed here** (stage G, 2026-07-30): entitlement is smrtstudio (migration `20260730190000`), voice code still lives in `(smrtvoice)` route group / `components/smrtvoice/` / `modules/smrtvoice/`, settings+lexicon under `/settings/apps/smrtstudio` |

**Platform (cross-app), route group `(platform)`:** `/inbox` (notifications),
`/suggestions`, `/settings`, `/account`, `/admin`, `/search` (global content
search — components `src/components/platform/search/`, server
`server/src/modules/platform/search/`, detail in `docs/global-search-plan.md`),
and **`/claude`** — the in-app Claude console (components
`src/components/claude/`, server `server/src/modules/claude/`, detail in
`.claude/rules/claude-console.md`). Server side:
`server/src/modules/platform/` (organizations, members, me, messaging, push,
apps, search) and `server/src/modules/admin/`.

## Server layout (`server/src/`)

- `index.ts` — mounts everything under `/api`. Order matters: webhook/public/
  machine routers (cron-secret gated, e.g. `claude-session`, jobs routers) come
  **before** the auth-guarded app routers.
- `middleware/` — `requireAuth`, `requireOrg` (`org-context`), `requireApp`,
  `requireRole`, `requireSuperAdmin`, `rate-limit`. Every tenant-data route uses
  `requireAuth + requireOrg + requireApp("<slug>")`.
- `modules/<app>/` — the app backends. Biggest: `smrttask/` (`tasks/`,
  `projects/`, `parts/` = collector pipeline, `corrections/`, `daily-report/`,
  `marathon/`, `reminders/`, `routes/`), and `claude/` (the console engine).
- `apps/<slug>/manifest.ts` — the inter-app event bus: each manifest declares
  `emits` / `subscribes` (+ handlers like `on-task-completed.ts`) and which
  entities it reads/writes. Types in `lib/platform/`.
- `services/` — Google integrations (`gmail`, `calendar`, `drive`, `sheets`),
  `token-refresh`, `voyage` (embeddings).
- `anthropic.ts` / `gemini.ts` — paid-API LLM clients (cost-approval rule
  applies). The Claude console instead runs on the **subscription** via
  `CLAUDE_CODE_OAUTH_TOKEN` — zero paid tokens.
- `prompts/`, `scripts/`, `lib/` (`user-context`, `knowledge`, `prompt-loader`,
  `ttl-cache`, `meta-errors`).
- Build: `npm run build` = `tsc` → `dist/`; dev = `tsx watch src/index.ts`.

## Frontend layout (`src/`)

- `app/[locale]/(app)/…` — all signed-in screens (Hebrew default, RTL). `(auth)`
  = login/invite; `onboarding/` = first-run flow; `app/api/` = Next API routes
  (Google OAuth callbacks, `deploy-info`, web-bot, icons).
- `components/<app>/`, `components/platform/` (layout, sidebar, inbox),
  `components/claude/` (console UI), `components/ui/` (shared primitives).
- `lib/api/client.ts` — **the** way frontend calls the backend (`api()`
  auto-attaches `Authorization` + `X-Org-Id`; raw `fetch("/api/…")` is a bug).
- `lib/panes/` — the tabs-workspace pane system (`registry.tsx`, `nav.tsx`).
  Hard rules for any screen work: `.claude/rules/panes.md`.
- `lib/supabase/` — clients incl. `admin.ts` (`createAdminSupabaseClient()`).
- `lib/apps/registry.ts` — app registry; `lib/ai-usage`, `lib/smrtplan`,
  `lib/smrttask`, `lib/email`, `lib/media`, `hebcal.ts`, `workdays.ts`.
- `messages/he.json` + `messages/en.json` — every user-visible string, both
  files in the same commit.
- Build: `npm run build` (Next build + ESLint + types — same pipeline as Vercel).

## Edge functions (`supabase/functions/`)

`gmail-sync`, `gmail-reconcile`, `initial-scan`, `batch-details`, `drive-sync`,
`calendar-webhook`, `calendar-renew-watch`, `ai-process` (classifier/summary —
its hardcoded prompts are the source of truth when `ai_prompts` is empty),
`quick-action`, `create-gmail-draft`, `project-detection`, `reminders-check`;
shared code in `_shared/`.

## Database — the tables you'll touch most

Orgs/entitlements: `organizations`, `app_memberships`, `user_settings`,
`user_credentials`, `app_secrets`. Pipeline: `source_messages` (raw ingest) →
`tasks` (+ `task_activities`) → `projects` / `reminders` / `contacts`.
Rules & AI: `rules_memory` (skip rules — parser lives in
`server/src/modules/smrttask/lib/rule-filters.ts` with a Deno twin in
`supabase/functions/_shared/rule-filters.ts`; the two must stay in sync),
`ai_prompts`, `log_entries`, `run_sessions`, `sync_state`, `sync_schedules`.
Global search: `search_documents` (unified pgvector index over destinations/
tasks/info/claude threads; `match_search_documents` hybrid RPC) +
`search_index_queue` (DB triggers enqueue changed rows; a pg_cron→
`/api/search/index/drain` worker keeps the index fresh) —
`server/src/modules/platform/search/`.
Claude console: 13 `claude_*` tables (threads/runs/events/instructions/
playbooks/… — listed in `.claude/rules/claude-console.md`). For any table's
authoritative shape, read its migration: `grep -rn "<table>" supabase/migrations/`
(the oldest tables predate the migrations dir — e.g. `task_activities`,
`user_credentials` have no CREATE there; check the live schema for those).

## Where is what — quick nav

| Need | Go to |
|---|---|
| A screen's page | `src/app/[locale]/(app)/(<app>)/<screen>/page.tsx` |
| Pane registration | `src/lib/panes/registry.tsx` |
| Backend endpoint of app X | `server/src/modules/<x>/` (mounted in `server/src/index.ts`) |
| Auth/org/app gating | `server/src/middleware/` |
| Inter-app events | `server/src/apps/<slug>/manifest.ts` |
| Translations | `src/messages/{he,en}.json` |
| Table definition | `supabase/migrations/` (grep the table name) |
| Admin panel | `src/components/admin/`, `/admin/apps/<slug>` |
| Claude console | `server/src/modules/claude/` + `src/components/claude/` |
| Session Stop-hook → smrtTask proposal | `.claude/hooks/` + `server/src/modules/smrttask/routes/claude-session.ts` |

## Deep-dive docs (read on demand)

`docs/router-panes-plan.md` (panes), `docs/claude-console/` (console plan,
feasibility, standing instructions), `docs/platform-integration.md` +
`docs/new-app-guide.md` (adding an app), `docs/tasks-unification-spec.md`,
`docs/smrtplan-overview.md` + roadmap, `docs/info-center-plan.md`,
`docs/pre-push-protocol.md`, `docs/claude-knowledge-center-plan.md` (this
mechanism's design and rationale).
