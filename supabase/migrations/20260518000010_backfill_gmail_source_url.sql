-- Backfill source_url for legacy Gmail rows that only stored source_id.
-- The new TaskCard / TaskDetail / Suggestions UI relies on source_url to
-- render the "open source" link. `#all/<id>` works regardless of which
-- Gmail label the message is filed under, so we don't need to know the
-- thread state to construct a working deep-link.
UPDATE source_messages
SET source_url = 'https://mail.google.com/mail/u/0/#all/' || source_id
WHERE source_type = 'gmail'
  AND source_url IS NULL
  AND source_id IS NOT NULL;
