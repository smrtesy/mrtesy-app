-- Add per-task checklist (subtasks) as a JSONB array on tasks.
-- Shape per item:
--   { id: uuid, title: string, done: bool, created_at: iso, completed_at: iso|null, created_by: 'user'|'ai' }
-- Read-modify-write via PATCH /api/tasks/:id, same pattern as updates[] / ai_generated_content.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
