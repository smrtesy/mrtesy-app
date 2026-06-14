-- AI cost reduction (1/3): drop the task-builder Opus escalation to Sonnet.
--
-- Background (from the ai_usage ledger, steady-state weekday after the
-- 2026-06-11 classifier→Sonnet switch):
--   • ai_process.task on claude-opus-4-8 cost ~$1.0/day across only ~8
--     escalated task-builds (~$0.13 per call) — ~23% of the entire daily AI
--     spend, on a handful of low-confidence extractions.
--   • The escalation only fires when the base Sonnet builder reports
--     confidence="low" AND escalate_task_low_confidence is on; the marginal
--     quality gain of Opus over Sonnet on those already-ambiguous cases does
--     not justify a quarter of the budget.
--
-- Setting task_escalation_model to the SAME model the base builder uses
-- (claude-sonnet-4-6 = summary_model) makes the escalation guard in
-- ai-process (`sys.task_escalation_model !== model`) evaluate false, so the
-- second model call is skipped entirely and the base Sonnet result stands.
-- escalate_task_low_confidence is left as-is (now inert) so the intent is
-- recoverable: point this column at a stronger model to re-enable.
--
-- The classifier escalation path is unaffected — classifier_model and
-- escalation_model are both already Sonnet, so that guard was already a no-op
-- and message classification quality is unchanged.

ALTER TABLE smrttask_system_params
  ALTER COLUMN task_escalation_model SET DEFAULT 'claude-sonnet-4-6';

UPDATE smrttask_system_params
  SET task_escalation_model = 'claude-sonnet-4-6'
  WHERE task_escalation_model = 'claude-opus-4-8';
