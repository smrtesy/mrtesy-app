-- Idempotent message send for the Claude console.
--
-- The bug this fixes: POST /claude/threads/:id/messages is not idempotent, so
-- the client (src/lib/api/client.ts) never retries it. When the Railway edge
-- proxy drops the RESPONSE of a POST that the server already processed (a
-- transient reset / 502 with no CORS headers → the browser's "Failed to fetch"),
-- the client thinks the send failed and restores the composer text — while the
-- turn was in fact created and shows up via the live poll. The user sees a fake
-- error and re-sends, producing a duplicate turn.
--
-- The fix: the client sends a stable client_token (a UUID) per message and may
-- now retry the POST safely. This column + partial unique index let the server
-- recognize a retried send and return the SAME run instead of inserting a second
-- turn. Scoped per thread; NULL tokens (any legacy/other caller) are ignored by
-- the partial index, so nothing existing is constrained.
--
-- Additive and reversible — a new nullable column and a partial unique index.

ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS client_token text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_claude_runs_thread_client_token
  ON claude_runs (thread_id, client_token) WHERE client_token IS NOT NULL;

COMMENT ON COLUMN claude_runs.client_token IS
  'Client-generated idempotency key for a message send. A retried POST carrying '
  'the same (thread_id, client_token) returns the existing run instead of '
  'creating a duplicate turn. See supabase/migrations/20260805150000.';
