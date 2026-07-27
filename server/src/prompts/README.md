# Where do the AI prompts live?

**The message-classification and task-builder prompts do NOT live here.**
Classification runs entirely in the Supabase edge function — the live prompts
are hardcoded in `supabase/functions/ai-process/index.ts`:

- Classifier (`analyzeWithMemory` static prompt) — admin-overridable via the
  `ai_prompts` row `edge_classifier`.
- Task builder (`createTasksFromMessage` static prompt) — overridable via
  `edge_task_builder`.
- WhatsApp / Drive / sent-mail rule blocks — code-only, appended after any
  override so tenants can't break them.

Two dead files (`classifier.ts`, `whatsapp.ts`) that once held a server-side
classifier were removed in July 2026 — Part 3 was deleted from the server and
classification moved to the edge (see `server/src/modules/smrttask/index.ts`).
Full background: `docs/classifier-review-2026-07.md`.

This directory keeps only prompts the **Express server** actually imports
(currently `info-extract.ts` for smrtInfo). Before adding a prompt here, make
sure the caller really runs on the server and not in an edge function.
