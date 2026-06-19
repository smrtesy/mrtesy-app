-- ============================================================
-- smrtBot — daily study summary cron (hourly at :45) + enable for sholem
-- ============================================================
-- pg_cron POSTs hourly (at minute 45) to the Railway job route, which sends
-- each enabled bot's daily study summary when it's the configured hour in that
-- bot's timezone (default 23 → 23:45 local). Same Vault-secret pattern as the
-- broadcasts cron; the route is derived from smrtbot_cron_url by swapping the
-- last path segment. Never breaks the migration chain.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[smrtbot cron] pg_cron not installed — skipping daily-summary schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[smrtbot cron] pg_net not installed — skipping daily-summary schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_secret') THEN
    RAISE NOTICE '[smrtbot cron] Vault secrets smrtbot_cron_url/secret not set — skipping daily-summary schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('smrtbot-daily-summary')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtbot-daily-summary');

  PERFORM cron.schedule(
    'smrtbot-daily-summary',
    '45 * * * *',
    $cron$
      SELECT net.http_post(
        url     := regexp_replace((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_url'), '/[^/]+$', '/daily-summary'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-smrtbot-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );
  RAISE NOTICE '[smrtbot cron] scheduled smrtbot-daily-summary (hourly at :45).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[smrtbot cron] daily-summary setup skipped: %', SQLERRM;
END$$;

-- Enable the daily summary for the demo bot (sholem), at 23:00 local (→ 23:45).
DO $$
DECLARE v_bot uuid; v_org uuid;
BEGIN
  SELECT b.id, b.org_id INTO v_bot, v_org
  FROM smrtbot_bots b JOIN organizations o ON o.id = b.org_id
  WHERE b.slug = 'sholem' AND o.slug = 'maor' LIMIT 1;
  IF v_bot IS NULL THEN RETURN; END IF;
  INSERT INTO smrtbot_settings (org_id, bot_id, key, value)
  VALUES (v_org, v_bot, 'daily_summary_enabled', 'true'),
         (v_org, v_bot, 'daily_summary_hour', '23')
  ON CONFLICT (bot_id, key) DO UPDATE SET value = EXCLUDED.value;
END$$;
