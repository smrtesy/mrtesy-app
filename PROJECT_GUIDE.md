# SmrTesy — Project Guide & Agent Working Rules

A plain-English overview of what the app does, how its pieces fit together, what an AI coding agent (Claude) is expected to do on this project, and the rules it must follow. Written so a non-technical owner and a working developer can both read it.

---

## 1. What SmrTesy Is

SmrTesy is a **personal AI assistant for email, WhatsApp, calendar and files**. It pulls information from Google services and a WhatsApp log, uses Claude (an AI from Anthropic) to figure out what actually requires the user's attention, and turns those into **tasks, reminders and suggestions** the user can act on.

The product is bilingual (Hebrew + English, RTL/LTR). The current target user is Chanoch (`chanoch@maor.org` / `chanoch@kinus.info`).

The web app lives at **https://app.smrtesy.com**.

---

## 2. The Big Picture (the three "engines")

There are **three separate places where code runs**. Anything we change has to go to the right engine.

| Engine | What it is | What it does | Where it's deployed |
|--------|------------|--------------|---------------------|
| **Frontend** | A Next.js website (the pages users actually see) | Login, tasks, projects, suggestions, calendar, settings, admin panel | **Vercel**, served at app.smrtesy.com. Auto-deploys when `main` is pushed on GitHub. |
| **Server (Backend)** | A small Node.js/Express service (`/server` folder) | Background jobs (every 15 min): pulls new emails, drive files, calendar events, WhatsApp messages; classifies them with AI; handles "Run AI action" buttons | **Railway**. Auto-deploys when `main` is pushed on GitHub. |
| **Edge Functions** | Small serverless functions written in Deno (`/supabase/functions`) | Real-time work the website calls directly: fetch incremental Gmail updates, run a quick AI summary, send a draft, etc. | **Supabase**. **Does NOT auto-deploy from GitHub** — must be deployed with `supabase functions deploy <name>`. |

Plus one shared service:

- **Supabase** — the database (PostgreSQL) and the user login system. Both engines above read/write here. Settings like API keys for the Edge Functions also live in Supabase Secrets, **not** in Railway.

This is the most common confusion on this project: the **same kind of secret (e.g. `ANTHROPIC_API_KEY`) exists in TWO places** — once in Railway (used by the server) and once in Supabase (used by the Edge Functions). Updating one does not update the other.

---

## 3. The Pages (what the user sees)

All URLs live under `/he/...` (Hebrew) or `/en/...` (English).

| Page | URL | What happens here |
|------|-----|-------------------|
| Login | `/login` | Google sign-in. |
| Onboarding | `/onboarding`, `/onboarding/setup`, `/onboarding/drive`, `/onboarding/whatsapp` | First-time setup — connect Gmail/Calendar, choose Drive folder, link WhatsApp sheet. Triggers an "initial scan" of past 30 days of email. |
| Tasks (Inbox) | `/tasks` | The main screen. Shows tasks the AI extracted from messages: Inbox / Active / Completed tabs. Click a task to see details, AI summary, the original email, "AI Quick Action" buttons. |
| Suggestions | `/suggestions` | Three tabs: scheduled reminders, project suggestions, message suggestions. The user approves/dismisses each. |
| Projects | `/projects`, `/projects/[id]` | Group tasks into projects. Each project has a "brief" (purpose, contacts, weekly workflow). |
| Calendar | `/calendar` | Calendar view of tasks and events. |
| Log | `/log` | Activity log (what the AI did, when, cost in $). |
| Settings | `/settings` | Connection status (Gmail/Drive/WhatsApp/Calendar), AI model preferences, daily AI budget, reminder channels, language. |
| **Admin** (only for emails listed in `ADMIN_EMAIL`) | `/admin` | |
| Admin → Rules | `/admin/rules` | **The single source of truth for filter rules** (skip senders, skip recipients, etc.) — see §5. |
| Admin → Prompts | `/admin/prompts` | Edit AI system prompts used by the classifier. |
| Admin → Sync | `/admin/sync` | Manually trigger Part 1/2/3 jobs, see schedules. |
| Admin → Logs | `/admin/logs` | Detailed run history. |
| Admin → Services | `/admin/services` | Health/status of integrations. |
| Admin → Users | `/admin/users`, `/admin/users/[id]` | List and inspect users. |

---

## 4. The Server Jobs (what runs in the background)

The `/server` folder is the Railway backend. It runs four "parts":

| Part | File | What it does | When it runs |
|------|------|--------------|---------------|
| Part 0 | `parts/part0-style.ts` | Learns the user's writing style (so AI replies sound like them). | One-off, on demand. |
| **Part 1** | `parts/part1-collector.ts` | Pulls new emails (from `chanoch@maor.org` and `chanoch@kinus.info`), new files in the watched Drive folder, and new calendar events. Writes them to the `source_messages` table marked `pending`. | Every ~8 hours via cron, or manually from `/admin/sync`. |
| **Part 2** | `parts/part2-whatsapp.ts` | Pulls new WhatsApp messages from a Google Sheet (the WhatsApp Sheet is `WHATSAPP_SHEET_ID` env var), classifies them. | Every ~8 hours. |
| **Part 3** | `parts/part3-classifier.ts` | Takes everything in `source_messages` that's still `pending` and runs Claude on it: is this ACTIONABLE / INFORMATIONAL / NOISE? If actionable, creates a `task` row. If a clear pattern emerges, suggests a new rule for `rules_memory`. | Every ~8 hours. |

**Two HTTP endpoints** the website calls live on this server:
- `POST /api/sync/part0|part1|part2|part3` — manual trigger from `/admin/sync`.
- `POST /api/actions/execute` — runs a "Quick Action" button on a task (e.g. "draft a reply").

---

## 5. The Edge Functions (Supabase serverless)

These are smaller pieces that run **near the user**, called directly by the browser. They do not run on a cron — they fire when something happens.

| Function | What triggers it | What it does |
|----------|------------------|--------------|
| `gmail-sync` | Gmail push notification (or scheduled) | Incremental Gmail fetch — only the messages changed since the last `historyId`. |
| `gmail-reconcile` | Called when `gmail-sync` reports its history pointer expired | Full re-scan to recover. |
| `initial-scan` | First-time onboarding | Pulls 30 days of Gmail message IDs into `source_messages`. |
| `batch-details` | After `initial-scan` finished | Fills in subject/body/sender for the IDs `initial-scan` saved. |
| `drive-sync` | Drive push notification | Incremental Drive folder fetch. |
| `calendar-webhook` | Google Calendar push notification | Records calendar changes. |
| `calendar-renew-watch` | Cron | Renews the Google Calendar webhook subscription before it expires. |
| `ai-process` | Frontend, after a new task lands | AI summary / suggested actions for a single task. |
| `quick-action` | Frontend "Quick Action" button | Calls Claude with a custom prompt against a task or free text (also used by the "+" smart task input). |
| `create-gmail-draft` | Frontend "Draft reply" button | Creates a draft in the user's Gmail. |
| `project-detection` | After tasks accumulate | Looks at recent tasks, suggests grouping them into a project. |
| `reminders-check` | Cron (every minute) | Sends reminders that are due. |
| `whatsapp` | WhatsApp webhook | Verifies and ingests WhatsApp webhook events. |

---

## 6. The Database (Supabase / PostgreSQL)

These are the tables. Everything important lives here.

| Table | What it stores |
|-------|----------------|
| `auth.users` | Login accounts (managed by Supabase auth, not by us). |
| `user_settings` | Per-user preferences: which integrations are connected, AI model choice, daily budget, reminder channels, timezone. |
| `user_credentials` | Google OAuth tokens (refresh + access). |
| `source_messages` | **Raw inbox** — every email/Drive file/calendar event/WhatsApp message we've pulled. AI classification happens against rows here. |
| `tasks` | The actionable items the user sees on the Tasks page. Each links back to a `source_message`. |
| `task_activities` | Per-task activity log. |
| `action_history` | History of "Quick Action" runs (for cost tracking). |
| `projects` | Project groupings. |
| `project_briefs` | The "brief" doc per project. |
| `project_credentials` | Per-project secrets (e.g., a separate Gmail account). |
| `contacts` | People extracted from messages. |
| `reminders` | Scheduled reminders. |
| **`rules_memory`** | **Filter rules — the single source of truth for "skip this sender", "skip emails to office@maor.org", etc.** Editable from `/admin/rules`. Read by Part 1 and by the `gmail-sync` / `initial-scan` Edge Functions. |
| `ai_prompts` | Editable system prompts for AI calls. Editable from `/admin/prompts`. |
| `log_entries` | Application log (errors, AI calls, costs). |
| `run_sessions` | Each Part 1/2/3 run gets a row here with stats (items processed, errors, cost). |
| `sync_state` | Sync checkpoints per source ("last historyId", "last synced at"). |
| `sync_schedules` | When each part should run next. |

⚠️ Cleanup note: `user_settings` has dead columns `skip_senders`, `skip_recipients`, `office_addresses` from an older design. They are in the schema but **no code reads or writes them**. All filter logic now goes through `rules_memory`. They should eventually be dropped.

---

## 7. The Filter Rules System

Because this caused real bugs, it gets its own section.

**Goal:** every place that ingests messages must respect the same skip rules. The rules must be visible and editable in the admin UI — never hidden in the code.

**Where the rules live:** `rules_memory` table, one row per rule per user.
**Where the rules are edited:** `/admin/rules` (Filter Rules page).
**Where the rules are read:**
1. `server/src/parts/part1-collector.ts` (Railway)
2. `supabase/functions/gmail-sync/index.ts` (Edge Function)
3. `supabase/functions/initial-scan/index.ts` (Edge Function)

**Trigger formats supported:** `from=email@x.com`, `sender=email@x.com` (alias), `to=email@x.com`, `domain=x.com`. The shared parser is in `server/src/lib/rule-filters.ts` (Node copy) and `supabase/functions/_shared/rule-filters.ts` (Deno copy — must stay in sync). It outputs both Gmail query filters (e.g. `-to:office@maor.org`) and a `shouldSkip(msg)` predicate for cases where Gmail's API doesn't accept a query (e.g. history-API incremental fetches).

**Rule of thumb:** if you want to add a new place where messages are read, **load `rules_memory` first and apply the skip filter**. Never hardcode an email address into the code. If a rule is hardcoded somewhere and you find it, move it to the database and delete it from code.

---

## 8. Who's Responsible — The Agent's Role

The agent is Claude (this conversation). The agent's job is:

1. **Diagnose problems** the owner reports (a 401, a 502, a wrong rule, a missing button).
2. **Find the actual root cause** by reading code, querying Supabase, fetching logs — not by guessing.
3. **Propose a plan** in plain Hebrew before touching anything risky (deletions, secret rotations, cross-engine changes).
4. **Implement the fix** end-to-end, including:
   - Code changes in the right engine (frontend / server / edge function).
   - Database changes if needed (seed rows, migrations).
   - Edge Function deploy via Supabase CLI (this is **not** automatic).
   - Commit & push to `main` (Vercel + Railway will auto-deploy from there).
5. **Verify** the fix actually worked — open the production URL and test, check logs, run the failing scenario again.
6. **Report** what was done and what the owner still needs to do (e.g., set an env var on Railway, click Redeploy).

The agent is **not** responsible for:
- Adding features the owner didn't ask for.
- Refactoring code that wasn't part of the bug.
- Touching shared infrastructure (rotating production secrets, force-pushing) without explicit permission.

---

## 9. The Two Working Rules (set by the owner)

These are the agent's standing instructions for this project. They override defaults.

### Rule 1 — All changes go to `main`
Every commit lands directly on `main` (the production branch on GitHub). Vercel deploys the frontend from `main` and Railway deploys the server from `main`. There are no feature branches in normal flow. The agent does **not** open pull requests unless the owner asks for one.

### Rule 2 — Verify before claiming "done"
The agent never says "fixed" without proof. After making a change, the agent must:
1. Type-check passes (`tsc --noEmit`).
2. The change deploys (or the agent deploys it, in the case of Edge Functions).
3. The agent opens the relevant page or hits the relevant endpoint themselves, reproduces the original failing scenario, and confirms it now works.
4. **Only then** does the agent tell the owner "done" — together with the evidence (HTTP status, screenshot, log line, etc.).

If verification is not possible from the agent's side (e.g., requires a logged-in browser session the agent doesn't have), the agent must say so explicitly and tell the owner exactly what to click to verify.

---

## 10. Standing Rules for the Developer (and the Agent)

These are derived from `DEVELOPMENT_WORKFLOW.md`. They apply to anyone touching this codebase.

1. **One source of truth.** If a config / rule / prompt is editable from the admin UI, it lives in the database. It does not live in the code. If you find a hardcoded value that ought to be configurable, move it to the database.

2. **Two-engine awareness.** Before changing anything related to Gmail, AI, or user secrets, ask: does this affect both the Railway server and the Supabase Edge Functions? If yes, change both — they have separate codebases and separate deploys.

3. **Edge Functions need a manual deploy.** `git push` does not deploy them. After editing anything in `supabase/functions/`, run `supabase functions deploy <name> --project-ref exjnlghuzuvqedlltztz`.

4. **Secrets live in two places.**
   - Railway env vars → used by `/server`.
   - Supabase Secrets → used by Edge Functions.
   When rotating any key (Anthropic, Google, etc.), update **both** places.

5. **Don't bypass checks.** No `--no-verify` on commits, no `git push --force` to `main`, no skipping types. If a check fails, fix the cause.

6. **Hebrew-first UI.** Default locale is `he`. Every new user-facing string must be added to **both** `messages/he.json` and `messages/en.json` and accessed via the `t()` function — never hardcoded.

7. **Cost-aware AI.** Every Claude API call should respect the user's `daily_ai_budget_usd`. Use the `cachedCall` helper (`server/src/anthropic.ts`) for repeated prompts so the system prompt + rules are cached.

8. **Type safety.** `npx tsc --noEmit` from `/server` and from project root must be clean before commit.

9. **Document deviations.** If you must deviate from these rules (e.g., temporarily hardcode a value), leave a `// TODO:` with a one-line reason.

---

## 11. Common Failure Modes (and where to look)

| Symptom | First place to look |
|---------|---------------------|
| `401 invalid x-api-key` from Claude | `ANTHROPIC_API_KEY` in **Supabase Secrets** (used by Edge Functions) — and separately in **Railway env** (used by server). |
| Browser CORS error to Railway | `FRONTEND_URL` env on Railway. Format: comma-separated list of allowed origins. |
| Railway returns 502 with `x-railway-fallback: true` | Container is failing to start. Check Railway **Deploy Logs** (not Build Logs). Common causes: missing env var, wrong port, build pruned `tsc` (see commit `227d6bd` for the fix). |
| Railway not picking up new commits | Service Settings → Source → branch must be set to `main`, "Auto deploy" enabled. |
| Edge Function changes don't take effect | They were not deployed — Edge Functions don't auto-deploy from GitHub. |
| A skip rule is being ignored | Check three places: `rules_memory` (is the row there, `is_active=true`?), `gmail-sync` deployed version, `initial-scan` deployed version. All three read the same rules but from independently deployed code. |
| AI cost spiked | Check `log_entries` and `run_sessions` — usually a prompt change increased the input size. |

---

## 12. How to Read This Repo

- `/src` — the Next.js frontend. Pages live in `src/app/[locale]/...`.
- `/server` — the Railway Express backend. Cron jobs in `parts/`, HTTP endpoints in `routes/`, AI client in `anthropic.ts`.
- `/supabase/functions` — the Edge Functions (Deno). Each folder is one function. `_shared/` holds code reused across them.
- `/supabase/migrations` — schema changes (forward-only).
- `messages/he.json`, `messages/en.json` — translations.
- `DEVELOPMENT_WORKFLOW.md` — original working rules.
- `QA_PROMPT.md` — the QA checklist to run after a change or before release.
- `PROJECT_GUIDE.md` — this file.

---

*Last updated: 2026-05-06. Edit this file when major architecture changes happen.*
