-- Liveness monitor for sync sources.
--
-- The Google Calendar sync silently sat dead for 5 weeks (checkpoint never
-- captured) with no alert, because the only calendar alert fires on a 3-strike
-- OAuth refresh failure — and the token was valid the whole time. Nothing
-- watched "connected but not actually advancing". This adds that watch.
--
-- Per-source liveness signal (NOT a blanket last_synced_at threshold):
--   * gmail  — cron-driven every 2m, last_synced_at advances each run.
--              Stale if last_synced_at older than 1 hour.
--   * drive  — cron-driven every 6h. Stale if older than 12 hours (2 missed).
--   * google_calendar — EVENT-driven (webhook only fires on a change), so
--              last_synced_at legitimately doesn't move on a quiet day. The
--              real health signals are: a captured sync token (checkpoint NOT
--              NULL) and a live push channel (watch_expiration in the future).
--              Stale if checkpoint IS NULL or the watch is expired / expiring
--              within 24h. This is exactly the state the 5-week outage was in.
--
-- Alerts are deduped: at most one per (source, user) per 24h, so the hourly
-- cron doesn't spam while an outage persists. Writes both a notification
-- (action_required → web push) and a log_entries error row (→ super-admin
-- fan-out trigger).

CREATE OR REPLACE FUNCTION public.check_sync_staleness()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r          record;
  v_stale    boolean;
  v_reason   text;
  v_org      uuid;
  v_label    text;
BEGIN
  FOR r IN
    SELECT user_id, source, last_synced_at, checkpoint, watch_expiration
    FROM sync_state
    WHERE source IN ('gmail', 'google_drive', 'google_calendar')
  LOOP
    v_stale := false;
    v_reason := NULL;

    IF r.source = 'gmail' THEN
      IF r.last_synced_at IS NULL OR r.last_synced_at < now() - interval '1 hour' THEN
        v_stale := true;
        v_reason := 'Gmail sync has not advanced in over an hour';
        v_label := 'Gmail';
      END IF;
    ELSIF r.source = 'google_drive' THEN
      IF r.last_synced_at IS NULL OR r.last_synced_at < now() - interval '12 hours' THEN
        v_stale := true;
        v_reason := 'Google Drive sync has not advanced in over 12 hours';
        v_label := 'Google Drive';
      END IF;
    ELSIF r.source = 'google_calendar' THEN
      IF r.checkpoint IS NULL THEN
        v_stale := true;
        v_reason := 'Google Calendar has no sync token — incremental sync is not running';
      ELSIF r.watch_expiration IS NULL OR r.watch_expiration < now() + interval '24 hours' THEN
        v_stale := true;
        v_reason := 'Google Calendar push channel is expired or expiring within 24h';
      END IF;
      v_label := 'Google Calendar';
    END IF;

    IF NOT v_stale THEN
      CONTINUE;
    END IF;

    -- Dedup: skip if we already raised this source for this user in the last
    -- 24h. entity_id is uuid, so the source is encoded in entity_type instead.
    IF EXISTS (
      SELECT 1 FROM notifications
      WHERE user_id = r.user_id
        AND entity_type = 'sync_staleness:' || r.source
        AND created_at > now() - interval '24 hours'
    ) THEN
      CONTINUE;
    END IF;

    -- log_entries error → super-admin fan-out trigger picks it up
    INSERT INTO log_entries (user_id, level, category, status, error_message)
    VALUES (
      r.user_id, 'error', 'sync_staleness', 'failed',
      format('%s sync stale: %s (last_synced_at=%s)', v_label, v_reason, COALESCE(r.last_synced_at::text, 'never'))
    );

    -- user-facing notification → web push
    SELECT org_id INTO v_org
    FROM org_members WHERE user_id = r.user_id LIMIT 1;

    IF v_org IS NOT NULL THEN
      INSERT INTO notifications (user_id, org_id, app_slug, type, title, body, link, entity_type)
      VALUES (
        r.user_id, v_org, 'smrttask', 'action_required',
        format('%s לא מסתנכרן', v_label),
        v_reason || '. יש לבדוק בהגדרות → חיבורים.',
        '/settings', 'sync_staleness:' || r.source
      );
    END IF;
  END LOOP;
END;
$$;

-- Only the service role / cron should run this; keep it off the public API.
REVOKE EXECUTE ON FUNCTION public.check_sync_staleness() FROM PUBLIC, anon, authenticated;

-- Hourly liveness sweep. Unschedule first so the migration is re-runnable.
SELECT cron.unschedule('sync-staleness-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-staleness-monitor');

SELECT cron.schedule(
  'sync-staleness-monitor',
  '0 * * * *',
  $$SELECT public.check_sync_staleness();$$
);
