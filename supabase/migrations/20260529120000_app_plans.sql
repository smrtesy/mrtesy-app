-- app_plans — per-app plan / spec documents (markdown).
--
-- This table already exists on the live project (it was created out-of-band
-- and the smrtPlan architecture doc was written into it), but had no tracked
-- migration. The admin app-detail "Documents" card reads from it, so we record
-- the schema here for repo fidelity. Written idempotently (IF NOT EXISTS) so
-- running it against the existing project is a no-op.
--
-- Access is service-role only (the /admin Documents page reads with the
-- service-role client); RLS is enabled with no policies so anon/auth roles
-- can't read tenant plans directly.

create table if not exists app_plans (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        references organizations(id),
  app_slug    text        not null references apps(slug),
  title       text        not null,
  content     text        not null default '',
  doc_type    text        not null default 'spec'
                check (doc_type in ('spec', 'idea', 'architecture', 'notes')),
  version     integer     not null default 1,
  is_current  boolean     not null default true,
  created_by  uuid        references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists app_plans_app_slug_idx on app_plans (app_slug);

alter table app_plans enable row level security;
