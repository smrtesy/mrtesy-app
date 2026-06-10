-- Info Center (מרכז מידע) redesign — spec §10.
--
-- 1. project_information_items.attachments: jsonb array of
--    { id, filename, url, file_path, file_mime, file_size } objects,
--    uploaded to the task-materials storage bucket.
-- 2. projects.info_summary*: a single pinned AI summary per project.
--    The previous summary is kept in info_summary_prev as a safety copy
--    each time the summary is overwritten (AI rebuild or manual edit).

ALTER TABLE project_information_items
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS info_summary text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS info_summary_updated_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS info_summary_prev text;
