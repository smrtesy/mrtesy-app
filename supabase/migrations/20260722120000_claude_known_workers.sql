-- Per-user routing for the unified Claude Code Stop hook (smrtTask + smrtPlan).
-- See docs/user-routing-stop-hook-plan.md.
--
-- Two additive, backend-only tables — no existing table or flow is affected:
--
--   claude_known_workers      — the "who are you?" list a shared Claude Code
--                               account presents at session start. Org-scoped;
--                               a new worker's smrtTask email is saved here for
--                               next time. Anchored to the manager's org.
--
--   claude_manager_proposals  — dedup map that guarantees ONE manager proposal
--                               per (worker, NY-day). The unique constraint makes
--                               it race-proof: two concurrent sessions from the
--                               same worker on the same day can never create two
--                               manager proposals (the second INSERT conflicts and
--                               we reuse the first row's task).
--
-- Both are written only by the service-role Express endpoints (machine-to-machine,
-- x-cron-secret gated, same pattern as task_session_reports). RLS is enabled with
-- no permissive client policy, so any direct anon/authed access is denied while the
-- service role bypasses it.

CREATE TABLE IF NOT EXISTS claude_known_workers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       text NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- one row per email per org, case-insensitive (emails are compared lowercased)
  UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_claude_known_workers_org
  ON claude_known_workers (org_id, created_at);

ALTER TABLE claude_known_workers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_known_workers IS
  'The "what is your smrtTask email?" list a shared Claude Code account shows at '
  'session start; backend-only, anchored to the manager''s org. See '
  'docs/user-routing-stop-hook-plan.md.';


CREATE TABLE IF NOT EXISTS claude_manager_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manager_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_email     text NOT NULL,
  ny_date          date NOT NULL,
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- ONE manager proposal per worker per New-York day (race-proof dedup)
  UNIQUE (org_id, manager_user_id, worker_email, ny_date)
);

CREATE INDEX IF NOT EXISTS idx_claude_manager_proposals_lookup
  ON claude_manager_proposals (org_id, manager_user_id, worker_email, ny_date);

ALTER TABLE claude_manager_proposals ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_manager_proposals IS
  'Dedup map: one manager smrtTask proposal per (worker, New-York day). Written by '
  'the smrtPlan task-report endpoint when a worker reports progress. See '
  'docs/user-routing-stop-hook-plan.md.';
