-- daily_report — schema for the "דוח יומי" day-tool (docs/daily-report-plan.md).
--
-- The user defines report ITEMS (questions), each with its own answer OPTIONS
-- and an optional per-option score. Each day the user files ENTRIES (one answer
-- per item). A weekly RUN snapshots the aggregate (answer tallies + average
-- score) and is delivered to the smrtTask inbox every Tuesday.
--
-- Design notes:
--   • Personal data — every table is user-scoped within an org (RLS own-only),
--     mirroring daily_plans / work_sessions. Service role bypasses RLS.
--   • Questions are ARCHIVED (active=false), never hard-deleted, so historical
--     runs stay reconstructable.
--   • Entries SNAPSHOT the chosen option's label + score at answer time
--     (option_label / score_snapshot). Options can be freely edited/removed
--     afterwards (option_id → SET NULL) without corrupting past reports — the
--     same "freeze it at commit time" rule daily_plans uses for its picks.

-- ── items (the questions) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label      text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_report_items_user
  ON daily_report_items (user_id, active, position);

-- ── options (answers per question) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_options (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES daily_report_items(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label      text NOT NULL,
  -- Optional score. NULL → the option (and its item) is counted only (tally),
  -- never folded into the overall average.
  score      numeric,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_report_options_item
  ON daily_report_options (item_id, position);

-- ── entries (the daily answers) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entry_date     date NOT NULL,                 -- the report day in the user's tz
  item_id        uuid NOT NULL REFERENCES daily_report_items(id) ON DELETE CASCADE,
  option_id      uuid REFERENCES daily_report_options(id) ON DELETE SET NULL,
  option_label   text NOT NULL,                 -- snapshot of the chosen answer
  score_snapshot numeric,                       -- snapshot of the score at answer time
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_date, item_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_report_entries_user_date
  ON daily_report_entries (user_id, entry_date DESC);

-- ── runs (generated report snapshots) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_type   text NOT NULL DEFAULT 'weekly'
                  CHECK (period_type IN ('weekly','monthly')),
  range_start   date NOT NULL,
  range_end     date NOT NULL,                  -- inclusive
  overall_score numeric,                        -- NULL when no scored answers exist
  -- Per-item tallies + averages + the automatic tasks section. Shape:
  --   { "items": [{ item_id, label, options:[{label,count,score}], avg_score, answered }],
  --     "tasks": { quick, medium, big, worked_seconds } }
  breakdown     jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_by  text NOT NULL DEFAULT 'manual'
                  CHECK (generated_by IN ('schedule','manual')),
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,  -- the inbox item
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_report_runs_user
  ON daily_report_runs (user_id, created_at DESC);

-- ── RLS: own-only on every table (service role bypasses) ───────────────────
ALTER TABLE daily_report_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_report_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_report_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_report_runs    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'daily_report_items','daily_report_options','daily_report_entries','daily_report_runs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_own_select ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY %I_own_select ON %I FOR SELECT USING (user_id = auth.uid())', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I_own_insert ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY %I_own_insert ON %I FOR INSERT WITH CHECK (user_id = auth.uid())', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I_own_update ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY %I_own_update ON %I FOR UPDATE USING (user_id = auth.uid())', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I_own_delete ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY %I_own_delete ON %I FOR DELETE USING (user_id = auth.uid())', tbl, tbl);
  END LOOP;
END $$;

COMMENT ON TABLE daily_report_items IS
  'Daily-report day-tool: user-defined report questions. See docs/daily-report-plan.md.';
COMMENT ON TABLE daily_report_options IS
  'Daily-report day-tool: answer options per question, each with an optional score.';
COMMENT ON TABLE daily_report_entries IS
  'Daily-report day-tool: one answer per (user, day, question); snapshots option label + score.';
COMMENT ON TABLE daily_report_runs IS
  'Daily-report day-tool: generated weekly report snapshots delivered to the inbox.';
