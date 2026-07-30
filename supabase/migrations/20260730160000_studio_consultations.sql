-- Stage F of docs/studio-build-plan.md: the consultation pipeline.
--
-- One row = one "יש לי בעיה" filed against one artifact. The row carries the
-- FULL provenance snapshot in `payload` (the expert-agent contract: every
-- problem question arrives attached to its artifact — provenance is read,
-- never asked for), the expert's structured answer in `answer`
-- ({diagnosis, solutions[], rejected[]}), and the runs that executing the
-- chosen solutions produced.
--
-- SECURITY: RLS enabled with NO policy on purpose (the smrtvault/info_facts
-- pattern) — all access goes through the service-role Express server, which
-- scopes every query by org_id.

create table if not exists public.studio_consultations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  studio_project_id  uuid not null references public.studio_projects(id) on delete cascade,
  -- restrict, not cascade: a consultation records real money decisions —
  -- deleting the consulted run must not silently erase them (org cascade
  -- still cleans a whole tenant).
  run_id             uuid not null references public.experiment_runs(id) on delete restrict,
  -- nullable + set null: the audit trail outlives the user account.
  created_by         uuid references auth.users(id) on delete set null,

  -- 'executing' is the execute-route's claim slot: taken with a conditional
  -- update so two approvals cannot both submit (and pay) for the same
  -- selection.
  status             text not null default 'open'
                       check (status in ('open','answered','executing','executed','closed')),
  problem            text not null,
  -- provenance snapshot at filing time (run row fields; frozen even if the
  -- run is later touched)
  payload            jsonb not null default '{}'::jsonb,
  -- the expert's answer: { diagnosis, solutions: [{title, changes, evidence,
  -- est_cost, risk, move}], rejected: [...] } — the /expert JSON contract
  answer             jsonb,
  answered_at        timestamptz,
  -- runs created by executing chosen solutions (derived_from = run_id)
  executed_run_ids   uuid[] not null default '{}',
  -- the smrtTask consultation task that was filed for pickup
  task_id            uuid,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.studio_consultations enable row level security;

create index if not exists studio_consultations_project_idx
  on public.studio_consultations (org_id, studio_project_id, status);
create index if not exists studio_consultations_run_idx
  on public.studio_consultations (run_id);
