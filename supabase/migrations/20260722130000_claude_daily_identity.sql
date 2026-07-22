-- Daily identity cache for the unified Claude Code Stop hook.
-- See docs/user-routing-stop-hook-plan.md.
--
-- A shared Claude Code account asks the human "what is your smrtTask email?" once
-- per New-York day; the answer is cached here so later sessions THAT DAY skip the
-- question. Keyed (claude_account, ny_date) UNIQUE — one active identity per
-- account per NY day. Durable on purpose: the remote container is ephemeral, so a
-- local file would not survive between sessions.
--
-- Backend-only (service-role Express, x-cron-secret gated), RLS enabled with no
-- client policy — same pattern as claude_known_workers / task_session_reports.

CREATE TABLE IF NOT EXISTS claude_daily_identity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claude_account text NOT NULL,   -- CLAUDE_CODE_USER_EMAIL of the shared account
  ny_date        date NOT NULL,   -- the New-York day this identity is active for
  worker_email   text NOT NULL,   -- the smrtTask email the human chose
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claude_account, ny_date)
);

CREATE INDEX IF NOT EXISTS idx_claude_daily_identity_lookup
  ON claude_daily_identity (claude_account, ny_date);

ALTER TABLE claude_daily_identity ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_daily_identity IS
  'Once-a-day "what is your smrtTask email?" answer for a shared Claude Code '
  'account, keyed (claude_account, New-York day). Backend-only. See '
  'docs/user-routing-stop-hook-plan.md.';
