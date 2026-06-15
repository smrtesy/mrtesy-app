-- AI cost reduction (3/3): content-skip suggestions learned from history.
--
-- Mined from every AI-classified message that never became a task (2603
-- no-task vs 794 task). These 11 phrases are transactional close-outs
-- ("payment received", "your receipt") and bulk markers ("newsletter") that
-- appeared in 170 no-task messages and ZERO of the 794 real tasks — ~100%
-- precision. Distinct from the per-sender rules (learn_skip_rules): a content
-- rule catches the long tail and brand-new senders on their FIRST message,
-- with no per-sender history required.
--
-- Stored as `contains=<phrase>` rules so they appear in the rules screen and
-- are individually toggleable, and inserted as PENDING suggestions (the user
-- approves which to enable). Enforcement lives in ai-process preClassify(),
-- which applies them ONLY to first-contact inbound email (not replies in a
-- live thread) — the guard that neutralizes the one collision class found:
-- a phrase quoted inside a "Re:" human conversation.
--
-- Idempotent: a (user, phrase) pair already carrying a `contains=` rule (any
-- status, including a prior rejection) is skipped, so re-running never
-- duplicates or re-proposes a declined phrase.

INSERT INTO rules_memory
  (user_id, trigger, rule_type, action, reason, is_active,
   created_by, suggestion_status, suggestion_confidence, app_slug)
SELECT
  u.user_id,
  'contains=' || p.phrase,
  'skip',
  'skip',
  format(
    'סינון תוכן שנלמד מההיסטוריה: הודעות שמכילות "%s" מעולם לא הפכו למשימה (דיוק ~100%% על הדאטא). חל רק על מייל ראשוני, לא על תגובות בשרשור.',
    p.phrase
  ),
  false,
  'system',
  'pending',
  0.950,
  'smrttask'
FROM (SELECT DISTINCT user_id FROM source_messages WHERE user_id IS NOT NULL) u
CROSS JOIN (VALUES
  ('payment received'),
  ('payment confirmation'),
  ('thank you for your payment'),
  ('your receipt'),
  ('your package'),
  ('out for delivery'),
  ('order confirmation'),
  ('has shipped'),
  ('newsletter'),
  ('you received this email because'),
  ('price alert')
) p(phrase)
WHERE NOT EXISTS (
  SELECT 1 FROM rules_memory r
  WHERE r.user_id = u.user_id
    AND lower(r.trigger) = 'contains=' || p.phrase
);
