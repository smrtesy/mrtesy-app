-- Claude autonomy safety gate: the approval queue for the one red line that is NOT
-- autonomous — a DESTRUCTIVE migration against production.
--
-- Design: docs/claude-console/autonomy-safety-gate.md.
--
-- Reversible actions (merge to main, additive migrations) run autonomously and leave
-- no row here. This table exists only for actions that are irreversible, where a human
-- must click after seeing a plain-Hebrew consequence and, optionally, the affected rows.
--
-- Backend-only (service-role Express), RLS on with no client policy — the same pattern
-- as every other claude_* table. The screen reads/writes it through the authed backend.

CREATE TABLE IF NOT EXISTS claude_action_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- What kind of red-line action is waiting. 'migration' is the only one today; the
  -- column is here so a future irreversible action reuses the same queue + screen.
  kind        text NOT NULL DEFAULT 'migration' CHECK (kind IN ('migration')),

  -- pending  → waiting for the human
  -- approved → human clicked; the backend is applying (transient)
  -- applied  → done, with the result in `result`
  -- rejected → human declined; nothing ran
  -- failed   → applied but the apply itself errored (see `result.error`)
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'applied', 'rejected', 'failed')),

  -- Plain-Hebrew consequence the human decides on ("this deletes 312 rows from …").
  title       text NOT NULL,

  -- Everything the screen needs to show and the apply step needs to run, verbatim:
  --   { sql, migration_path, classification, reasons[], select_sql,
  --     affected_count, sample_rows[] }
  -- Kept whole so the UI shows exactly what will run, not a reconstruction.
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Where the request came from — the in-app Claude conversation that asked for it.
  thread_id   uuid REFERENCES claude_threads(id) ON DELETE SET NULL,
  run_id      uuid REFERENCES claude_runs(id) ON DELETE SET NULL,

  -- Who decided, and the outcome of applying.
  decided_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at  timestamptz,
  result      jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The screen lists this org's pending items first; an index probe, not a scan.
CREATE INDEX IF NOT EXISTS idx_claude_approvals_org_status
  ON claude_action_approvals (org_id, status, created_at DESC);

ALTER TABLE claude_action_approvals ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_action_approvals IS
  'Human-approval queue for the in-app Claude''s irreversible actions (destructive '
  'migrations). Reversible actions run autonomously and never appear here. Backend-only, '
  'RLS on with no client policy.';
