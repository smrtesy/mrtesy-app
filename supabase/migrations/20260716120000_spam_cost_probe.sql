-- Spam-scan cost probe (measurement-only surface).
--
-- Motivation: important mail sometimes lands in Gmail's SPAM folder, which the
-- collector (gmail-sync) never scans — it fetches inbox/unread via the History
-- API, so SPAM-labelled mail is invisible to smrtTask and the user misses it.
-- Before wiring spam into the real pipeline we want a REAL cost number: how
-- much would it add to run every spam message through the cheap classifier
-- (Haiku), escalating only the suspected-important ones to the strong model.
--
-- The ai-process `?action=spam_cost_probe` admin endpoint fetches a bounded
-- sample of the user's SPAM mail straight from Gmail, runs each through the
-- REAL classifier (analyzeWithMemory) on Haiku, and records the per-message
-- token counts + cost here — plus the classification, so we can see how many
-- spam messages the cheap pass would flag as actionable/informational (the
-- "rescue rate"). It writes ONLY to this table: never source_messages, never
-- tasks. No suggestion is ever created from a probe run.
--
-- Service-role only (RLS on, no policy): the edge function uses the admin
-- client which bypasses RLS; no end-user ever needs to read this.

CREATE TABLE IF NOT EXISTS spam_cost_probe (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL,
  user_id            uuid,
  message_id         text,          -- Gmail message id (NOT a source_messages row — spam is never ingested)
  subject            text,
  sender_email       text,
  received_at        timestamptz,
  haiku_class        text,          -- 'actionable' | 'informational' | 'spam' | 'ERROR'
  haiku_confidence   text,          -- 'high' | 'low'
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  haiku_cost_usd     numeric,       -- measured cost of the cheap pass on THIS message
  sonnet_cost_usd    numeric,       -- same tokens priced at the Sonnet rate = cost IF this one escalated
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spam_cost_probe_run_idx ON spam_cost_probe(run_id);

ALTER TABLE spam_cost_probe ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: only the service-role edge function touches this table.
