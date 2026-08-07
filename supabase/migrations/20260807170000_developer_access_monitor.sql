-- Stage 1b (security-hardening): state tables for the developer-access monitor.
-- See docs/developer-access-monitor-plan.md.
--
-- The monitor is a backend cron job that pulls postgres_logs for db-role `developer`,
-- geo-locates new client IPs, and writes anomalies to log_entries (level='error') so
-- the existing trg_notify_superadmins_on_error alert path fires.
--
-- SECURITY NOTE: the `developer` role has ALL on public (incl. future tables via
-- default privileges), so it would otherwise be able to READ or TAMPER with its own
-- monitor state (delete baseline rows / advance the checkpoint to skip its activity).
-- We therefore REVOKE its access to these two tables explicitly. The developer cannot
-- re-grant (not owner, NOCREATEROLE), so the wall holds.

CREATE TABLE IF NOT EXISTS public.developer_access_baseline (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  db_user       text        NOT NULL,
  ip            inet        NOT NULL,
  country       text,                 -- ISO country code from geo-IP (null if unresolved)
  asn           text,                 -- ASN / org string from geo-IP
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (db_user, ip)
);
COMMENT ON TABLE public.developer_access_baseline IS
  'Known (db_user, ip) pairs seen by the developer-access monitor, with resolved country/ASN. New country/ASN => alert; new IP in known country => log only.';

CREATE TABLE IF NOT EXISTS public.developer_access_checkpoint (
  db_user           text        PRIMARY KEY,
  last_processed_at timestamptz NOT NULL,   -- high-water mark: last log timestamp processed
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.developer_access_checkpoint IS
  'High-water mark per db_user for the developer-access monitor log sweep.';

-- Start monitoring from now; do not sweep historical logs on first run.
INSERT INTO public.developer_access_checkpoint (db_user, last_processed_at)
VALUES ('developer', now())
ON CONFLICT (db_user) DO NOTHING;

-- Keep the monitored role OUT of its own monitor state.
REVOKE ALL ON public.developer_access_baseline   FROM developer;
REVOKE ALL ON public.developer_access_checkpoint FROM developer;

-- Defense in depth: RLS on, no policies => only BYPASSRLS service_role reaches them
-- (the REVOKE above is what actually stops `developer`, which also has BYPASSRLS).
ALTER TABLE public.developer_access_baseline   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.developer_access_checkpoint ENABLE ROW LEVEL SECURITY;
