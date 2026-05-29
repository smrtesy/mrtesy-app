# smrtesy — Context Briefing for Building New Apps & Features

**Purpose of this file.** Hand this to Claude (or any developer/AI) *before*
it builds something new in this repo. It describes what smrtesy is, how the
system is actually wired today, what capabilities already exist, and the
conventions any new code must follow so it fits in instead of fighting the
platform.

This is a **context/briefing** doc, not a step-by-step tutorial. For the
build checklist see `docs/new-app-guide.md`; for the cross-app SDK see
`docs/platform-integration.md`; for the working rules see `CLAUDE.md` and
`PROJECT_GUIDE.md`. Where those disagree with this file, **this file is the
current snapshot of reality** — the older ones describe earlier single-tenant
stages.

*Last verified against the codebase: 2026-05-29.*

---

## 1. What smrtesy Is

**smrtesy** is a **multi-tenant platform** that hosts a family of AI-powered
productivity apps. It is no longer a single personal assistant for one user —
it is a platform where **organizations** enable **apps**, and **users** belong
to organizations and get access to whatever apps their org has turned on.

- The platform itself is **smrtesy** (the brand — not subject to the naming
  rule below).
- Each product on it is **`smrt` + an English word**: lowercase `smrt`,
  attached directly, the word in `camelCase` or all-lowercase.
  - Correct: `smrtTask`, `smrtVoice`, `smrtCRM`, `smrtHR`, `smrtMail`
  - Incorrect: `SmartTask`, `smrt-task`, `smrttsk`
- **DB slugs** follow the same pattern, always lowercase: `smrttask`,
  `smrtvoice`, `smrtcrm`.

**Apps live today:**

| App | Slug | What it does |
|---|---|---|
| **smrtTask** | `smrttask` | Pulls email / Drive / Calendar / WhatsApp, uses Claude to decide what needs attention, and turns it into tasks, reminders, projects and suggestions. The original app. |
| **smrtVoice** | `smrtvoice` | Text-to-speech / voice-cloning studio. Manages voice characters, scripts, and audio-generation projects; offloads the actual synthesis to an external Python **voice-engine** service. |

The product is **bilingual** (Hebrew + English, RTL/LTR), **Hebrew-first**
(default locale `he`). Web app: **https://app.smrtesy.com**.

---

## 2. The Runtimes — Where Code Actually Runs

There are **three deploy targets plus two shared services**. Any change has to
go to the right one, and some live in *two* places at once.

| Runtime | What it is | Folder | Deploys |
|---|---|---|---|
| **Frontend** | Next.js (App Router) — every page the user sees | `src/` | **Vercel**, served at app.smrtesy.com. **Auto-deploys on push to `main`.** |
| **Server (backend)** | Node.js / Express API + cron jobs | `server/` | **Railway**. **Auto-deploys on push to `main`.** |
| **Edge Functions** | Deno serverless functions called directly by the browser / by webhooks | `supabase/functions/` | **Supabase**. **Does NOT auto-deploy** — `supabase functions deploy <name> --project-ref exjnlghuzuvqedlltztz`. |

Shared services:

- **Supabase** — PostgreSQL database, auth (login), Storage (audio/media),
  and Edge Function secrets. Both the frontend and server read/write here.
- **voice-engine** — a **separate external Python service** (not in this repo)
  that does the actual voice synthesis for smrtVoice. The server talks to it
  via `VOICE_ENGINE_URL` with a static Bearer token (`VOICE_ENGINE_API_KEY`)
  and receives results back through a signed **webhook** (mounted before auth
  middleware in `server/src/index.ts`).

> **The two-places footgun.** The same secret often exists **twice** —
> `ANTHROPIC_API_KEY` lives in **Railway env** (used by the server) *and* in
> **Supabase Secrets** (used by Edge Functions). Updating one does not update
> the other. Same goes for any Google / model key shared across the server and
> the edge functions.

---

## 3. The Multi-Tenancy Model (read this before any DB work)

This is the spine of the platform. Every piece of user data hangs off it.

```
organizations
  └── org_members            (user ↔ org, with role: owner / admin / member)
        └── app_memberships  (which apps THIS org has enabled)
apps                          (catalog of available apps: smrttask, smrtvoice, ...)
super_admins                  (platform operators — bypass org/app gates)
org_invites                   (pending invitations into an org)
```

Rules that follow from this:

- A user sees an app **only if their org has it enabled** in
  `app_memberships`.
- **Every app-owned table** must have
  `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`,
  `ENABLE ROW LEVEL SECURITY`, and an **org-members RLS policy**.
- App tables are **prefixed with the slug**: `smrtvoice_characters`,
  `smrtvoice_projects`, `smrtcrm_contacts`, …
- **Apps never read each other's tables directly.** Cross-app communication
  goes through the platform SDK (§6).

---

## 4. The Frontend (Next.js)

All URLs live under `/he/...` (Hebrew, default) or `/en/...` (English).

Pages are organized into **route groups** — folders in parentheses that do
**not** appear in the URL. This is how each app's pages stay self-contained:

```
src/app/[locale]/
  (auth)/                  ← login
  onboarding/              ← first-time setup (connect Gmail/Drive/Calendar/WhatsApp, pick folders)
  (app)/
    layout.tsx             ← shells every signed-in page; redirects to /onboarding if not done
    (platform)/            ← platform-level pages (shared across all apps)
    (smrttask)/            ← smrtTask pages
    (smrtvoice)/           ← smrtVoice pages
```

**Platform pages** (`(platform)/`):

| Area | Routes |
|---|---|
| Inbox (unified) | `/inbox` |
| Suggestions | `/suggestions` |
| Account / Settings | `/account`, `/settings`, `/settings/org`, `/settings/platform` |
| Per-app settings | `/settings/apps/[appSlug]` + `…/rules`, `…/sync`, `…/parameters`, `…/drive-folders` |
| Admin (super-admin only) | `/admin`, `/admin/apps/[slug]` (+ `prompts`, `secrets`, `services`, `parameters`), `/admin/orgs/[id]`, `/admin/users/[id]`, `/admin/usage`, `/admin/logs`, `/admin/super-admins`, `/admin/docs` |

**smrtTask pages:** `/tasks` (+ `/tasks/guide`), `/projects/[id]`, `/calendar`,
`/log`, `/whatsapp`, `/transcription-experiment`.

**smrtVoice pages:** `/voice`, `/voice/characters/[id]`,
`/voice/projects/[id]` (+ `/script`, `/audio`, `/new`), `/voice/settings`,
`/voice/guide`.

**Component layout** mirrors the apps:

```
src/components/
  ui/         ← shared primitives (buttons, dialogs — Radix-based)
  platform/   ← layout (Sidebar), org switcher, inbox, onboarding, AppGuideLayout
  admin/      ← super-admin UI
  smrttask/   ← smrtTask components
  smrtvoice/  ← smrtVoice components
```

**Frontend rules (enforced by convention):**

- Frontend → backend **always** through `api()` from `@/lib/api/client.ts`. It
  auto-attaches `Authorization` and `X-Org-Id`. A raw `fetch()` to `/api/*` is
  a bug.
- App components import only from `components/ui/` and `components/platform/` —
  **never from another app's component folder.**
- Every user-visible string goes through `useTranslations()` /
  `getTranslations()` and resolves to a key in **both** `src/messages/he.json`
  and `src/messages/en.json` (added in the same commit). Never
  `locale === "he" ? ... : ...` ternaries.

---

## 5. The Server (Express on Railway)

```
server/src/
  index.ts        ← creates the app, mounts every router, wires CORS + webhooks
  middleware/     ← auth, org-context, require-app, require-role, require-super-admin
  lib/platform/   ← the cross-app SDK: emit, notify, links, registry, types
  lib/            ← email, knowledge, prompt-loader, user-context
  anthropic.ts    ← Claude client (cached calls, budget-aware)
  gemini.ts       ← Gemini client
  routes/         ← top-level routes: quick-action, inbox, messages
  modules/
    platform/     ← orgs, members, me, apps, messaging  (the platform core API)
    admin/        ← super-admin API (apps, logs, orgs, users, invites)
    smrttask/     ← smrtTask module (the pattern to copy)
    smrtvoice/    ← smrtVoice module
  apps/
    smrttask/manifest.ts
    smrtvoice/manifest.ts
```

### Middleware chain — the gate every route passes through

| Middleware | What it does |
|---|---|
| `requireAuth` | Validates the JWT → injects `req.user`. |
| `requireOrg` | Validates `X-Org-Id` → injects `req.org` + `req.member`. |
| `requireRole("owner","admin")` | Blocks members below the given role. |
| `requireApp("slug")` | Checks `app_memberships` → 403 if the org hasn't enabled this app. |
| `requireSuperAdmin` | For `/admin/*` only — checks the `super_admins` table. |

**The standing rule:** every backend route that touches org/tenant data is
`requireAuth → requireOrg → requireApp("<slug>")`. Exceptions: `/admin/*`
uses `requireSuperAdmin`; per-user-no-org routes live under `/api/me/*`;
webhooks (WhatsApp, voice-engine) are mounted **before** auth and verify their
own signatures.

### How routers mount (`server/src/index.ts`)

Order matters — webhooks first (no auth), then platform/admin, then apps:

```
app.use("/api", whatsappWebhookRouter);   // before auth — verifies its own signature
app.use(smrtvoiceWebhookRouter);          // before auth — verifies voice-engine signature
app.use("/api", platformRouter);
app.use("/api", adminRouter);
app.use("/api", smrttaskRouter);
app.use("/api", smrtvoiceRouter);
app.use("/api/quick-action", quickActionRouter);
app.use("/api/inbox", inboxRouter);
app.use("/api/messages", messagesRouter);
```

### smrtTask background jobs (cron "parts")

smrtTask is the app with the heavy ingestion pipeline. Its jobs live in
`server/src/modules/smrttask/parts/`:

| Part | File | What it does |
|---|---|---|
| Part 0 | `part0-style.ts` | Learns the user's writing style so AI replies sound like them. |
| Part 1 | `part1-collector.ts` | Pulls new emails, watched Drive files, calendar events, and WhatsApp messages into `source_messages` (marked `pending`). Applies skip rules. |
| Part 4 | `part4-projects.ts` | Project detection / suggestions. |
| (classifier / router) | `routes/router.ts` | Runs Claude over pending messages: ACTIONABLE / INFORMATIONAL / NOISE; creates `tasks`; suggests new `rules_memory` rules. |

> The old "Part 2 / Part 3 WhatsApp + classifier" split has been refactored —
> WhatsApp now has its own webhook + view routes, and classification runs
> through the router. Don't assume the old part numbering.

### smrtVoice module shape (the cleanest modern example)

```
server/src/modules/smrtvoice/
  index.ts              ← exports the router + webhookRouter
  routes.ts             ← all the API endpoints (characters, projects, lines, jobs)
  types.ts              ← shapes that match the Python voice-engine models
  voice-engine-client.ts← wraps every call smrtesy → voice-engine
  webhook-handler.ts    ← receives signed callbacks from voice-engine
```

---

## 6. The Platform SDK — How Apps Talk to Each Other

Apps **do not** import each other or read each other's tables. Everything flows
through three platform channels: **events**, **notifications/inbox**, and
**entity links**. Import from `@/lib/platform` (frontend) /
`../../lib/platform` (server):

```typescript
import { emitEvent, notify, notifyError, linkEntities } from "../../lib/platform";

// Publish a domain event other apps can react to (and that may trigger a notification per the manifest)
await emitEvent(orgId, "smrtvoice", "audio.ready", "project", projectId, { lines_completed: 12, total_cost_usd: 0.40 });

// Push an item into a user's unified inbox
await notify(orgId, userId, { app_slug: "smrtvoice", type: "success", title: "האודיו מוכן", link: `/voice/projects/${projectId}/audio` });

// Report a technical failure to the org's error handler (owner by default)
await notifyError(orgId, "smrtvoice", { title: "Voice Engine unavailable", body: err.message, link: "/voice/settings" });

// Record a cross-app reference
await linkEntities(orgId, { from: { app: "smrtvoice", entity: "project", id: pid }, to: { app: "smrttask", entity: "task", id: tid }, type: "created_from" });
```

`type` is one of `info | warning | success | action_required`.
`linkEntities` type is one of `related | created_from | blocks | resolves`.

### The App Manifest — the contract that wires it all up

Every app declares **one manifest** at `server/src/apps/<slug>/manifest.ts`,
registered in `server/src/lib/platform/registry.ts`. The platform reads all
manifests at startup and routes events/notifications automatically — no app
needs to know another app exists.

```typescript
// server/src/lib/platform/types.ts (shape)
interface AppManifest {
  slug:  string;
  name:  string;
  emits: string[];                                   // events this app publishes
  subscribes: { event: string; source: string; handler: string }[];  // events it reacts to
  notifications: Record<string, {                    // which emitted events become inbox items
    type: "info" | "warning" | "success" | "action_required";
    title: string | ((p) => string);
    body?: string | ((p) => string);
    link?: string | ((p) => string);
  }>;
  entities: { reads: string[]; writes: string[] };   // shared platform entities (e.g. contacts)
  errors: { default_handler_role: "owner" | "admin"; examples: string[] };
}
```

Routing logic (handled for you): an emitted event → if it has a
`notifications[event]` entry, a row is written to `notifications`; if that
type is `action_required` and the recipient has **smrtTask**, it *also*
becomes a task suggestion. Other apps subscribed to the event get their
handler called in-process.

Four questions to answer before writing a new manifest:
1. What significant domain actions does this app perform? → `emits`
2. Does it need to react to other apps' actions? → `subscribes`
3. Who receives error notifications? → `errors.default_handler_role`
4. Does it create entities that reference other apps'? → `linkEntities()`

---

## 7. The Database (Supabase / PostgreSQL)

Forward-only migrations under `supabase/migrations/`, named
`YYYYMMDDHHMMSS_<slug>.sql`. Confirmed tables, grouped by ownership:

**Platform core**

| Table | Stores |
|---|---|
| `organizations` | The tenants. |
| `org_members` | User ↔ org membership + role. |
| `org_invites` | Pending invitations. |
| `apps` | App catalog (`slug`, `name`, `description`). |
| `app_memberships` | Which apps each org has enabled. |
| `app_status` | Per-app build status (stage / summary / next steps / blockers) shown in `/admin/apps`. |
| `super_admins` | Platform operators. |

**Cross-app plumbing (Platform SDK)**

| Table | Stores |
|---|---|
| `app_events` | The internal event bus (`emitEvent` writes here). |
| `notifications` | The unified inbox (`notify` writes here). |
| `entity_links` | Cross-app references (`linkEntities`). |
| `conversations`, `conversation_members`, `messages` | User-to-user / internal messaging within an org. |

**AI & observability**

| Table | Stores |
|---|---|
| `ai_prompts` | Editable system prompts (admin → prompts). |
| `ai_usage` | AI usage ledger for cost tracking per org/app/call. |
| `action_history` | History of "Quick Action" runs. |
| `router_decisions` | Classifier routing decisions (ACTIONABLE/INFORMATIONAL/NOISE). |
| `run_sessions` | One row per cron-part run with stats + cost. |
| `sync_schedules` | When each part runs next. |
| `knowledge_base` | Org/app knowledge store (vector-searchable). |
| `thread_memory` | Per-thread conversational memory for the classifier. |
| `transcription_experiments` | smrtTask transcription test bench. |

**smrtTask domain** (created in the base/early migrations — verify the live
schema before inserting): `tasks`, `task_merges`, `projects`,
`project_information_items`, `source_messages`, `contacts`, `reminders`,
`rules_memory`, `user_settings`, `user_credentials`, `log_entries`,
`sync_state`, plus WhatsApp: `whatsapp_connections`, `whatsapp_messages`.

**smrtVoice domain** (all `smrtvoice_`-prefixed): `smrtvoice_characters`,
`smrtvoice_voice_profiles`, `smrtvoice_voice_samples`,
`smrtvoice_pronunciation_lexicon`, `smrtvoice_projects`, `smrtvoice_lines`,
`smrtvoice_jobs`, `smrtvoice_settings`.

> Always `list_tables` / read the live schema before inserting. Watch for
> `CHECK` constraints — e.g. `rules_memory.created_by` must be one of
> `('user','claude','system')`; `notifications.type` is constrained to the
> four notification types; `entity_links.link_type` to the four link types.

### Filter rules (`rules_memory`) — the recurring bug magnet

Skip/filter rules are the **single source of truth** in `rules_memory`, edited
from the per-app **rules** settings page, and read in **multiple independently
deployed places** that must stay in sync:

1. `server/src/modules/smrttask/parts/part1-collector.ts` (Railway)
2. `supabase/functions/gmail-sync/index.ts` (Edge)
3. `supabase/functions/initial-scan/index.ts` (Edge)

Shared parser: `server/src/modules/smrttask/lib/rule-filters.ts` (Node) and
`supabase/functions/_shared/rule-filters.ts` (Deno) — **must stay identical.**
Trigger formats: `from=email`, `sender=email` (alias), `to=email`,
`domain=x.com`. Never hardcode an address; if you find one, move it to the DB.

---

## 8. The Edge Functions (Deno on Supabase)

Called directly by the browser or by Google/WhatsApp push, **not** on the
server's cron. Deploy manually.

| Function | Trigger | Does |
|---|---|---|
| `gmail-sync` | Gmail push / schedule | Incremental Gmail fetch since last `historyId`. |
| `gmail-reconcile` | When `gmail-sync`'s history pointer expired | Full re-scan to recover. |
| `initial-scan` | Onboarding | Pulls 30 days of Gmail IDs into `source_messages`. |
| `batch-details` | After `initial-scan` | Fills subject/body/sender for those IDs. |
| `drive-sync` | Drive push | Incremental Drive folder fetch. |
| `calendar-webhook` | Calendar push | Records calendar changes. |
| `calendar-renew-watch` | Cron | Renews the Calendar webhook before expiry. |
| `ai-process` | After a task lands | AI summary / suggested actions for one task. |
| `quick-action` | "Quick Action" button / smart `+` input | Runs Claude with a custom prompt against a task or free text. |
| `create-gmail-draft` | "Draft reply" button | Creates a Gmail draft. |
| `project-detection` | After tasks accumulate | Suggests grouping tasks into a project. |
| `reminders-check` | Cron (every minute) | Sends due reminders. |

> **Edge import rule (bitten us twice):** never `https://esm.sh/...` imports —
> the Deploy action bundles via esm.sh which intermittently 522s and breaks the
> whole deploy. Use Deno-native specifiers: `npm:@supabase/supabase-js@2`,
> `jsr:@supabase/functions-js/edge-runtime.d.ts`, `npm:@anthropic-ai/sdk`,
> `npm:googleapis`.

---

## 9. Capabilities Already Available (reuse, don't rebuild)

Before building, check whether the platform already gives you the piece:

- **Auth, orgs, roles, invites, app enablement** — done. Use the middleware
  chain; never roll your own.
- **Unified inbox + notifications + realtime badge** — `notify()` /
  `notifications` table + the Supabase realtime channel already wired in the
  Sidebar.
- **Cross-app events & entity links** — `emitEvent()` / `linkEntities()`.
- **Error routing to a human** — `notifyError()` → org error handler (owner by
  default, configurable in Manage Org).
- **AI calls** — `server/src/anthropic.ts` (cached, budget-aware) and
  `gemini.ts`. Respect the org/user AI budget; use the cache helper for
  repeated system prompts.
- **AI usage accounting** — write to `ai_usage`; it surfaces in `/admin/usage`.
- **Editable prompts** — `ai_prompts` + `/admin/apps/[slug]/prompts`. Don't
  hardcode a system prompt that an operator should be able to tune.
- **Per-app settings, rules, sync, parameters, secrets** — generic admin/
  settings pages already exist keyed by `appSlug`.
- **Knowledge base** — `knowledge_base` table + `lib/knowledge.ts`.
- **User guide pages** — `AppGuideLayout` component renders a standard guide
  (features / steps / FAQ) at `/<route>/guide`. Every app must ship one.
- **Logging** — write `log_entries` rows on error paths; they appear in
  `/admin/logs`.
- **Google integrations** (Gmail, Drive, Calendar) and **WhatsApp** ingestion —
  already built for smrtTask; reuse the patterns rather than re-implementing
  OAuth.

---

## 10. Hard Conventions Any New Code Must Follow

These come from `CLAUDE.md` and are non-negotiable:

1. **Naming.** `smrt` + English word; slug lowercase; tables `<slug>_`-prefixed.
2. **Org scoping + RLS** on every app table; the middleware chain on every
   route.
3. **`api()` only** from the frontend — no raw `fetch()` to `/api/*`.
4. **i18n in both files** (`he.json` + `en.json`), every string via `t()`.
5. **Destructure `{ error }`** on every Supabase `insert/update/upsert` and
   handle it — silent CHECK/RLS failures are the classic bug here.
6. **Service-role Supabase** only via `createAdminSupabaseClient()` /
   `server/src/db.ts` — never `createClient` with the service key inline in a
   page/component.
7. **Preserve deep links verbatim.** Any AI-generated user-facing text that
   references something the user linked to must emit the **exact** deep URL
   (query params, message/doc IDs, fragments) — never paraphrase down to a
   domain. Add a "preserve URLs verbatim" clause to every new AI system prompt.
8. **Gmail queries** include `in:inbox` unless there's a documented reason to
   scan other labels.
9. **Drive scanning is opt-in** — if no folder is configured, return `[]`;
   never fall back to a hardcoded folder ID.
10. **Edge functions:** no `esm.sh` imports (see §8).
11. **Migrations:** numbered, forward-only, `YYYYMMDDHHMMSS_<slug>.sql`. Don't
    apply to production without explicit authorization.
12. **Pre-push protocol** (`CLAUDE.md`): real `npm run build`, targeted greps,
    sub-agent review, app-status update — *before* the push, not after the bot
    finds the bug.

---

## 11. To Build a New App — the Short Version

Full checklist: `docs/new-app-guide.md`. The skeleton:

1. **DB:** `INSERT INTO apps` (slug, name, description) → create
   `<slug>_*` tables with `org_id`, RLS, org-members policy.
2. **Server module:** `server/src/modules/<slug>/` (routes + index), every
   route `requireAuth → requireOrg → requireApp("<slug>")`; mount it in
   `server/src/index.ts`.
3. **Manifest:** `server/src/apps/<slug>/manifest.ts`, registered in
   `lib/platform/registry.ts`.
4. **Frontend:** route group `src/app/[locale]/(app)/(<slug>)/`, components in
   `src/components/<slug>/`, i18n namespace in both message files, Sidebar nav
   entry gated by `appSlug`, a `/<route>/guide` page via `AppGuideLayout`.
5. **Enable** the app for an org (`app_memberships`).
6. **Status + logging:** init `app_status` via
   `PATCH /api/admin/apps/<slug>/status`; write `log_entries` on errors.
7. **Pre-push protocol**, then push to `main`.

**Import isolation rule:** app code imports only from `../../db`,
`../../middleware`, `../../lib/platform`, `components/ui/`, `components/platform/`
— **never** from another app. This keeps each app extractable into its own repo
(`modules/<slug>` + `apps/<slug>` + `app/(<slug>)` + `components/<slug>`).

---

## 12. Quick Failure-Mode Map

| Symptom | First place to look |
|---|---|
| `401 invalid x-api-key` from Claude | `ANTHROPIC_API_KEY` — in **both** Supabase Secrets (edge) and Railway env (server). |
| CORS error to the backend | `FRONTEND_URL` on Railway (comma-separated allowed origins). |
| Railway 502 / `x-railway-fallback: true` | Container failing to start — check Railway **Deploy** logs (missing env var, wrong port). |
| Edge Function change had no effect | It wasn't deployed — edge functions don't auto-deploy from GitHub. |
| A skip rule is ignored | Check `rules_memory` (`is_active`?) **and** the deployed `gmail-sync` / `initial-scan` versions — three independently deployed readers. |
| 403 on an app route | Org hasn't enabled the app (`app_memberships`) — `requireApp` blocked it. |
| smrtVoice job never returns | `VOICE_ENGINE_URL` / `VOICE_ENGINE_API_KEY` on Railway, or the voice-engine webhook signature mismatch. |
| AI cost spiked | `ai_usage` + `run_sessions` — usually a prompt change grew the input. |

---

*Keep this file current. When the architecture shifts — a new runtime, a new
shared table, a new app, a changed middleware chain — update the relevant
section and bump the "Last verified" date at the top.*
