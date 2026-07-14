-- Self-healing reconciler for smrtVoice scripts/jobs stuck by a missing
-- terminal webhook.
--
-- A script only flips 'processing' -> 'audio_ready' when a `job.completed`
-- webhook from the voice-engine updates its job row (webhook-handler.ts:174).
-- Line-level results, however, are written DIRECTLY to the DB by the
-- voice-engine worker (webhook-independent). So when the job.completed webhook
-- doesn't arrive (delivery gap), every line finishes with audio but the script
-- is pinned in 'processing' forever, and orphaned 'queued' jobs (from the
-- user cancelling/relaunching a seemingly-stuck script) never terminate.
-- BR1 sat like this for ~18h with 85/85 lines done.
--
-- This derives the truth from line completion (authoritative) instead of
-- depending solely on the webhook — same philosophy as the sync-staleness
-- monitor. Runs every 10 minutes.

CREATE OR REPLACE FUNCTION public.reconcile_stuck_voice_scripts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- 1) A script stuck in 'processing' whose every line is 'completed' — and
  --    with no job launched in the last 15 min (don't race a live job) — is
  --    really done; flip it to audio_ready.
  UPDATE smrtvoice_scripts s
  SET status = 'audio_ready',
      audio_ready_at = now(),
      updated_at = now(),
      completed_lines = (
        SELECT count(*) FROM smrtvoice_lines l
        WHERE l.script_id = s.id AND l.status = 'completed'
      )
  WHERE s.status = 'processing'
    AND s.total_lines > 0
    AND (
      SELECT count(*) FROM smrtvoice_lines l
      WHERE l.script_id = s.id AND l.status = 'completed'
    ) = s.total_lines
    AND NOT EXISTS (
      SELECT 1 FROM smrtvoice_jobs j
      WHERE j.script_id = s.id
        AND j.status IN ('queued', 'running')
        AND j.created_at > now() - interval '15 minutes'
    );

  -- 2) Retire jobs that never reached a terminal state: 'queued' (never even
  --    started — handleJobStarted flips to 'running') for >2h, or 'running'
  --    for >12h. These are orphans whose terminal webhook never arrived; left
  --    alone they keep the UI showing a script "in progress" indefinitely.
  UPDATE smrtvoice_jobs
  SET status = 'cancelled',
      completed_at = now(),
      updated_at = now(),
      error_message = COALESCE(error_message,
        'auto-reconciled: no terminal webhook within timeout (work, if any, was written directly by the worker)')
  WHERE (status = 'queued'  AND created_at < now() - interval '2 hours')
     OR (status = 'running' AND started_at < now() - interval '12 hours');
END $$;

REVOKE EXECUTE ON FUNCTION public.reconcile_stuck_voice_scripts() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('smrtvoice-stuck-reconciler')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtvoice-stuck-reconciler');

SELECT cron.schedule(
  'smrtvoice-stuck-reconciler',
  '*/10 * * * *',
  $$SELECT public.reconcile_stuck_voice_scripts();$$
);
