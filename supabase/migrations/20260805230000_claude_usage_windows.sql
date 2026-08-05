-- Real per-account usage-window state, captured from the Claude CLI's own
-- `rate_limit_event` stream lines. The CLI emits one on EVERY run (not only at
-- exhaustion), carrying Anthropic's OWN ground truth in `rate_limit_info`:
--   resetsAt      — the exact reset instant of the current window (unix epoch, s)
--   rateLimitType — 'five_hour' (the 5h session window) | 'seven_day' (weekly)
--   utilization   — the real fraction used (0..1); PRESENT ONLY once past the
--                   warning threshold (status 'allowed_warning', ~>75%)
--   status        — 'allowed' | 'allowed_warning' | 'rejected'
--
-- Why: the usage meter used to RECONSTRUCT the 5-hour window from our own runs'
-- timestamps (check_claude_usage_limits) and ESTIMATE the percent from summed
-- cost — a guess that drifted (the reset time was ~5 min off, the percent was a
-- cost proxy). This table lets the meter use Anthropic's real reset time always,
-- and the real percent whenever the CLI reports it, falling back to the estimator
-- only when there is no fresh window row (resets_at already in the past).
--
-- One row per (account, window_kind): the LATEST observation, UPSERTed by the
-- runner (server/src/modules/claude/runner.ts). A live snapshot, not history.
-- Additive: new table only, no existing data changes.
CREATE TABLE IF NOT EXISTS claude_usage_windows (
  claude_account text NOT NULL,
  window_kind    text NOT NULL CHECK (window_kind IN ('five_hour', 'seven_day')),
  resets_at      timestamptz NOT NULL,
  utilization    numeric CHECK (utilization IS NULL OR (utilization >= 0 AND utilization <= 1)),
  status         text,
  observed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claude_account, window_kind)
);

COMMENT ON TABLE claude_usage_windows IS
  'Latest usage-window state per Claude account, captured from the CLI '
  'rate_limit_event (Anthropic''s own resetsAt / utilization / status). The usage '
  'meter reads this as ground truth for reset time (always) and percent (when '
  'utilization is present), falling back to the cost estimator when no fresh row.';
