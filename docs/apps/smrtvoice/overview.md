# smrtVoice — Overview

**Slug:** `smrtvoice`
**User guide:** `/voice/guide`

smrtVoice is a voice-generation app. Users define characters and voice
profiles, build projects from scripts, and generate audio line-by-line
through an external voice-engine (a separate Python service).

## What it does

- Manages characters, voice profiles, voice samples and a pronunciation
  lexicon (the `smrtvoice_*` tables).
- Builds projects from imported scripts and queues generation jobs.
- Calls the external voice-engine over HTTP (`VoiceEngineClient`) and
  receives HMAC-signed webhooks back when audio is ready.

## Admin surfaces (this app's detail page)

- **Prompts** — the AI prompts for this app.
- **Secrets** — **read-only**. The voice-engine keys (`VOICE_ENGINE_URL`,
  `VOICE_ENGINE_API_KEY`, `VOICE_ENGINE_WEBHOOK_SECRET`) are environment
  variables shared with the external Python voice-engine. They are surfaced
  here only as set/missing indicators; they must be edited in the hosting
  environment (e.g. Vercel) so both services stay in sync. Editing them from
  the admin UI would desync the two services and break auth/webhooks.
- **Documents** — this page.

This app does **not** show the Services, Parameters or WhatsApp-secret cards —
those are smrtTask-specific.

## Conventions

Add this app's design/spec docs as markdown files in this folder
(`docs/apps/smrtvoice/`). They render automatically on the Documents card.
