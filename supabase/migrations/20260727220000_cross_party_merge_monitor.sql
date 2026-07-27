-- Regression detector: a task carrying an update from a DIFFERENT person's chat.
--
-- Why a monitor and not just the code fix. This bug class has been "fixed" four
-- times (2026-06-01, 06-08, 06-12, 06-25) and each fix was a sentence added to a
-- model prompt — "NEVER match on person alone", "A shared chat is NOT a shared
-- matter", "Do not staple an unrelated new message onto an old suggestion (the
-- recurring bug)". A prompt is a request, not an enforcement, so the bug kept
-- returning; on 2026-07-27 it produced T1804, where מענדי's message landed on
-- לאה's task because the model asserted "3475848008 = 972584146670".
--
-- ai-process now verifies identity in CODE before any auto-merge (partiesConflict).
-- This monitor is the second half: it makes a REGRESSION visible within the hour
-- instead of six weeks later when the user happens to notice a strange task. It is
-- deliberately PATH-AGNOSTIC — it does not look at which code path merged, it
-- checks the invariant on the stored result, so a new merge path that skips the
-- veto is caught just the same.
--
-- The invariant: a task born in a two-party chat must not carry an update from a
-- DIFFERENT chat, unless the phone is verifiably the same party (another format of
-- the same number) or the task's own text names that number.
--
-- Escape hatches match the code veto exactly, so no false alarms:
--   • group chats — the update's chatId equals the task's, so nothing to compare
--   • same number in another format — keys compare on the last 8 digits
--   • a number the task itself names — e.g. a person replying from a number the
--     task's description quotes
--   • email threads with several senders — out of scope: different people writing
--     on one email thread is normal and is not this bug

-- Last 8 digits of every phone-shaped run of 9+ digits: +1-347-584-8008,
-- 3475848008 and 13475848008 all key to 75848008. Mirrors phoneKeys() in
-- supabase/functions/ai-process/index.ts — keep the two in step.
CREATE OR REPLACE FUNCTION public.phone_keys_8(txt text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(DISTINCT right(regexp_replace(m[1], '\D', '', 'g'), 8)), '{}'::text[])
  FROM regexp_matches(COALESCE(txt, ''), '([+0-9][0-9\-().\s]{7,}[0-9])', 'g') AS m
  WHERE length(regexp_replace(m[1], '\D', '', 'g')) >= 9;
$function$;

CREATE OR REPLACE FUNCTION public.check_cross_party_merges()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r     record;
  v_org uuid;
BEGIN
  FOR r IN
    WITH recent AS (
      SELECT t.id            AS task_id,
             t.user_id,
             t.serial_display,
             t.title_he,
             t.source_message_id,
             public.phone_keys_8(
               COALESCE(t.related_contact, '') || ' ' || COALESCE(t.related_contact_phone, '')
             )                AS contact_keys,
             public.phone_keys_8(
               COALESCE(t.title_he, '') || ' ' || COALESCE(t.description, '')
             )                AS text_keys,
             (u.value->>'source_message_id')::uuid AS upd_msg_id
      FROM tasks t
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.updates, '[]'::jsonb)) u(value)
      WHERE t.updated_at > now() - interval '24 hours'
        AND u.value->>'source_message_id' IS NOT NULL
        AND (u.value->>'created_at')::timestamptz > now() - interval '24 hours'
    )
    SELECT rc.task_id,
           rc.user_id,
           rc.serial_display,
           rc.title_he,
           om.sender                                       AS task_party,
           om.metadata->>'chatId'                          AS task_chat,
           nm.sender                                       AS update_party,
           nm.metadata->>'chatId'                          AS update_chat,
           nm.serial_display                               AS update_msg
    FROM recent rc
    JOIN source_messages om
      ON om.id = rc.source_message_id
     AND om.source_type IN ('whatsapp', 'sms')
    JOIN source_messages nm
      ON nm.id = rc.upd_msg_id
     AND nm.source_type IN ('whatsapp', 'sms')
    WHERE COALESCE(nm.metadata->>'chatId', '') <> COALESCE(om.metadata->>'chatId', '')
      -- not the same number in another format, and not a number the task names
      AND NOT (
        public.phone_keys_8(
          COALESCE(nm.metadata->>'chatId', '') || ' ' || COALESCE(nm.metadata->>'fromPhone', '')
        )
        && (
          rc.contact_keys
          || rc.text_keys
          || public.phone_keys_8(COALESCE(om.metadata->>'chatId', ''))
        )
      )
  LOOP
    -- One alert per offending task per day. The scan window is 24h, so a merge
    -- older than that has already been reported and has left the window.
    IF EXISTS (
      SELECT 1 FROM notifications
      WHERE user_id = r.user_id
        AND entity_type = 'dupe_cross_party:' || r.task_id
        AND created_at > now() - interval '24 hours'
    ) THEN
      CONTINUE;
    END IF;

    -- level='error' + a category of its own is what the daily health-check
    -- Routine already reports on (it groups log_entries level='error' by
    -- category over 24h), so this surfaces in the morning report with no change
    -- to that Routine.
    INSERT INTO log_entries (user_id, task_id, level, category, status, error_message)
    VALUES (
      r.user_id, r.task_id, 'error', 'dupe_cross_party', 'failed',
      format(
        'REGRESSION: %s (%s) carries an update from a different party — task chat %s (%s), update %s from chat %s (%s). The identity veto in ai-process (partiesConflict) should have blocked this merge.',
        COALESCE(r.serial_display, r.task_id::text), COALESCE(r.title_he, '—'),
        COALESCE(r.task_chat, '—'), COALESCE(r.task_party, '—'),
        COALESCE(r.update_msg, '—'), COALESCE(r.update_chat, '—'), COALESCE(r.update_party, '—')
      )
    );

    SELECT org_id INTO v_org FROM org_members WHERE user_id = r.user_id LIMIT 1;

    IF v_org IS NOT NULL THEN
      INSERT INTO notifications (user_id, org_id, app_slug, type, title, body, link, entity_type)
      VALUES (
        r.user_id, v_org, 'smrttask', 'action_required',
        format('%s מכילה הודעות משני אנשים שונים', COALESCE(r.serial_display, 'משימה')),
        format('המשימה נולדה בצ׳אט של %s, ונוספה לה הודעה מהצ׳אט של %s. זו נסיגה של הבאג שתוקן ב-27/7/2026 (T1804) — אימות הזהות ב-ai-process היה אמור לחסום את המיזוג.',
               COALESCE(r.task_party, r.task_chat, '—'), COALESCE(r.update_party, r.update_chat, '—')),
        '/tasks', 'dupe_cross_party:' || r.task_id
      );
    END IF;
  END LOOP;
END;
$function$;

-- Hourly, matching the sync-staleness monitor's cadence: a regression is known
-- within the hour, and the daily health-check report picks up the log_entries row
-- the next morning either way.
SELECT cron.unschedule('cross-party-merge-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cross-party-merge-monitor');

SELECT cron.schedule(
  'cross-party-merge-monitor',
  '15 * * * *',
  $$SELECT public.check_cross_party_merges();$$
);
