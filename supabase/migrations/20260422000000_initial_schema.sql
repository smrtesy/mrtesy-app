-- ============================================================
-- Initial schema dump for project: exjnlghuzuvqedlltztz (smrtesy)
-- Generated: 2026-04-22
-- ============================================================

-- ─────────────────────────────────────────
-- TABLES (ordered by dependency)
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.projects (
  id                uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id           uuid        NULL,
  organization_id   uuid        NULL,
  name              text        NOT NULL,
  name_he           text        NULL,
  template_type     text        DEFAULT 'personal'::text NULL,
  parent_id         uuid        NULL,
  gmail_label_id    text        NULL,
  gcal_calendar_id  text        NULL,
  color             text        NULL,
  is_active         boolean     DEFAULT true NULL,
  created_at        timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.source_messages (
  id                    uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id               uuid        NULL,
  source_type           text        NOT NULL,
  source_id             text        NOT NULL,
  source_account        text        NULL,
  sender                text        NULL,
  sender_phone          text        NULL,
  sender_email          text        NULL,
  recipient             text        NULL,
  subject               text        NULL,
  body_text             text        NULL,
  language              text        DEFAULT 'he'::text NULL,
  has_attachments       boolean     DEFAULT false NULL,
  received_at           timestamptz DEFAULT now() NULL,
  processed_at          timestamptz NULL,
  processing_status     text        DEFAULT 'pending'::text NULL,
  ai_classification     text        DEFAULT 'pending'::text NULL,
  detailed_summary      text        NULL,
  is_customer_inquiry   boolean     DEFAULT false NULL,
  ai_extraction         jsonb       NULL,
  source_url            text        NULL,
  scan_run_id           uuid        NULL,
  skip_reason           text        NULL,
  processing_lock_at    timestamptz NULL,
  needs_project_check   boolean     DEFAULT false NULL,
  retry_count           integer     DEFAULT 0 NULL,
  dead_letter           boolean     DEFAULT false NULL,
  created_at            timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id                      uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id                 uuid        NULL,
  project_id              uuid        NULL,
  organization_id         uuid        NULL,
  source_message_id       uuid        NULL,
  contact_id              uuid        NULL,
  title                   text        NOT NULL,
  title_he                text        NULL,
  description             text        NULL,
  task_type               text        DEFAULT 'action'::text NULL,
  priority                text        DEFAULT 'medium'::text NULL,
  status                  text        DEFAULT 'inbox'::text NULL,
  related_contact         text        NULL,
  related_contact_email   text        NULL,
  related_contact_phone   text        NULL,
  due_date                date        NULL,
  due_time                time        NULL,
  reminder_at             timestamptz NULL,
  recurrence_rule         text        NULL,
  snoozed_until           timestamptz NULL,
  snooze_count            integer     DEFAULT 0 NULL,
  tags                    text[]      NULL,
  ai_actions              jsonb       DEFAULT '[]'::jsonb NULL,
  ai_generated_content    jsonb       DEFAULT '[]'::jsonb NULL,
  updates                 jsonb       DEFAULT '[]'::jsonb NULL,
  linked_drive_docs       jsonb       DEFAULT '[]'::jsonb NULL,
  ai_confidence           real        NULL,
  ai_model_used           text        NULL,
  manually_verified       boolean     DEFAULT false NULL,
  seen_at                 timestamptz NULL,
  last_interaction_at     timestamptz DEFAULT now() NULL,
  last_updated_reason     text        DEFAULT 'new'::text NULL,
  status_changed_at       timestamptz DEFAULT now() NULL,
  completed_at            timestamptz NULL,
  created_at              timestamptz DEFAULT now() NULL,
  updated_at              timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.contacts (
  id                    uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id               uuid        NULL,
  name                  text        NOT NULL,
  name_he               text        NULL,
  email                 text        NULL,
  phone                 text        NULL,
  whatsapp_phone        text        NULL,
  organization          text        NULL,
  contact_type          text        NULL,
  tags                  text[]      NULL,
  preferred_language    text        NULL,
  preferred_channel     text        NULL,
  communication_style   text        NULL,
  ai_notes              text        NULL,
  notes                 text        NULL,
  last_interaction_at   timestamptz NULL,
  total_interactions    integer     DEFAULT 0 NULL,
  created_at            timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.user_credentials (
  id            uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id       uuid        NOT NULL,
  service       text        NOT NULL,
  access_token  text        NOT NULL,
  refresh_token text        NULL,
  expires_at    timestamptz NULL,
  scopes        text[]      NULL,
  email         text        NULL
);

CREATE TABLE IF NOT EXISTS public.user_settings (
  id                              uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id                         uuid        NOT NULL,
  plan                            text        DEFAULT 'free'::text NULL,
  display_name                    text        NULL,
  timezone                        text        DEFAULT 'America/New_York'::text NULL,
  office_addresses                text[]      DEFAULT '{}'::text[] NULL,
  skip_senders                    text[]      DEFAULT '{}'::text[] NULL,
  skip_recipients                 text[]      DEFAULT '{}'::text[] NULL,
  my_emails                       text[]      DEFAULT '{}'::text[] NULL,
  drive_folder_id                 text        NULL,
  gmail_connected                 boolean     DEFAULT false NULL,
  drive_connected                 boolean     DEFAULT false NULL,
  whatsapp_connected              boolean     DEFAULT false NULL,
  calendar_connected              boolean     DEFAULT false NULL,
  onboarding_completed            boolean     DEFAULT false NULL,
  initial_setup_completed         boolean     DEFAULT false NULL,
  initial_scan_days_back          integer     DEFAULT 30 NULL,
  calendar_initial_scan_months    integer     DEFAULT 12 NULL,
  calendar_event_filter           text        DEFAULT 'all'::text NULL,
  calendar_allday_tasks           boolean     DEFAULT true NULL,
  calendar_holidays_tasks         boolean     DEFAULT false NULL,
  classification_model            text        DEFAULT 'claude-haiku-4-5-20251001'::text NULL,
  summary_model                   text        DEFAULT 'claude-sonnet-4-6'::text NULL,
  daily_ai_budget_usd             numeric     DEFAULT 1.00 NULL,
  show_ai_costs                   boolean     DEFAULT true NULL,
  reminder_channels               text[]      DEFAULT '{dashboard}'::text[] NULL,
  default_reminder_timing         text        DEFAULT 'day_before'::text NULL,
  preferred_language              text        DEFAULT 'he'::text NULL,
  ai_clarification_prefs          jsonb       DEFAULT '{}'::jsonb NULL,
  initial_scan_started_at         timestamptz NULL,
  initial_scan_completed_at       timestamptz NULL,
  created_at                      timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.sync_state (
  id                      uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id                 uuid        NOT NULL,
  source                  text        NOT NULL,
  last_synced_at          timestamptz DEFAULT now() NULL,
  checkpoint              text        NULL,
  messages_synced_total   integer     DEFAULT 0 NULL,
  last_error              text        NULL,
  retry_count             integer     DEFAULT 0 NULL,
  consecutive_failures    integer     DEFAULT 0 NULL
);

CREATE TABLE IF NOT EXISTS public.log_entries (
  id                      uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id                 uuid        NULL,
  created_at              timestamptz DEFAULT now() NULL,
  level                   text        DEFAULT 'info'::text NULL,
  category                text        NOT NULL,
  status                  text        DEFAULT 'ok'::text NULL,
  source_message_id       uuid        NULL,
  source_type             text        NULL,
  source_id               text        NULL,
  source_url              text        NULL,
  sender                  text        NULL,
  sender_email            text        NULL,
  subject                 text        NULL,
  message_received_at     timestamptz NULL,
  task_id                 uuid        NULL,
  task_title              text        NULL,
  task_action             text        NULL,
  pre_classification      text        NULL,
  ai_classification       text        NULL,
  classification_reason   text        NULL,
  ai_model_used           text        NULL,
  ai_input_tokens         integer     NULL,
  ai_output_tokens        integer     NULL,
  ai_cost_usd             numeric     NULL,
  processing_duration_ms  integer     NULL,
  retry_count             integer     DEFAULT 0 NULL,
  details                 jsonb       DEFAULT '{}'::jsonb NULL,
  error_message           text        NULL
);

CREATE TABLE IF NOT EXISTS public.project_briefs (
  id              uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  project_id      uuid        NULL,
  user_id         uuid        NULL,
  purpose         text        NULL,
  target_audience text        NULL,
  current_status  text        NULL,
  kpis            text        NULL,
  sub_projects    jsonb       DEFAULT '[]'::jsonb NULL,
  weekly_workflow jsonb       DEFAULT '[]'::jsonb NULL,
  systems         jsonb       DEFAULT '[]'::jsonb NULL,
  important_links jsonb       DEFAULT '[]'::jsonb NULL,
  drive_folder_id text        NULL,
  ai_context      text        NULL,
  ai_updated_at   timestamptz NULL,
  created_at      timestamptz DEFAULT now() NULL,
  updated_at      timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.project_credentials (
  id                  uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  project_id          uuid        NULL,
  user_id             uuid        NULL,
  system_name         text        NOT NULL,
  username            text        NULL,
  password_encrypted  text        NULL,
  api_key_encrypted   text        NULL,
  url                 text        NULL,
  notes               text        NULL,
  created_at          timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.reminders (
  id                uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id           uuid        NULL,
  task_id           uuid        NULL,
  remind_at         timestamptz NOT NULL,
  channel           text        DEFAULT 'dashboard'::text NULL,
  message           text        NULL,
  message_he        text        NULL,
  recurrence_rule   text        NULL,
  is_active         boolean     DEFAULT true NULL,
  paused_until      timestamptz NULL,
  next_occurrence   date        NULL,
  title_he          text        NULL,
  source            text        DEFAULT 'manual'::text NULL,
  is_sent           boolean     DEFAULT false NULL,
  sent_at           timestamptz NULL,
  created_at        timestamptz DEFAULT now() NULL
);

CREATE TABLE IF NOT EXISTS public.task_activities (
  id              uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id         uuid        NULL,
  task_id         uuid        NULL,
  activity_type   text        NOT NULL,
  old_value       text        NULL,
  new_value       text        NULL,
  note            text        NULL,
  actor           text        DEFAULT 'system'::text NULL,
  created_at      timestamptz DEFAULT now() NULL
);

-- ─────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────

ALTER TABLE public.log_entries
  ADD CONSTRAINT log_source_msg_fk FOREIGN KEY (source_message_id) REFERENCES public.source_messages(id),
  ADD CONSTRAINT log_task_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id);

ALTER TABLE public.project_briefs
  ADD CONSTRAINT brief_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE public.project_credentials
  ADD CONSTRAINT cred_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE public.reminders
  ADD CONSTRAINT reminders_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);

ALTER TABLE public.task_activities
  ADD CONSTRAINT task_activities_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id),
  ADD CONSTRAINT tasks_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES public.source_messages(id);

-- ─────────────────────────────────────────
-- UNIQUE CONSTRAINTS / INDEXES
-- ─────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS project_briefs_project_id_key ON public.project_briefs USING btree (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS sm_user_source_unique ON public.source_messages USING btree (user_id, source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS sync_state_user_id_source_key ON public.sync_state USING btree (user_id, source);
CREATE UNIQUE INDEX IF NOT EXISTS user_credentials_user_id_service_key ON public.user_credentials USING btree (user_id, service);
CREATE UNIQUE INDEX IF NOT EXISTS user_settings_user_id_key ON public.user_settings USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_contacts_user ON public.contacts USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_source_msg ON public.log_entries USING btree (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_log_entries_task ON public.log_entries USING btree (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_log_entries_user ON public.log_entries USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_briefs_user ON public.project_briefs USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_project_credentials_project ON public.project_credentials USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_project_credentials_user ON public.project_credentials USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON public.projects USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_next ON public.reminders USING btree (next_occurrence, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_reminders_task ON public.reminders USING btree (task_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON public.reminders USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_source_messages_dead ON public.source_messages USING btree (dead_letter) WHERE dead_letter = true;
CREATE INDEX IF NOT EXISTS idx_source_messages_lock ON public.source_messages USING btree (processing_lock_at) WHERE processing_lock_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_messages_user_class ON public.source_messages USING btree (user_id, ai_classification, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_state_user ON public.sync_state USING btree (user_id, source);
CREATE INDEX IF NOT EXISTS idx_task_activities_task ON public.task_activities USING btree (task_id);
CREATE INDEX IF NOT EXISTS idx_task_activities_user ON public.task_activities USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON public.tasks USING btree (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_msg ON public.tasks USING btree (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON public.tasks USING btree (user_id, status, due_date);

-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────

ALTER TABLE public.contacts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.log_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_briefs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_state          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_activities     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credentials    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings       ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_isolation ON public.contacts            FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.log_entries         FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.project_briefs      FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.project_credentials FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.projects            FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.reminders           FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.source_messages     FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.sync_state          FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.task_activities     FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.tasks               FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.user_credentials    FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY user_isolation ON public.user_settings       FOR ALL TO public USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
