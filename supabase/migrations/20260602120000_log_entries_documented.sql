-- log_entries — the platform's structured run/error log.
--
-- This table already exists on the live project (it predates the tracked
-- migration history — the original smrtTask build created it out-of-band), but
-- had no migration on record. Server code across smrtTask and platform services
-- writes to it, the admin "Logs" page reads from it, and the
-- 20260527060000_error_notifications_trigger trigger fires on every row where
-- level = 'error'. We record the schema here for repo fidelity.
--
-- Written idempotently (IF NOT EXISTS + guarded constraint/policy blocks) so
-- running it against the existing project is a no-op, and a fresh database gets
-- the same shape regardless of whether the smrtTask tables it soft-references
-- (tasks, source_messages) have been created yet.

create table if not exists log_entries (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        references auth.users(id) on delete cascade,
  created_at             timestamptz default now(),
  level                  text        default 'info'
                           constraint log_entries_level_check
                           check (level in ('info', 'warning', 'error')),
  category               text        not null,
  status                 text        default 'ok'
                           constraint log_entries_status_check
                           check (status in ('ok', 'skipped', 'failed', 'duplicate')),
  -- Source context (where the logged work came from)
  source_message_id      uuid,
  source_type            text,
  source_id              text,
  source_url             text,
  sender                 text,
  sender_email           text,
  subject                text,
  message_received_at    timestamptz,
  -- Task context (smrtTask)
  task_id                uuid,
  task_title             text,
  task_action            text,
  pre_classification     text,
  ai_classification      text,
  classification_reason  text,
  -- AI usage / cost accounting
  ai_model_used          text,
  ai_input_tokens        integer,
  ai_output_tokens       integer,
  ai_cost_usd            numeric,
  processing_duration_ms integer,
  retry_count            integer     default 0,
  -- Free-form structured payload + human-readable error
  details                jsonb       default '{}'::jsonb,
  error_message          text
);

-- Soft FKs to smrtTask tables: added only when those tables already exist, so a
-- fresh DB that hasn't created them yet still applies this migration cleanly.
do $$
begin
  if to_regclass('public.source_messages') is not null
     and not exists (select 1 from pg_constraint where conname = 'log_source_msg_fk') then
    alter table log_entries
      add constraint log_source_msg_fk
      foreign key (source_message_id) references source_messages(id) on delete set null;
  end if;

  if to_regclass('public.tasks') is not null
     and not exists (select 1 from pg_constraint where conname = 'log_task_fk') then
    alter table log_entries
      add constraint log_task_fk
      foreign key (task_id) references tasks(id) on delete set null;
  end if;
end $$;

create index if not exists idx_log_entries_user
  on log_entries (user_id, created_at desc);
create index if not exists idx_log_entries_source_msg
  on log_entries (source_message_id) where source_message_id is not null;
create index if not exists idx_log_entries_task
  on log_entries (task_id) where task_id is not null;

alter table log_entries enable row level security;

-- Owners see only their own rows (writes are typically service-role).
drop policy if exists user_isolation on log_entries;
create policy user_isolation on log_entries
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
