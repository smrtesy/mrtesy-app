-- smrtStudio — the unified AI-video production-management layer.
--
-- Purely ADDITIVE: no existing table is altered or dropped. smrtStudio reads
-- the production data that already exists (experiment_runs, experiment_scores,
-- smrtvoice_*) and adds only the management spine on top of it:
--
--   studio_stages      — the pipeline, with TWO independent axes of state
--                        (activity × decision_state), so returning to research
--                        never voids a decision that was already made.
--   studio_gates       — every decision/check a stage must pass to be settled.
--   studio_challenges  — difficulties, split expected-vs-encountered, each with
--                        how it was solved. Nothing is deleted when solved.
--   studio_research    — the research index: one row per research artifact,
--                        what it decides, which file holds it, when verified.
--   studio_models      — the fal catalog shelf (auto-indexed) plus the
--                        deep-verified entries. `verified_schema` separates
--                        "listed by fal" from "we pulled its OpenAPI schema".
--   studio_investment  — the hours/value ledger shown on the investor page.
--
-- All tables are org-scoped with the repo's standard org_members RLS policy.

-- 1. stages -------------------------------------------------------------------
create table if not exists public.studio_stages (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  slug           text not null,
  position       integer not null,
  name_he        text not null,
  name_en        text not null,
  blurb_he       text not null default '',
  blurb_en       text not null default '',
  hue            integer not null default 210,
  -- axis 1: is anyone working on it right now
  activity       text not null default 'idle'
                   check (activity in ('idle','research','running','scoring','blocked')),
  -- axis 2: has the method been settled — independent of activity
  decision_state text not null default 'none'
                   check (decision_state in ('none','testing','decided','locked')),
  note_he        text not null default '',
  note_en        text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, slug)
);

-- 2. gates — what must pass before a stage can be settled ----------------------
create table if not exists public.studio_gates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  stage_slug  text not null,
  position    integer not null default 0,
  label_he    text not null,
  label_en    text not null,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Stable identity for a gate, so re-seeding updates its wording and never
  -- resets the `done` flag an operator set.
  unique (org_id, stage_slug, position)
);

-- 3. challenges — expected vs actually hit ------------------------------------
create table if not exists public.studio_challenges (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  stage_slug   text not null,
  position     integer not null default 0,
  -- 'expected' = mapped from research before running
  -- 'hit'      = actually encountered while running or researching
  kind         text not null default 'expected' check (kind in ('expected','hit')),
  title_he     text not null,
  title_en     text not null,
  solved       boolean not null default false,
  detail_he    text not null default '',
  detail_en    text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Same reasoning as studio_gates: identity is (stage, kind, position) so a
  -- re-seed refreshes the wording and leaves `solved` alone.
  unique (org_id, stage_slug, kind, position)
);

-- 4. research index -----------------------------------------------------------
create table if not exists public.studio_research (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- a stage slug, or 'cross' for research that spans the whole pipeline
  stage_slug   text not null default 'cross',
  position     integer not null default 0,
  title_he     text not null,
  title_en     text not null,
  decides_he   text not null default '',
  decides_en   text not null default '',
  -- repo-relative source files, ' · ' separated, kept verbatim so a reader can
  -- open exactly the file that holds the finding
  sources      text not null default '',
  repo         text not null default 'video-lab',
  verified_at  date,
  status       text not null default 'locked'
                 check (status in ('draft','locked','applied','living','superseded')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 5. model catalog ------------------------------------------------------------
create table if not exists public.studio_models (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  endpoint_id      text not null,
  title            text not null default '',
  category         text not null default '',
  -- our own bucket, coarser than fal's category: image|video|lipsync|voice|qc|other
  kind             text not null default 'other',
  vendor           text not null default '',
  hosting_type     text not null default '',      -- serverless | proxy
  license_type     text not null default '',
  deprecated       boolean not null default false,
  price_note       text not null default '',
  price_usd        numeric,
  price_unit       text not null default '',
  -- shelf vs deep entry: true only once we pulled the official OpenAPI schema
  verified_schema  boolean not null default false,
  verified_at      date,
  shortlist_rank   integer,
  recipe_path      text not null default '',
  flags            jsonb not null default '[]'::jsonb,
  source_url       text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, endpoint_id)
);

-- 6. investment ledger --------------------------------------------------------
create table if not exists public.studio_investment (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  position    integer not null default 0,
  label_he    text not null,
  label_en    text not null,
  hours       numeric,
  value_usd   numeric not null default 0,
  detail_he   text not null default '',
  detail_en   text not null default '',
  -- work   = hours invested · direct = money already spent on AI services
  -- ask    = a tranche of the funding request · ask_total = the headline ask
  kind        text not null default 'work'
                check (kind in ('work','direct','ask','ask_total')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- indexes ---------------------------------------------------------------------
create index if not exists studio_stages_org_idx      on public.studio_stages (org_id, position);
create index if not exists studio_gates_org_idx       on public.studio_gates (org_id, stage_slug, position);
create index if not exists studio_challenges_org_idx  on public.studio_challenges (org_id, stage_slug, kind, position);
create index if not exists studio_research_org_idx    on public.studio_research (org_id, stage_slug, position);
create index if not exists studio_models_org_idx      on public.studio_models (org_id, kind, shortlist_rank);
create index if not exists studio_models_verified_idx on public.studio_models (org_id, verified_schema);
create index if not exists studio_investment_org_idx  on public.studio_investment (org_id, position);

-- updated_at triggers ---------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['studio_stages','studio_gates','studio_challenges',
                           'studio_research','studio_models','studio_investment']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- RLS -------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['studio_stages','studio_gates','studio_challenges',
                           'studio_research','studio_models','studio_investment']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_org on public.%I', t, t);
    execute format(
      'create policy %I_org on public.%I for all
         using (org_id in (select org_members.org_id from public.org_members
                            where org_members.user_id = (select auth.uid())))
         with check (org_id in (select org_members.org_id from public.org_members
                            where org_members.user_id = (select auth.uid())))', t, t);
  end loop;
end $$;

-- 7. app registration -----------------------------------------------------------
-- requireApp("smrtstudio") resolves the slug through public.apps and checks the
-- org's entitlement in app_memberships. Without both, every route 403s.
insert into public.apps (slug, name, description)
values ('smrtstudio','smrtStudio','ניהול הפקת סרטוני AI — צינור, מודלים, מחקרים, ניקוד ופרובננס')
on conflict (slug) do update set name = excluded.name, description = excluded.description;

-- Entitle ONLY the orgs that already run the video program (they have runs in
-- experiment_runs). Enabling it for every org would hand a second tenant this
-- tenant's pipeline; a new org gets smrtStudio through the admin screen, the
-- same way it gets every other app.
--
-- `enabled_by` is NOT NULL (FK → auth.users), so it is filled with the org's
-- creator: a system-granted entitlement still has to name an accountable user.
insert into public.app_memberships (org_id, app_id, enabled_by)
select o.id, a.id, o.created_by
from public.organizations o
cross join public.apps a
where a.slug = 'smrtstudio'
  and exists (select 1 from public.experiment_runs r where r.org_id = o.id)
on conflict do nothing;
