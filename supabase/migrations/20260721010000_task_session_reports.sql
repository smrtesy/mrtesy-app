-- Auto-report from a Claude Code session — the lightweight counterpart to
-- task_debriefs (20260714100000_task_debriefs.sql). A task_debriefs row is the
-- structured, GATING completion debrief (required before a research task can be
-- marked done); task_session_reports is a running PROGRESS SIGNAL posted by an
-- external Claude Code Stop hook while work is still in flight — no gating, no
-- required fields, just "here's where things stand" attached to whichever task
-- the user currently has in_progress.
--
-- Written by POST /api/claude-session/task-report (machine-to-machine, shared
-- x-cron-secret, same pattern as smrttask's claude-session.ts). One row per
-- (task, session) — a session refreshes its own row as the agent keeps working;
-- it never creates duplicates for the same Claude Code session.
--
-- Additive, standalone table — no existing table or flow is affected.

CREATE TABLE IF NOT EXISTS task_session_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id   text NOT NULL,
  session_url  text,
  summary      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress', 'blocked', 'done')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_task_session_reports_task ON task_session_reports (task_id);
CREATE INDEX IF NOT EXISTS idx_task_session_reports_org_created ON task_session_reports (org_id, created_at DESC);

ALTER TABLE task_session_reports ENABLE ROW LEVEL SECURITY;

-- Backend-only, exactly like plan_review_notes: the client never touches this
-- table directly — it is written by the service-role Express endpoint above and
-- read by the service-role plan journal assembly (/plans/:id/journal). RLS is
-- enabled with no permissive client policy so any direct (anon/authed) client
-- read or write is denied; the service role bypasses it.

COMMENT ON TABLE task_session_reports IS
  'Lightweight auto-report from a Claude Code session Stop hook — a running progress '
  'signal (summary + status + session link) attached to a user''s in-progress task, '
  'NOT the gating completion debrief (that remains task_debriefs).';
