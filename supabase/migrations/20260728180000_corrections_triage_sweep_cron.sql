-- Hourly recovery sweep for correction triage.
--
-- WHY IT NEEDS A CRON AT ALL
-- POST /corrections fires triage without awaiting it, so the user is not made to
-- wait tens of seconds for a 201. The cost is a window: a redeploy or a crash
-- during the run loses that triage silently — the correction keeps no class, the
-- classifier's allow-list keeps it out of the prompt, and the notification that
-- was meant to tell the user never arrives. The design's central claim is that
-- "did not enter the prompt" always reaches the user as a message rather than as
-- silence, and without this job that claim rested on the API process never
-- restarting at the wrong moment. The sweep route existed; nothing called it.
--
-- FREE: the sweep runs the Claude Code CLI on the user's subscription
-- (CLAUDE_CODE_OAUTH_TOKEN), zero paid API tokens, so an hourly schedule needs no
-- cost approval. limit=3 per run keeps each firing short, and triage's
-- single-slot queue means the sweep can never starve a live correction.
--
-- Same vault pattern as job 26 (daily-report-weekly), so the URL and secret are
-- read from vault rather than baked in. Minute 25 to sit away from the other
-- jobs on this schedule.
--
-- net.http_post's default timeout is 5s while the route can legitimately take
-- minutes; the request is fire-and-forget from pg_cron's point of view, so a
-- logged timeout in net._http_response is expected and harmless — the sweep
-- still completes on the API side. Do not "fix" that by raising the timeout;
-- pg_cron holds a worker for the duration.

SELECT cron.unschedule('corrections-triage-sweep')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'corrections-triage-sweep');

SELECT cron.schedule(
  'corrections-triage-sweep',
  '25 * * * *',
  $$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name='smrttask_cron_url') || '/api/corrections/jobs/triage-sweep',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='smrttask_cron_secret')),
      body    := '{"limit":3}'::jsonb
    );
  $$
);
