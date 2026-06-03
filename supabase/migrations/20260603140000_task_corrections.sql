-- task_corrections — user-authored corrections/feedback on smrtTask log entries.
--
-- Every time the user fixes how the AI classified (or otherwise handled) an
-- item in the smrtTask log, they can attach a free-text explanation and tag the
-- correction with a SCOPE:
--   • 'general'  — a fix that is true for ALL users; belongs in the shared
--                  rules/prompt. Exported so Claude Code can bake it into the
--                  global classifier prompt / rule set.
--   • 'personal' — a fix that applies only to this user's own classification.
--                  Exported so Claude Code can add it as a per-user rule.
--
-- The export flow (see correction_exports) marks rows as exported so the user
-- always knows what has already been handed to Claude Code and what is new.
--
-- Written idempotently so it is safe to re-run.

create table if not exists task_corrections (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  organization_id     uuid,
  app_slug            text        not null default 'smrttask',

  -- What was corrected (soft references — the underlying rows may be pruned).
  source_message_id   uuid,
  task_id             uuid,
  log_entry_id        uuid,

  -- The kind of fix.
  correction_type     text        not null default 'reclassify'
                        constraint task_corrections_type_check
                        check (correction_type in ('reclassify', 'status', 'note', 'other')),
  field               text,                 -- e.g. 'ai_classification'
  old_value           text,
  new_value           text,

  -- The explanation + who it applies to.
  note                text        not null,
  scope               text        not null
                        constraint task_corrections_scope_check
                        check (scope in ('general', 'personal')),

  -- Comprehensive snapshot of the source/log context at correction time, so an
  -- export is fully self-contained even if the source row later changes/deletes.
  context             jsonb       not null default '{}'::jsonb,

  -- Export tracking.
  exported_at         timestamptz,
  export_batch_id     uuid,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- correction_exports — one row per export the user generates. Lets the UI show
-- a history of "what I already exported" and group corrections by batch.
create table if not exists correction_exports (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  organization_id     uuid,
  app_slug            text        not null default 'smrttask',
  scope_filter        text        not null default 'all'
                        constraint correction_exports_scope_filter_check
                        check (scope_filter in ('all', 'general', 'personal')),
  correction_count    integer     not null default 0,
  created_at          timestamptz not null default now()
);

-- Soft FKs: only added when the referenced tables already exist, so a fresh DB
-- that hasn't created the smrtTask tables yet still applies this cleanly.
do $$
begin
  if to_regclass('public.source_messages') is not null
     and not exists (select 1 from pg_constraint where conname = 'task_corrections_source_msg_fk') then
    alter table task_corrections
      add constraint task_corrections_source_msg_fk
      foreign key (source_message_id) references source_messages(id) on delete set null;
  end if;

  if to_regclass('public.tasks') is not null
     and not exists (select 1 from pg_constraint where conname = 'task_corrections_task_fk') then
    alter table task_corrections
      add constraint task_corrections_task_fk
      foreign key (task_id) references tasks(id) on delete set null;
  end if;

  if to_regclass('public.correction_exports') is not null
     and not exists (select 1 from pg_constraint where conname = 'task_corrections_batch_fk') then
    alter table task_corrections
      add constraint task_corrections_batch_fk
      foreign key (export_batch_id) references correction_exports(id) on delete set null;
  end if;
end $$;

create index if not exists idx_task_corrections_user
  on task_corrections (user_id, created_at desc);
create index if not exists idx_task_corrections_pending
  on task_corrections (user_id, scope) where exported_at is null;
create index if not exists idx_task_corrections_source_msg
  on task_corrections (source_message_id) where source_message_id is not null;
create index if not exists idx_task_corrections_task
  on task_corrections (task_id) where task_id is not null;
create index if not exists idx_correction_exports_user
  on correction_exports (user_id, created_at desc);

alter table task_corrections  enable row level security;
alter table correction_exports enable row level security;

-- Owners see/manage only their own rows. Server writes use the service role
-- (which bypasses RLS); these policies guard any future direct client access.
drop policy if exists task_corrections_owner on task_corrections;
create policy task_corrections_owner on task_corrections
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists correction_exports_owner on correction_exports;
create policy correction_exports_owner on correction_exports
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
