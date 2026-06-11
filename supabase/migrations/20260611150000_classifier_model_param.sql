-- Dedicated model param for the thread classifier (analyzeWithMemory).
--
-- Split from classification_model after the 2026-06 shadow eval (300 recent
-- messages re-classified on both models with the production prompt):
--   * Haiku/Sonnet agreed on only 73.8% of classifications;
--   * Haiku mis-filed 6 personal WhatsApp chats as SPAM, missed direct asks
--     and a $1,517 utility bill, and closed matters prematurely (42 vs 11
--     completion disagreements);
--   * Haiku echoed the injected "user_actionable" correction label back as a
--     classification, which the parser inverted to informational.
-- The classifier therefore defaults to Sonnet (the code falls back to
-- claude-sonnet-4-6 even before this column exists). The mechanical jobs
-- (wa_route, dupe_match, cross_link, project, checkFollowup) stay on the
-- cheap classification_model.
ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS classifier_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
