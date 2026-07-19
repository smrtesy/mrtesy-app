-- Opt-in Gmail SPAM-folder scanning.
--
-- Gmail's SPAM label is invisible to the History-API collector in gmail-sync
-- (it syncs inbox/unread only), so mail Gmail mis-flags as spam never reaches
-- smrtTask and the user silently misses it (e.g. a real account/security
-- notice that got mis-filed). When this flag is on, gmail-sync also does a
-- bounded, deduped pass over the SPAM folder, recording messages as
-- source_type='gmail_spam'. ai-process then classifies those on the CHEAP
-- model and only surfaces genuinely actionable ones as tasks — informational /
-- junk stay quiet (logged, no task, no notification).
--
-- Ships OFF by default (behaviour change is opt-in and reversible per user by
-- flipping this flag). Enabled here only for the pilot account.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS scan_spam boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN user_settings.scan_spam IS
  'When true, gmail-sync also scans the Gmail SPAM folder (source_type=gmail_spam), classified cheaply by ai-process; only actionable spam surfaces as a task. Default false.';

-- Enable for the pilot account. Matched by email so it is a safe no-op on any
-- environment where that account does not exist.
UPDATE user_settings s
   SET scan_spam = true
  FROM auth.users u
 WHERE u.id = s.user_id
   AND lower(u.email) = 'chanoch770@gmail.com';
