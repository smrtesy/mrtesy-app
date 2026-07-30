---
paths:
  - "server/src/modules/smrttask/**"
---

# smrtTask server module — structure

`server/src/modules/smrttask/` is the platform's core app backend:

- `parts/` — the collector pipeline (`part0-style`, `part1-collector`,
  `part4-projects`). Part 1 pulls Gmail/Drive/Calendar into `source_messages`;
  classification lives in the `ai-process` edge function (its hardcoded prompts
  are the source of truth when the `ai_prompts` table is empty).
- `tasks/` — task CRUD + skip-rules; the Node skip-rule parser is
  `lib/rule-filters.ts` **in this module** (Deno twin:
  `supabase/functions/_shared/rule-filters.ts` — keep in sync).
- `routes/` — `router.ts`, `sync.ts`, `actions.ts`, `events.ts`, `sms.ts`,
  `whatsapp-view.ts`, `knowledge.ts`, `transcription-experiment.ts`, and
  `claude-session.ts` — the machine endpoint (`x-cron-secret` gated) that the
  Claude Code Stop hook posts session proposals to.
- `corrections/` — corrections triage (triage, execute, golden, jobs).
- `daily-report/`, `marathon/`, `reminders/`, `projects/`.

Conventions that bite here: every tenant route needs
`requireAuth + requireOrg + requireApp("smrttask")`; always destructure
`{ error }` from Supabase writes; `rules_memory.created_by` must be one of
`('user','claude','system')`; Gmail queries include `in:inbox`.
