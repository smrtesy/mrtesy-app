-- Recovery sweep for correction auto-diagnosis.
--
-- WHY IT NEEDS A CRON
-- When triage classifies a correction as code/ui it fires a read-only diagnosis
-- run (server/.../corrections/diagnose.ts) that POSTs its problem+fix back and
-- flips context.diagnosis.status to `done`. If that run dies without posting — a
-- redeploy, a crash, a timeout — the correction is left at status `running`
-- forever. The card already treats a stale `running` as failed client-side
-- (DIAGNOSIS_STALE_MS in CorrectionsTriageReview.tsx), so the USER always sees
-- "האבחון לא הצליח לרוץ" and can still act; this job persists that same verdict
-- to the DB so the row's stored status stops lying.
--
-- CHEAP: unlike triage-sweep this fires NO Claude run — it is a bounded DB scan
-- (limit 200) that flips rows past DIAGNOSIS_TIMEOUT_MS (10 min) to `failed`. So
-- it can run every 10 minutes with no cost concern.
--
-- Same vault pattern as corrections-triage-sweep (job on '25 * * * *'), so the
-- URL and secret are read from vault rather than baked in. net.http_post's 5s
-- default timeout is fine here (the sweep is a quick DB update), but a logged
-- timeout in net._http_response would still be harmless.

SELECT cron.unschedule('corrections-diagnosis-sweep')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'corrections-diagnosis-sweep');

SELECT cron.schedule(
  'corrections-diagnosis-sweep',
  '*/10 * * * *',
  $$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name='smrttask_cron_url') || '/api/corrections/jobs/diagnosis-sweep',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='smrttask_cron_secret')),
      body    := '{}'::jsonb
    );
  $$
);
