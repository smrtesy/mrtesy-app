-- Indexes for the hot query paths surfaced by the system-wide performance
-- audit (pg_stat_user_tables seq-scan counts + code-path review).
-- All column names verified against the live schema.

-- ai-process cron poller: pending-message pickup every 3 minutes
-- (source_messages had no index covering this; the poller filters
-- processing_status + lock and orders by received_at)
CREATE INDEX IF NOT EXISTS idx_source_messages_pending
  ON public.source_messages (user_id, source_type, received_at)
  WHERE processing_status = 'pending' AND processing_lock_at IS NULL;

-- WhatsApp thread grouping filters on metadata JSON paths per message
CREATE INDEX IF NOT EXISTS idx_source_messages_meta_chat
  ON public.source_messages (user_id, source_type, ((metadata->>'chatId')));
CREATE INDEX IF NOT EXISTS idx_source_messages_meta_thread
  ON public.source_messages (user_id, source_type, ((metadata->>'threadId')));

-- Meta status webhooks (sent/delivered/read/failed) look up by bare wamid;
-- the existing UNIQUE(user_id, wamid) index cannot serve that
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_wamid
  ON public.whatsapp_messages (wamid);

-- Main task list: org + status filters ordered by created_at
CREATE INDEX IF NOT EXISTS idx_tasks_org_status_created
  ON public.tasks (organization_id, status, created_at DESC);

-- ai-process duplicate detection / cascade lookups by source message
CREATE INDEX IF NOT EXISTS idx_tasks_source_message
  ON public.tasks (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- reminders-check cron: due-reminder scan every 5 minutes
CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON public.reminders (remind_at)
  WHERE is_active = true AND is_sent = false;

-- smrtreach inbound WA status webhook looks up by wa_message_id
CREATE INDEX IF NOT EXISTS idx_smrtreach_logs_wa_msg
  ON public.smrtreach_logs (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- smrtreach queue worker claims pending/sending rows across orgs
CREATE INDEX IF NOT EXISTS idx_smrtreach_queue_status
  ON public.smrtreach_queue (status)
  WHERE status IN ('pending', 'sending');

-- admin error-log view filters by level ordered by created_at
CREATE INDEX IF NOT EXISTS idx_log_entries_level_created
  ON public.log_entries (level, created_at DESC);

-- user_app_access self-policy filters bare user_id; only (org_id, user_id)
-- composite exists
CREATE INDEX IF NOT EXISTS idx_user_app_access_user
  ON public.user_app_access (user_id);

-- FK columns without covering indexes on delete-cascade / set-null paths
-- (deleting a campaign or CRM contact currently seq-scans these tables)
CREATE INDEX IF NOT EXISTS idx_smrtreach_queue_campaign
  ON public.smrtreach_queue (campaign_id);
CREATE INDEX IF NOT EXISTS idx_smrtreach_queue_contact
  ON public.smrtreach_queue (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_smrtreach_targets_contact
  ON public.smrtreach_campaign_targets (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_smrtreach_tracking_contact
  ON public.smrtreach_tracking (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_smrtreach_logs_contact
  ON public.smrtreach_logs (contact_id) WHERE contact_id IS NOT NULL;
