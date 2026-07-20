# Developer Onboarding — smrtesy

Welcome. This guide gets you productive in a day or two. It is written for a
developer joining the smrtesy codebase who does **not** yet know the product.
Read it top to bottom once, then keep it open for your first task.

> This is the developer-facing half of the working method. The manager-facing
> half (how work is planned, estimated, and reviewed) lives in
> `docs/developer-collab-protocol.md`.

---

## 1. The system in 60 seconds

smrtesy is a **personal AI assistant** for email, WhatsApp, calendar and files.
It pulls information from Google services and a WhatsApp log, uses Claude to
decide what needs the user's attention, and turns that into tasks, reminders
and suggestions. It is bilingual (Hebrew + English, RTL/LTR).

There are **three engines** — know which one your change touches:

| Engine | What / where | Deploys |
|---|---|---|
| **Frontend** | Next.js web app (the pages users see) | Vercel, on push to `main` |
| **Server** | Node/Express background jobs + AI actions (`/server`) | Railway, on push to `main` |
| **Edge Functions** | Deno serverless (`/supabase/functions`) | Supabase — **manual** `supabase functions deploy` |

Shared: **Supabase** (Postgres + auth). Note the classic trap — the same secret
(e.g. `ANTHROPIC_API_KEY`) exists **twice**: once in Railway, once in Supabase.
Updating one does not update the other.

**Read next:** `PROJECT_GUIDE.md` (the full plain-English architecture) → then
`CLAUDE.md` (the conventions you must follow) → then this file's §4 onward.

## 2. Your language

The repo's default assistant language is Hebrew (the owner's preference). To have
Claude Code answer you in English and write your task cards in English, declare
your operator language once — see `CLAUDE.md` → "Response language". You do not
need to touch anyone else's setup.

## 3. How you get work

- You are given an **ordered backlog** in smrtPlan — a prioritized list. You
  **pull the next task in order**. Nobody assigns you a day-by-day plan; you
  manage your own time, we manage the order.
- Every card is **self-contained**: title (verb + deliverable), definition of
  done, context (why it exists, how it serves the product), materials (every
  link/file you need, as full deep URLs), and a checklist. If a card fails the
  "stranger test" — you'd have to ask a question to start — tell us; that's a
  gap we fix, not something you guess around.
- You will **not** see a time estimate on the card. That is intentional and is
  a private management signal, not a target for you.

## 4. How you work

1. Work in **Claude Code**. It reads `CLAUDE.md` and enforces the repo's
   conventions automatically — i18n keys, the `api()` client, org scoping,
   `requireApp`, admin Supabase client, product naming, etc. Follow what it
   tells you; do not fight the conventions.
2. Build **one thing at a time** and verify it works before moving on
   (`DEVELOPMENT_WORKFLOW.md`).
3. Before **every** PR, run the **pre-push protocol** in `CLAUDE.md` in full:
   real build (`npm install && npm run build`), the targeted greps, and the
   sub-agent code review. The standard is **zero findings** on the first push.
   This is your responsibility — code quality is on your side of the line.

## 5. How your work lands

1. Open a **PR** on GitHub. CI + the pre-push protocol are the code-quality gate.
2. The manager does **not** read code. A **Hebrew product-level summary** of your
   PR is produced for them; they read it and merge.
3. **Core** paths (auth, `api()` client, panes, Supabase admin, migrations)
   require the manager's merge (enforced via CODEOWNERS). **Isolated** app
   changes may be self-mergeable once CI is green.
4. "Done" = **merged to `main` with green CI**, satisfying the definition of done.

## 6. The work clock (required)

- The work clock (`workclock`) is **on** for your account. Clock is tied to the
  task you're working on; actual time per task is recorded.
- **Idle check-in:** after 10 minutes with no activity in smrtTask, a window asks
  "still working?". If you don't answer within 3 minutes, the clock stops
  automatically — so idle time isn't counted as work. This is **not** screen
  monitoring; there are no screenshots.

## 7. Your first task — a walking skeleton

Your first task is a **small, isolated feature end-to-end** (a new/low-risk
`smrt*` area — never core). The point is to learn the whole pipeline on
something low-stakes: pull the task → build in Claude Code → run the pre-push
protocol → open a PR → get it merged. Once that round-trip feels natural, you're
ready for real backlog.

## 8. What you don't touch (yet)

- **Core / shared infrastructure**: `src/lib/api/**`, `src/lib/panes/**`,
  `src/lib/supabase/**`, `supabase/migrations/**`, server middleware. These are
  gated and open up only as we go (staged trust — see the collab protocol §6).
- **Production secrets** and **paid API keys**. You never need them for feature
  work; if a task seems to require one, that's a signal to ask first.
- Direct pushes to `main`. You work through PRs only.

## 9. Access checklist (to be provisioned for you)

- [ ] GitHub access to `smrtesy/mrtesy-app`
- [ ] Claude Code (web and/or CLI)
- [ ] The environment variables your sessions need (provided to you) — **not**
      production secrets or paid API keys
- [ ] Your operator-language declaration set (§2)
- [ ] First walking-skeleton task waiting in the backlog

> Anything unclear or missing on a card? Ask. A question you have to ask to
> start is a gap in the card — surfacing it improves the method for everyone.
