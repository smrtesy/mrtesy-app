-- Experiment runs + blind per-scorer scores for the video-lab pipeline (mini-doc פ-0).
-- The harness (service-role) WRITES runs; the app (user session) reads + scores.
-- Idempotent: safe if the Supabase deploy action re-runs it (already applied via MCP).

create table if not exists public.experiment_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  plan_id uuid references public.smrtplan_plans(id) on delete set null,
  task_id uuid,
  stage text,                 -- 'image' | 'video' | 'lipsync' | 'produce'
  test_label text,            -- 'test-a' | 'test-b' | 'test-lipsync' | 'produce-scene' ...
  code text not null,         -- VISIBLE blind code name
  model text,                 -- HIDDEN until a score is locked
  method text,                -- input method used (per the model's recipe)
  prompt text,
  seed bigint,
  cost_usd numeric,
  output_url text,            -- our stored copy (fal links die after 24h)
  scene text,
  variation int,
  repeat_idx int,
  meta jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.experiment_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null references public.experiment_runs(id) on delete cascade,
  scorer_id uuid,             -- null = invited share-link guest
  scorer_label text,          -- name for guest scorers
  dimension text not null default 'overall', -- consistency|motion|quality|lipsync|overall
  score int not null check (score between 1 and 5),
  locked boolean not null default false,     -- model revealed only after locked
  created_at timestamptz not null default now(),
  unique (run_id, scorer_id, dimension)
);

create index if not exists experiment_runs_org_plan_idx on public.experiment_runs (org_id, plan_id);
create index if not exists experiment_runs_org_test_idx on public.experiment_runs (org_id, test_label);
create index if not exists experiment_scores_run_idx on public.experiment_scores (run_id);
create index if not exists experiment_scores_org_idx on public.experiment_scores (org_id);

alter table public.experiment_runs enable row level security;
alter table public.experiment_scores enable row level security;

drop policy if exists experiment_runs_org on public.experiment_runs;
create policy experiment_runs_org on public.experiment_runs for all
  using (org_id in (select org_members.org_id from public.org_members where org_members.user_id = (select auth.uid())))
  with check (org_id in (select org_members.org_id from public.org_members where org_members.user_id = (select auth.uid())));

drop policy if exists experiment_scores_org on public.experiment_scores;
create policy experiment_scores_org on public.experiment_scores for all
  using (org_id in (select org_members.org_id from public.org_members where org_members.user_id = (select auth.uid())))
  with check (org_id in (select org_members.org_id from public.org_members where org_members.user_id = (select auth.uid())));
