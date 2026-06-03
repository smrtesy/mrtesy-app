-- Migration: smrtTask scheduling — recurring tasks, meeting gating, prominent
-- "happening soon" indicator support.
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS guards).
--
-- Context:
--   * recurrence_rule / reminder_at / due_time already exist on tasks
--     (added in 20260424000001_backend_pipeline.sql). This migration only adds
--     the bookkeeping needed to chain recurring instances and to query the
--     upcoming-reminder banner efficiently.
--   * task_type has NO check constraint, so the new "meeting" value needs no
--     DDL — it is documented here for the record.

-- ============================================================
-- 1. Recurring-task series bookkeeping
-- ============================================================
-- recurrence_parent_id chains every materialised instance back to the first
-- task in the series, so we can find / cancel a whole series later. NULL on a
-- standalone (non-recurring) task and on the very first instance of a series.
-- recurrence_until lets a series stop on a date (NULL = open-ended).
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_parent_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurrence_until     date;

-- ============================================================
-- 2. Indexes
-- ============================================================
-- The "happening soon" banner queries tasks by reminder_at. Partial index keeps
-- it tiny (most tasks have no reminder_at).
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_at
  ON tasks (reminder_at)
  WHERE reminder_at IS NOT NULL;

-- Finding all instances of a recurring series.
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_parent
  ON tasks (recurrence_parent_id)
  WHERE recurrence_parent_id IS NOT NULL;

-- The follow-up suppression check (reminders-check edge fn) wakes snoozed
-- follow-up tasks and needs to find them quickly by type.
CREATE INDEX IF NOT EXISTS idx_tasks_followup_snoozed
  ON tasks (snoozed_until)
  WHERE task_type = 'followup' AND status = 'snoozed';
