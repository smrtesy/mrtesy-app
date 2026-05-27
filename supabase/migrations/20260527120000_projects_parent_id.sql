-- Add parent_id to projects for sub-project hierarchy.
-- A project with parent_id is a sub-project of the referenced project.
-- Tasks point directly to a project OR sub-project via project_id — no separate column needed.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES projects(id) ON DELETE SET NULL
    CHECK (parent_id != id);  -- prevent self-reference

CREATE INDEX IF NOT EXISTS projects_parent_id_idx ON projects(parent_id);
