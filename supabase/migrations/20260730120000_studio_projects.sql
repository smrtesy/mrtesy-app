-- Stage A of docs/studio-build-plan.md: the unified project spine.
--
-- Adds studio_projects and links the two existing production families to it —
-- voice projects (smrtvoice_projects) and fal runs (experiment_runs) — with
-- nullable FKs and a full backfill, so no existing query breaks and the three
-- project tabs (voice / image / video) are populated from day one.

-- 1. the spine ----------------------------------------------------------------
create table if not exists public.studio_projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  created_by     uuid references auth.users(id),
  name_he        text not null,
  name_en        text not null default '',
  description_he text not null default '',
  description_en text not null default '',
  status         text not null default 'active' check (status in ('active','archived')),
  -- optional link back to the smrtplan plan this project tracks (the video
  -- program plan today); the backfill below keys on it.
  plan_id        uuid references public.smrtplan_plans(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists studio_projects_org_idx
  on public.studio_projects (org_id, status, created_at desc);
-- One project per plan when linked — the backfill relies on it being stable.
create unique index if not exists studio_projects_plan_uniq
  on public.studio_projects (org_id, plan_id) where plan_id is not null;

-- 2. links from the existing families (nullable — additive only) ---------------
alter table public.smrtvoice_projects
  add column if not exists studio_project_id uuid references public.studio_projects(id) on delete set null;
create index if not exists smrtvoice_projects_studio_idx
  on public.smrtvoice_projects (studio_project_id);

alter table public.experiment_runs
  add column if not exists studio_project_id uuid references public.studio_projects(id) on delete set null;
create index if not exists experiment_runs_studio_idx
  on public.experiment_runs (org_id, studio_project_id);

-- 3. RLS — the repo's standard org_members policy ------------------------------
do $$
begin
  execute 'alter table public.studio_projects enable row level security';
  execute 'drop policy if exists studio_projects_org on public.studio_projects';
  execute
    'create policy studio_projects_org on public.studio_projects for all
       using (org_id in (select org_members.org_id from public.org_members
                          where org_members.user_id = (select auth.uid())))
       with check (org_id in (select org_members.org_id from public.org_members
                          where org_members.user_id = (select auth.uid())))';
end $$;

-- 4. backfill -------------------------------------------------------------------
-- 4a. a project per smrtplan plan that already has runs (the video program),
--     so the image/video tabs are not empty on day one.
insert into public.studio_projects (org_id, name_he, name_en, plan_id)
select p.org_id, p.title_he, coalesce(p.title_en, ''), p.id
from public.smrtplan_plans p
where exists (select 1 from public.experiment_runs r where r.plan_id = p.id)
on conflict do nothing;

update public.experiment_runs r
set studio_project_id = sp.id
from public.studio_projects sp
where sp.plan_id = r.plan_id
  and sp.org_id = r.org_id
  and r.studio_project_id is null
  and r.plan_id is not null;

-- 4b. voice projects join the SAME plan-project when the org has exactly one
--     video-program project (the current reality: one operator, one program);
--     otherwise each voice project becomes its own studio project (v3 §2a 1:1).
with plan_projects as (
  select org_id, min(id::text)::uuid as sp_id, count(*) as n
  from public.studio_projects
  where plan_id is not null
  group by org_id
)
update public.smrtvoice_projects v
set studio_project_id = pp.sp_id
from plan_projects pp
where pp.org_id = v.org_id
  and pp.n = 1
  and v.studio_project_id is null;

-- Per-row loop, not a name-join: two voice projects can share a name, and a
-- name-join would fuse them into one studio project (or cross-link them).
do $$
declare v record; new_id uuid;
begin
  for v in
    select id, org_id, created_by, name
    from public.smrtvoice_projects
    where studio_project_id is null
  loop
    insert into public.studio_projects (org_id, created_by, name_he)
    values (v.org_id, v.created_by, v.name)
    returning id into new_id;
    update public.smrtvoice_projects set studio_project_id = new_id where id = v.id;
  end loop;
end $$;
