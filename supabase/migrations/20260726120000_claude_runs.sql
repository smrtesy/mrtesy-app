-- Claude runs launched from inside smrtesy — slice 1 of docs/claude-console/plan.md.
--
-- The point of these two tables: when the app runs Claude, EVERYTHING that
-- happened lives here, in our own database, as the source of truth — not as a
-- copy of something on claude.ai. That is what makes Claude part of our software
-- rather than an external tool we visit.
--
--   claude_runs        — one row per run the app launched: who asked for it, on
--                        which Claude account, the prompt, status, timing.
--   claude_run_events  — the run's full event stream, one row per event, in
--                        order (seq). This is the complete transcript, not a
--                        summary: assistant text, tool calls, tool results.
--
-- Both are written only by the service-role Express endpoints (the authed routes
-- and the runner), exactly like task_session_reports / claude_known_workers. RLS
-- is enabled with NO permissive client policy, so any direct anon/authed client
-- access is denied while the service role bypasses it.
--
-- Additive and standalone — no existing table or flow is affected.

CREATE TABLE IF NOT EXISTS claude_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Which Claude account executed this run. Plain text in slice 1 on purpose:
  -- the managed accounts registry (claude_accounts) arrives in slice 4, and a
  -- text column keeps that path open without pre-committing to its shape.
  claude_account  text,

  title           text NOT NULL,
  prompt          text NOT NULL,
  repo            text,
  cwd             text,

  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  error           text,
  result_summary  text,

  -- Claude's own session id, once the stream reports it. Lets a run be tied back
  -- to the session that produced it (and to a claude.ai deep link when there is
  -- one) without us inventing a second identifier.
  session_id      text,

  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claude_runs_org_created
  ON claude_runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claude_runs_status
  ON claude_runs (status) WHERE status IN ('queued', 'running');

ALTER TABLE claude_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_runs IS
  'One row per Claude run launched from inside smrtesy (docs/claude-console/plan.md). '
  'Backend-only: written by the service-role Express routes and the runner; RLS on '
  'with no client policy.';


CREATE TABLE IF NOT EXISTS claude_run_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES claude_runs(id) ON DELETE CASCADE,

  -- Monotonic per run, so the stream can be replayed in exact order even when
  -- rows are written in batches. UNIQUE (run_id, seq) makes an accidental
  -- double-write of the same event a conflict instead of a duplicate.
  seq        integer NOT NULL,

  kind       text NOT NULL
               CHECK (kind IN ('user', 'assistant', 'tool_use', 'tool_result',
                               'system', 'result', 'error')),
  text       text,
  tool_name  text,

  -- The raw event as the stream emitted it, for anything the columns above don't
  -- capture. Media artifacts are stored as URLs by the caller — never raw bytes:
  -- text is cheap, media is what would actually blow up the table.
  payload    jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_claude_run_events_run_seq
  ON claude_run_events (run_id, seq);

ALTER TABLE claude_run_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_run_events IS
  'Full ordered event stream of a claude_runs row — the complete transcript, not a '
  'summary. Backend-only, RLS on with no client policy.';
