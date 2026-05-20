-- Per-task background materials: notes, links, files, contacts the user
-- attaches to a task so it's useful to come back to. Stored as a JSONB
-- array on `tasks`, same read-modify-write pattern as ai_generated_content /
-- linked_drive_docs / checklist.
--
-- Shape per item (validated server-side):
--   { id: uuid, type: 'note'|'link'|'file'|'contact', title: string,
--     content?: string,
--     url?: string, file_path?: string, file_size?: number, file_mime?: string,
--     contact_name?: string, contact_email?: string, contact_phone?: string,
--     created_at: iso, created_by: string }

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS task_materials jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS tasks_has_materials_idx
  ON tasks ((jsonb_array_length(task_materials) > 0));

-- ============================================================
-- Storage bucket: task-materials
-- ============================================================
-- Private bucket. The backend uses service-role to upload and mint signed
-- URLs; the frontend follows the signed URL directly. The RLS policies
-- below are defence-in-depth: service-role bypasses them, but if a future
-- code path uses the anon client it will be blocked unless the caller is
-- an org member of the path's first folder.
-- Path convention: <org_id>/<task_id>/<uuid>-<filename>

INSERT INTO storage.buckets (id, name, public)
VALUES ('task-materials', 'task-materials', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "task_materials_org_read" ON storage.objects;
CREATE POLICY "task_materials_org_read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'task-materials'
    AND EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = auth.uid()
        AND om.org_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "task_materials_org_delete" ON storage.objects;
CREATE POLICY "task_materials_org_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'task-materials'
    AND EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.user_id = auth.uid()
        AND om.org_id::text = (storage.foldername(name))[1]
    )
  );
