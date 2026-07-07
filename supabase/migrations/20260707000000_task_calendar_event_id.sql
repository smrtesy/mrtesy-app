-- Events written back to Google Calendar carry the Google event id here, so the
-- calendar sync can recognise an event smrtesy itself created and skip building
-- a duplicate "meeting" task when that event round-trips back through ingestion.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_event_id text;

-- Dedup lookups on ingest match an incoming Google event id against this column.
CREATE INDEX IF NOT EXISTS idx_tasks_calendar_event_id
  ON tasks (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
