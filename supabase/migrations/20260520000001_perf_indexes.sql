-- Performance indexes for common query patterns
-- organizations.slug: middleware uses eq("slug", orgSlug) on every tenant request
-- tasks composite: task list queries always filter by organization_id + status or task_type

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug
  ON organizations (slug);

CREATE INDEX IF NOT EXISTS idx_tasks_org_status
  ON tasks (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_org_type
  ON tasks (organization_id, task_type);
