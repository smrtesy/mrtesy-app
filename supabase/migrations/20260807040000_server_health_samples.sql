-- Passive backend health telemetry.
--
-- Why this table exists: the browser-side "CORS" errors on app.smrtesy.com are
-- actually intermittent Railway 502s (a 502 from the edge carries no CORS header,
-- so the browser mislabels it). Those 502s happen when the single backend process
-- is event-loop-starved — most often by concurrent in-app Claude console runs that
-- spawn heavy child processes in the SAME process. Client-side telemetry can't
-- capture this: the error-report POST rides the same failing backend, so it dies
-- with the patient. This table is the server's OWN measurement, sampled every ~30s
-- by server/src/lib/health-sampler.ts — it records the CAUSE (active_runs) and the
-- EFFECT (event-loop lag) in the same row, plus each provider's state, so "did a
-- fix help?" becomes a query instead of a synthetic load test. Feeds the sidebar
-- SystemStatusStrip history popover. Retained 14 days (the sampler prunes).

create table if not exists public.server_health_samples (
  id              bigint generated always as identity primary key,
  captured_at     timestamptz not null default now(),
  -- Event-loop delay over the last sample window (perf_hooks.monitorEventLoopDelay),
  -- ns→ms. p99 is the direct "the process is choking" signal.
  loop_lag_p50_ms numeric(10,2),
  loop_lag_p99_ms numeric(10,2),
  -- In-flight Claude console runs in this process at sample time (runner.activeRunCount()).
  active_runs     integer,
  rss_mb          numeric(10,1),
  uptime_s        integer,
  replica_id      text,
  -- Each surface's normalized state at sample time (ready/building/warn/error/unknown),
  -- refreshed on a slower cadence than the 30s row and stamped onto every row, so the
  -- history shows when the frontend (F) or database (DB) went red too.
  vercel_state    text,
  railway_state   text,
  supabase_state  text
);

create index if not exists server_health_samples_captured_at_idx
  on public.server_health_samples (captured_at desc);

comment on table public.server_health_samples is
  'Passive backend health telemetry sampled ~every 30s by server/src/lib/health-sampler.ts. Feeds the SystemStatusStrip history popover. Retained 14 days (sampler prunes).';

-- Access is only ever through the super-admin-gated backend endpoint using the
-- service-role key (which bypasses RLS). Enable RLS with NO policies so anon /
-- authenticated PostgREST roles can never read the telemetry directly.
alter table public.server_health_samples enable row level security;
