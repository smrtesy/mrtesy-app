-- Honest "stuck message" health signal.
--
-- Background: the raw metric "source_messages with processing_status='pending'
-- older than 30 minutes" chronically over-reports. Calendar events are stored
-- as 'pending' far in advance on purpose and are only turned into tasks
-- ~MEETING_LEAD_HOURS (24 business hours) BEFORE the event starts — see
-- ai-process preClassify() ("future_calendar_event" defer) and the fetch gate
-- calendarReadyBefore = now() + 5 days. So every future calendar event sits
-- 'pending' for weeks/months by design, and the naive metric counts each one
-- as "stuck" — an alarm that never clears and reappears at every health check.
--
-- This view encodes the honest definition: a pending message is genuinely
-- stuck only when it is actually ELIGIBLE for processing and still hasn't been
-- processed. A future-dated calendar event that has never failed an attempt is
-- deferred-by-design (or in its just-opening lead window) — not stuck — and is
-- excluded. A calendar event is only surfaced as stuck once its event time has
-- PASSED and it is still pending (its lead window definitely opened), or once
-- it has burned at least one failed processing attempt (retry_count > 0).
-- Health checks should query this view instead of the raw pending count.
--
-- Note: rows that can NEVER be processed for a real reason (e.g. a non-calendar
-- row with NULL body_text that BODY_TEXT_FILTER excludes) are intentionally
-- still surfaced here — those are genuine problems worth flagging.

CREATE OR REPLACE VIEW public.v_stuck_source_messages AS
SELECT sm.*
FROM public.source_messages sm
WHERE sm.processing_status = 'pending'
  AND COALESCE(sm.dead_letter, false) = false
  AND sm.created_at < now() - interval '30 minutes'
  -- Deferred-by-design future calendar events (never-failed) are NOT stuck.
  AND NOT (
    sm.source_type = 'google_calendar'
    AND sm.received_at > now()
    AND COALESCE(sm.retry_count, 0) = 0
  );

COMMENT ON VIEW public.v_stuck_source_messages IS
  'Genuinely stuck source_messages (pending, not dead-letter, >30min old), '
  'excluding future calendar events still inside their deferral window '
  '(received_at > now()+5d). Use this for health checks instead of the raw '
  'pending count, which over-reports deferred calendar events. See migration '
  '20260722194000 and ai-process preClassify().';
