-- Link a task to the in-app Claude console thread that is working on it.
--
-- The task-detail "עבודה עם קלוד" launcher used to open the EXTERNAL claude.ai
-- in a popup and rely on copy/paste. It now opens a NEW thread in the built-in
-- console (server/src/modules/claude) seeded with the task's context, and the
-- task carries the thread id so the UI can render a "בתהליך עם קלוד" badge that
-- deep-links straight back to that open chat.
--
-- Additive + reversible (ADD COLUMN, nullable, ON DELETE SET NULL) — applied via
-- the Supabase Management API query endpoint, never `supabase db push`.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS claude_thread_id uuid
    REFERENCES public.claude_threads(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tasks.claude_thread_id IS
  'The in-app Claude console thread currently working on this task (set when the '
  'user taps "עבודה עם קלוד"). NULL = no active Claude chat. Cleared automatically '
  'if the thread is deleted (ON DELETE SET NULL).';
