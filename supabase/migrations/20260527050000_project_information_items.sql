-- project_information_items: individual pieces of saved info, tagged with a project.
-- Created as part of the "save_info" router intent (Feature A).

create table if not exists project_information_items (
  id                         uuid        primary key default gen_random_uuid(),
  user_id                    uuid        not null references auth.users(id) on delete cascade,
  organization_id            uuid        not null references organizations(id) on delete cascade,
  project_id                 uuid        references projects(id) on delete set null,
  title                      text        not null,
  body                       text        not null default '',
  source                     text        not null default 'router'
                               check (source in ('router', 'manual')),
  source_router_decision_id  uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

alter table project_information_items enable row level security;

create policy "users own their info items"
  on project_information_items
  for all
  using (user_id = auth.uid());

create index on project_information_items(organization_id, project_id);
create index on project_information_items(user_id, created_at desc);
