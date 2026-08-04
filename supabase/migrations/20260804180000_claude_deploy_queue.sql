-- Coalescing deploy queue for the Claude console — phase 1 of
-- docs/claude-console/deploy-queue-plan.md.
--
-- WHY: the console runner lives in the Railway backend process, and Railway
-- redeploys the backend on every push to `main` (now gated to server/** via a
-- watch path). Each redeploy SIGTERMs the container and kills every in-flight
-- console run. When several server fixes push near-simultaneously they knock each
-- other down. This queue coalesces those pushes: a server-code branch registers
-- here instead of pushing to main, and a background coordinator later merges the
-- whole batch and deploys ONCE.
--
--   claude_deploy_queue — one row per thread's pending server fix. A fix is
--     'building' from its first server/** edit, 'ready' once its branch is built +
--     pushed, then the coordinator drives it 'deploying' → 'done' (or 'failed' /
--     'conflict'). One active entry per thread (UNIQUE(thread_id), upsert key).
--
-- Written only by the service-role machine endpoints (/claude-deploy/*, x-cron-
-- secret gated) and the coordinator, exactly like claude_runs. RLS is enabled
-- with NO permissive client policy — direct anon/authed access is denied, the
-- service role bypasses it. Additive and standalone: no existing table or flow is
-- affected.

CREATE TABLE IF NOT EXISTS claude_deploy_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- One active fix per thread — the upsert key. A thread that starts a new fix
  -- reuses its row (state reset to 'building').
  thread_id   uuid NOT NULL REFERENCES claude_threads(id) ON DELETE CASCADE,

  -- The run that registered the entry, for staleness: a 'building' row whose run
  -- has no fresh heartbeat is an abandoned fix the coordinator drops.
  run_id      uuid REFERENCES claude_runs(id) ON DELETE SET NULL,

  -- The feature branch to merge into the batch. Null while 'building' (the branch
  -- may not exist yet); set when the fix goes 'ready'.
  branch      text,
  -- Short label for the "ממתין למיזוג" category in the chat list.
  title       text NOT NULL DEFAULT '',

  state       text NOT NULL DEFAULT 'building'
                CHECK (state IN ('building', 'ready', 'deploying', 'done', 'failed', 'conflict')),
  -- Set when a batch build/merge fails, so the chat list can show why.
  error       text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (thread_id)
);

-- The coordinator scans by org + state; the earliest created_at drives the
-- 30-minute cap.
CREATE INDEX IF NOT EXISTS idx_claude_deploy_queue_org_state
  ON claude_deploy_queue (org_id, state, created_at);

ALTER TABLE claude_deploy_queue ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_deploy_queue IS
  'Coalescing deploy queue for the Claude console (docs/claude-console/deploy-queue-plan.md). '
  'One row per thread pending a server/** deploy; the background coordinator merges the '
  'ready batch and deploys once. Service-role only (machine endpoints + coordinator); RLS on, no client policy.';
