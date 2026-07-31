-- Studio unified artifact model — the SPINE (docs/studio-production-pipeline.md).
--
-- Design: "unified spine + per-type detail", NOT one mega-table. studio_artifacts
-- is the single queryable index over every artifact of a project (voice / image /
-- video / character / background / storyboard / …) plus the derivation DAG in
-- studio_artifact_sources. Rich per-type data stays in its own table
-- (experiment_runs for fal runs, smrtvoice_line_takes for voice); the spine
-- REFERENCES it, it does not duplicate it.
--
-- This migration is ADDITIVE and safe: two new tables + a projection trigger that
-- mirrors experiment_runs (image/video) INTO the spine. It touches neither the
-- voice engine nor the existing UI. The voice projection (from smrtvoice_line_takes)
-- is deliberately deferred to the coordinated cross-repo step, and the DAG-edge
-- population waits for the compose feature (nothing writes source links yet).
-- Because nothing reads these tables yet, they are trivially droppable if the
-- design iterates.

-- 1. the spine ----------------------------------------------------------------
create table if not exists public.studio_artifacts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  studio_project_id uuid references public.studio_projects(id) on delete cascade,
  -- the artifact kind. text+CHECK (not a pg enum) so new kinds are a one-line
  -- ALTER, never a type migration.
  type              text not null check (type in (
                      'character','character_angle','background','prop',
                      'storyboard','voice','image','video','lora','control')),
  parent_id         uuid references public.studio_artifacts(id) on delete set null, -- angle → character
  -- optional structural placement (a standalone artifact leaves these null)
  script_id         uuid references public.smrtvoice_scripts(id) on delete set null,
  shot_seq          integer,
  angle             text,                         -- for character_angle: front/side/…
  -- the produced thing
  output_url        text,
  status            text,
  model             text,
  cost_usd          numeric,
  prompt            text,
  -- detail references (spine → per-type rich row; unique so projection upserts)
  experiment_run_id uuid references public.experiment_runs(id) on delete cascade,
  voice_take_id     uuid,   -- → smrtvoice_line_takes(id), wired in the voice step
  voice_line_id     uuid,   -- → smrtvoice_lines(id)
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists studio_artifacts_run_uniq
  on public.studio_artifacts (experiment_run_id) where experiment_run_id is not null;
create unique index if not exists studio_artifacts_take_uniq
  on public.studio_artifacts (voice_take_id) where voice_take_id is not null;
create index if not exists studio_artifacts_project_idx
  on public.studio_artifacts (org_id, studio_project_id, type, created_at desc);
create index if not exists studio_artifacts_shot_idx
  on public.studio_artifacts (script_id, shot_seq);
create index if not exists studio_artifacts_parent_idx
  on public.studio_artifacts (parent_id) where parent_id is not null;

-- 2. the derivation DAG (many-to-many; empty until the compose feature) --------
create table if not exists public.studio_artifact_sources (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  artifact_id        uuid not null references public.studio_artifacts(id) on delete cascade,  -- the derived
  source_artifact_id uuid not null references public.studio_artifacts(id) on delete cascade,  -- the source
  role               text not null check (role in (
                       'character','background','prop','start_frame','end_frame',
                       'keyframe','video_source','audio','reference','lora','control')),
  created_at         timestamptz not null default now(),
  unique (artifact_id, source_artifact_id, role)
);
create index if not exists studio_artifact_sources_artifact_idx
  on public.studio_artifact_sources (artifact_id);
create index if not exists studio_artifact_sources_source_idx
  on public.studio_artifact_sources (source_artifact_id);

-- 3. RLS — the repo's standard org_members policy ------------------------------
do $$
begin
  execute 'alter table public.studio_artifacts enable row level security';
  execute 'drop policy if exists studio_artifacts_org on public.studio_artifacts';
  execute
    'create policy studio_artifacts_org on public.studio_artifacts for all
       using (org_id in (select org_members.org_id from public.org_members
                          where org_members.user_id = (select auth.uid())))
       with check (org_id in (select org_members.org_id from public.org_members
                          where org_members.user_id = (select auth.uid())))';

  execute 'alter table public.studio_artifact_sources enable row level security';
  execute 'drop policy if exists studio_artifact_sources_org on public.studio_artifact_sources';
  execute
    'create policy studio_artifact_sources_org on public.studio_artifact_sources for all
       using (org_id in (select org_members.org_id from public.org_members
                          where org_members.user_id = (select auth.uid())))
       with check (org_id in (select org_members.org_id from public.org_members
                          where org_members.user_id = (select auth.uid())))';
end $$;

-- 4. projection: experiment_runs (image/video) → the spine ---------------------
-- A trigger keeps the spine in sync with fal runs WITHOUT any backend change, so
-- it survives the actively-developed studio UI. It is defensive: a projection
-- error is swallowed (WARNING) so it can NEVER break the source-of-truth write on
-- experiment_runs. Only image/video/voice stages project; anything else is skipped.
create or replace function public.studio_artifacts_sync_from_run()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stage not in ('image','video','voice') then
    return new;
  end if;
  begin
    insert into public.studio_artifacts as a (
      org_id, studio_project_id, type, script_id, shot_seq,
      output_url, status, model, cost_usd, prompt, experiment_run_id, meta, updated_at
    ) values (
      new.org_id, new.studio_project_id, new.stage, new.script_id, new.shot_seq,
      new.output_url, new.run_status, new.model, new.cost_usd, new.prompt, new.id,
      jsonb_build_object('code', new.code, 'seed', new.seed), now()
    )
    on conflict (experiment_run_id) where experiment_run_id is not null
    do update set
      studio_project_id = excluded.studio_project_id,
      type              = excluded.type,
      script_id         = excluded.script_id,
      shot_seq          = excluded.shot_seq,
      output_url        = excluded.output_url,
      status            = excluded.status,
      model             = excluded.model,
      cost_usd          = excluded.cost_usd,
      prompt            = excluded.prompt,
      meta              = a.meta || excluded.meta,
      updated_at        = now();
  exception when others then
    raise warning 'studio_artifacts projection failed for run %: %', new.id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists studio_artifacts_from_run on public.experiment_runs;
create trigger studio_artifacts_from_run
  after insert or update on public.experiment_runs
  for each row execute function public.studio_artifacts_sync_from_run();

-- 5. backfill existing image/video runs ---------------------------------------
insert into public.studio_artifacts (
  org_id, studio_project_id, type, script_id, shot_seq,
  output_url, status, model, cost_usd, prompt, experiment_run_id, meta, created_at, updated_at
)
select r.org_id, r.studio_project_id, r.stage, r.script_id, r.shot_seq,
       r.output_url, r.run_status, r.model, r.cost_usd, r.prompt, r.id,
       jsonb_build_object('code', r.code, 'seed', r.seed), r.created_at, now()
from public.experiment_runs r
where r.stage in ('image','video','voice')
on conflict (experiment_run_id) where experiment_run_id is not null do nothing;
