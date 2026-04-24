-- Migration: Backend Pipeline Tables + Task Extensions
-- Apply in Supabase SQL editor. Safe to run multiple times (IF NOT EXISTS guards).

-- ============================================================
-- 1. EXTEND tasks TABLE
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS due_time         text,
  ADD COLUMN IF NOT EXISTS reminder_at      timestamptz,
  ADD COLUMN IF NOT EXISTS recurrence_rule  text,
  ADD COLUMN IF NOT EXISTS related_contact_phone text,
  ADD COLUMN IF NOT EXISTS ai_confidence    numeric(4,3),
  ADD COLUMN IF NOT EXISTS ai_model_used    text,
  ADD COLUMN IF NOT EXISTS last_interaction_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source_link      text,

  -- Action tracking columns (for on-demand executor)
  ADD COLUMN IF NOT EXISTS requested_action text,
  ADD COLUMN IF NOT EXISTS custom_action    text,
  ADD COLUMN IF NOT EXISTS action_status    text DEFAULT 'idle'
                             CHECK (action_status IN ('idle','pending','running','completed','failed','failed_permanently')),
  ADD COLUMN IF NOT EXISTS action_result    text,
  ADD COLUMN IF NOT EXISTS action_error     text,
  ADD COLUMN IF NOT EXISTS action_retry_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS action_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS draft_link       text;

-- Auto-update updated_at on tasks
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_tasks_updated_at();

-- ============================================================
-- 2. EXTEND source_messages TABLE
-- ============================================================

ALTER TABLE source_messages
  ADD COLUMN IF NOT EXISTS raw_content      text,
  ADD COLUMN IF NOT EXISTS attachments_info text,
  ADD COLUMN IF NOT EXISTS reply_to_context text,
  ADD COLUMN IF NOT EXISTS metadata         jsonb,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz DEFAULT now();

-- ============================================================
-- 3. rules_memory TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS rules_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger       text NOT NULL,
  rule_type     text NOT NULL
                  CHECK (rule_type IN ('skip','skip_spam','action','style','bot','preference','financial')),
  category      text,
  action        text,
  reason        text,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    text NOT NULL DEFAULT 'user'
                  CHECK (created_by IN ('user','claude','system')),
  -- AI suggestion fields
  suggested_by_run_id uuid,
  suggestion_confidence numeric(4,3),
  suggestion_status text DEFAULT 'approved'
                  CHECK (suggestion_status IN ('pending','approved','rejected')),
  user_feedback text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rules_memory_user_id_idx       ON rules_memory(user_id);
CREATE INDEX IF NOT EXISTS rules_memory_user_active_idx   ON rules_memory(user_id, is_active);
CREATE INDEX IF NOT EXISTS rules_memory_suggestion_idx    ON rules_memory(user_id, suggestion_status)
  WHERE suggestion_status = 'pending';

ALTER TABLE rules_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rules_memory_owner" ON rules_memory;
CREATE POLICY "rules_memory_owner" ON rules_memory
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- 4. run_sessions TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS run_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_title       text NOT NULL,
  run_type        text NOT NULL
                    CHECK (run_type IN ('style_learning','collector','whatsapp','classifier','executor','manual')),
  part            text NOT NULL
                    CHECK (part IN ('part0','part1','part2','part3','action','manual')),
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','partial','failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  duration_seconds integer,
  model_used      text,

  -- Counts
  items_processed integer DEFAULT 0,
  items_skipped   integer DEFAULT 0,
  tasks_created   integer DEFAULT 0,
  tasks_updated   integer DEFAULT 0,
  actionable_count  integer DEFAULT 0,
  informational_count integer DEFAULT 0,
  rules_added     integer DEFAULT 0,
  errors_count    integer DEFAULT 0,

  -- Detail
  summary         text,
  errors_log      jsonb DEFAULT '[]',
  metadata        jsonb DEFAULT '{}',

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_sessions_user_id_idx  ON run_sessions(user_id);
CREATE INDEX IF NOT EXISTS run_sessions_status_idx   ON run_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS run_sessions_part_idx     ON run_sessions(user_id, part, started_at DESC);

ALTER TABLE run_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "run_sessions_owner" ON run_sessions;
CREATE POLICY "run_sessions_owner" ON run_sessions
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- 5. action_history TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS action_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  action_type     text NOT NULL,
  status          text NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','failed')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  summary         text,
  result          text,
  error           text,
  model_used      text,
  cost_usd        numeric(10,6),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_history_user_id_idx ON action_history(user_id);
CREATE INDEX IF NOT EXISTS action_history_task_id_idx ON action_history(task_id);
CREATE INDEX IF NOT EXISTS action_history_created_idx ON action_history(user_id, created_at DESC);

ALTER TABLE action_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "action_history_owner" ON action_history;
CREATE POLICY "action_history_owner" ON action_history
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- 6. sync_schedules TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  part        text NOT NULL
                CHECK (part IN ('part1','part2','part3')),
  is_auto     boolean NOT NULL DEFAULT false,
  cron_expr   text NOT NULL DEFAULT '0 7,14,21 * * *',
  last_run_at timestamptz,
  next_run_at timestamptz,
  is_enabled  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, part)
);

CREATE INDEX IF NOT EXISTS sync_schedules_user_idx  ON sync_schedules(user_id);
CREATE INDEX IF NOT EXISTS sync_schedules_auto_idx  ON sync_schedules(is_auto, is_enabled)
  WHERE is_auto = true AND is_enabled = true;

ALTER TABLE sync_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sync_schedules_owner" ON sync_schedules;
CREATE POLICY "sync_schedules_owner" ON sync_schedules
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- 7. ai_prompts TABLE (editable prompts via /admin/prompts)
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_prompts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prompt_key  text NOT NULL,       -- e.g. 'whatsapp_classifier', 'deep_classifier', 'style_he'
  version     integer NOT NULL DEFAULT 1,
  is_active   boolean NOT NULL DEFAULT true,
  content     text NOT NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, prompt_key, version)
);

CREATE INDEX IF NOT EXISTS ai_prompts_user_key_idx ON ai_prompts(user_id, prompt_key, is_active);

ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_prompts_owner" ON ai_prompts;
CREATE POLICY "ai_prompts_owner" ON ai_prompts
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- VERIFICATION QUERIES (run these after applying to confirm)
-- ============================================================
-- SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='tasks' AND table_schema='public' ORDER BY ordinal_position;
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='rules_memory' AND table_schema='public' ORDER BY ordinal_position;
