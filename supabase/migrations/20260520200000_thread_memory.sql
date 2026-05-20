-- thread_memory: per-thread (Gmail threadId / WhatsApp chatId) persistent summary.
-- Lets ai-process feed Haiku/Sonnet just the running summary instead of the full
-- history every time. The AI updates the summary after each message it processes.

CREATE TABLE IF NOT EXISTS thread_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_key      text NOT NULL,           -- "gmail:<threadId>" / "whatsapp:<chatId>"
  summary         text NOT NULL DEFAULT '',
  state           text NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','pending_user_action','pending_other_party','resolved')),
  related_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  last_message_id uuid REFERENCES source_messages(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, thread_key)
);

CREATE INDEX IF NOT EXISTS idx_thread_memory_user_key ON thread_memory (user_id, thread_key);
CREATE INDEX IF NOT EXISTS idx_thread_memory_task     ON thread_memory (related_task_id);

ALTER TABLE thread_memory ENABLE ROW LEVEL SECURITY;

-- Self-read for frontend debugging. ai-process uses service_role so it bypasses RLS.
DROP POLICY IF EXISTS thread_memory_self ON thread_memory;
CREATE POLICY thread_memory_self ON thread_memory
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Tasks: track follow-up updates and completion signals from later thread messages.
-- Defaults are conservative: existing tasks behave exactly as before until a
-- follow-up message lands on them.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS has_unread_update          boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS completion_signal_detected boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS completion_signal_reason   text;

CREATE INDEX IF NOT EXISTS idx_tasks_pending_completion
  ON tasks (user_id, status) WHERE status = 'pending_completion';
