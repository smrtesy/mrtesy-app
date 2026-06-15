-- Shadow-eval results for the tiered-classifier evaluation.
--
-- Read-only experiment surface: the ai-process `?action=shadow_eval` admin
-- endpoint replays recent already-classified messages through the REAL
-- classifier (analyzeWithMemory) on Haiku, and records Haiku's verdict next to
-- the stored production verdict (Sonnet, for messages after the 2026-06-11
-- switch) plus the structural signals used to decide escalation. NOTHING in
-- the production pipeline reads or writes source_messages/tasks from that path;
-- this table is the only output. We then analyze cheap-path agreement and
-- cost-of-error in SQL, tuning the force-escalate triggers until zero
-- high-cost regressions, BEFORE any production model change.
--
-- Service-role only (RLS on, no policy): the edge function uses the admin
-- client which bypasses RLS; no end-user ever needs to read this.

CREATE TABLE IF NOT EXISTS shadow_eval_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL,
  message_id       uuid,
  user_id          uuid,
  source_type      text,
  sender_email     text,
  stored_class     text,        -- production ai_classification (Sonnet, post-switch)
  haiku_class      text,        -- 'actionable' | 'informational' | 'spam' | 'ERROR'
  haiku_confidence text,        -- 'high' | 'low'
  is_whatsapp      boolean,
  is_reply         boolean,
  has_ask          boolean,
  has_meeting      boolean,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_eval_results_run_idx ON shadow_eval_results(run_id);

ALTER TABLE shadow_eval_results ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: only the service-role edge function touches this table.
