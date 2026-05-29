# smrtTask — Overview

**Slug:** `smrttask`
**User guide:** `/tasks/guide`

smrtTask is a personal task-management system that watches a user's incoming
messages and turns the ones that need action into tracked tasks.

## What it does

- Ingests messages from the user's connected services: Gmail, Google Drive,
  Google Calendar and WhatsApp.
- Runs every incoming message through a classifier (the `edge_classifier`
  prompt, served by the `ai-process` edge function) that decides
  `ACTIONABLE` / `INFORMATIONAL` / `SPAM` and maintains running thread state.
- Creates and updates tasks, with AI-generated descriptions and checklists
  that preserve the original deep links from the source message.

## Admin surfaces (this app's detail page)

- **Services** — per-user sync state for Gmail / Drive / Calendar / WhatsApp.
- **Prompts** — the AI prompts (classifier, project briefs, etc.).
- **Secrets** — platform API keys (Gemini, Meta API version) and per-WABA
  WhatsApp Meta secrets. Stored in `app_secrets` / Supabase Vault and read
  back by the backend via `getAppSecret`.
- **Parameters** — system parameters (models, batch sizes, calendar window,
  body-truncation limits) from `smrttask_system_params`.
- **Documents** — this page.

## Conventions

Add this app's design/spec docs as markdown files in this folder
(`docs/apps/smrttask/`). They render automatically on the Documents card.
