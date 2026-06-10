-- Egress reduction: ai-process and batch-details ran every minute, and the
-- vast majority of ticks found no pending work — each idle tick still cost
-- several PostgREST round trips (lock sweep + selects), which dominated the
-- free-plan egress quota. Every 3 minutes is plenty: gmail-sync feeds new
-- messages every 2 minutes, so worst-case added processing latency is ~3 min.
-- (Paired with an idle-probe early-exit inside both edge functions.)
--
-- Guarded so the migration is a no-op on environments where the jobs were
-- never scheduled (fresh/local stacks) instead of failing the chain on a
-- NULL jobid.

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'batch-details';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(jid, schedule => '*/3 * * * *');
  END IF;

  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'ai-process-every-minute';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(jid, schedule => '*/3 * * * *');
  END IF;
END $$;
