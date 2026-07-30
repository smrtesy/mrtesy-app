-- Stage C of docs/studio-build-plan.md: full run provenance + the media bucket.
--
-- experiment_runs was born for the lab harness, which recorded a DESCRIPTION
-- of a run (model/method/prompt). The studio runner needs the CONTRACT of the
-- run: the exact endpoint, the exact payload after defaults, the fal request
-- id (join key to billing), and a status machine a webhook/poller can drive.
-- All columns are additive and nullable — no existing row or query breaks.

alter table public.experiment_runs
  add column if not exists endpoint_id     text,
  add column if not exists input_args      jsonb,
  add column if not exists fal_request_id  text,
  add column if not exists recipe_source   text,
  add column if not exists run_status      text
    check (run_status is null or run_status in
      ('pending','submitted','completed','downloaded','failed')),
  add column if not exists error           text,
  add column if not exists derived_from    uuid references public.experiment_runs(id) on delete set null,
  add column if not exists qc_cost_usd     numeric;

create index if not exists experiment_runs_fal_request_idx
  on public.experiment_runs (fal_request_id) where fal_request_id is not null;
create index if not exists experiment_runs_status_idx
  on public.experiment_runs (org_id, run_status)
  where run_status in ('pending','submitted');

-- Write-once provenance: once the identity of a run is recorded it can never
-- be edited in place — a re-run is a NEW row with derived_from pointing back.
-- Status/cost/output fields stay updatable (that's the webhook's job).
create or replace function public.studio_runs_write_once()
returns trigger language plpgsql as $$
begin
  if old.endpoint_id is not null and new.endpoint_id is distinct from old.endpoint_id then
    raise exception 'experiment_runs.endpoint_id is write-once (run %)', old.id;
  end if;
  if old.input_args is not null and new.input_args is distinct from old.input_args then
    raise exception 'experiment_runs.input_args is write-once (run %)', old.id;
  end if;
  if old.fal_request_id is not null and new.fal_request_id is distinct from old.fal_request_id then
    raise exception 'experiment_runs.fal_request_id is write-once (run %)', old.id;
  end if;
  return new;
end $$;

drop trigger if exists studio_runs_write_once on public.experiment_runs;
create trigger studio_runs_write_once
  before update on public.experiment_runs
  for each row execute function public.studio_runs_write_once();

-- The studio media shelf: outputs are downloaded here IMMEDIATELY on
-- completion (fal links die after 24h). Path convention: <org_id>/<run_uuid>/<n>
-- — keyed by run UUID, never the short display code (codes can collide).
insert into storage.buckets (id, name, public)
values ('studio-media', 'studio-media', false)
on conflict (id) do nothing;

drop policy if exists "studio_media_org_read" on storage.objects;
create policy "studio_media_org_read" on storage.objects
  for select
  using (
    bucket_id = 'studio-media'
    and (storage.foldername(name))[1] in (
      select org_id::text from public.org_members
      where user_id = (select auth.uid())
    )
  );
-- Writes go through the service role only (the runner) — no insert policy.

-- The webhook-loss safety net: every 5 minutes, sweep runs stuck in
-- `submitted`. Reuses the sweep's Vault secrets (same host, same shared
-- secret) — the poll URL is derived from the sweep URL, so one provisioning
-- step covers both. Free: status reads only, never an inference call.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[studio poll-runs] pg_cron/pg_net not installed — skipping.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_secret') THEN
    RAISE NOTICE '[studio poll-runs] Vault secrets not set — skipping schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('smrtstudio-poll-runs')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtstudio-poll-runs');

  PERFORM cron.schedule(
    'smrtstudio-poll-runs',
    '*/5 * * * *',
    $cron$
      SELECT net.http_post(
        url     := replace(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_url'),
          '/sweep', '/poll-runs'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_secret')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cron$
  );
END $$;
