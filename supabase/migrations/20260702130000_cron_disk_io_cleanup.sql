-- Disk IO budget remediation for the pg_cron scheduler.
--
-- Symptom: the project depleted its Supabase Disk IO budget. Root cause was
-- cron.job_run_details, the pg_cron run-history table, which had grown to
-- ~296k rows / 125 MB since project creation (Apr 2026) with no retention.
-- pg_cron never purges this table on its own, so it accumulated forever and
-- was the dominant source of disk IO (write churn + autovacuum on a bloated
-- relation). A one-time purge + VACUUM FULL reclaimed ~120 MB (125 MB -> 4.4 MB).
--
-- The one-time reclaim was run operationally (DELETE of rows older than 3 days
-- followed by `VACUUM FULL cron.job_run_details;`) and is NOT repeated here --
-- VACUUM FULL cannot run inside a migration transaction. This migration only
-- captures the durable state so a rebuilt database reproduces it:
--   1. a daily job that trims cron history to a 3-day window, and
--   2. suspending the smrtbot-broadcasts job (was running every minute but is
--      not in use).

-- 1. Recurring retention: keep only the last 3 days of cron run history.
--    cron.schedule() upserts by name, so this is safe to re-run.
select cron.schedule(
  'purge-cron-history',
  '30 3 * * *',
  $$delete from cron.job_run_details where start_time < now() - interval '3 days'$$
);

-- 2. Suspend the unused every-minute broadcast job (reversible: sets
--    active=false rather than unscheduling, so it can be re-enabled later via
--    cron.alter_job(job_id, active := true)). Look the job up by name so this
--    is stable across environments where the jobid differs.
do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'smrtbot-broadcasts';
  if v_jobid is not null then
    perform cron.alter_job(job_id := v_jobid, active := false);
  end if;
end $$;
