-- ============================================================================
-- Migration: auto-fill organization_id on tasks / projects when omitted.
--
-- Why: existing AI pipeline (Part 3 classifier, Part 4 suggester) inserts tasks
-- with only `user_id`. Until those parts become org-aware in a later phase,
-- this trigger picks the user's first org and stamps it on the row.
--
-- Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION fill_org_id_from_user() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT org_id INTO NEW.organization_id
    FROM org_members
    WHERE user_id = NEW.user_id
    ORDER BY joined_at ASC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_fill_org    ON tasks;
DROP TRIGGER IF EXISTS trg_projects_fill_org ON projects;

CREATE TRIGGER trg_tasks_fill_org
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION fill_org_id_from_user();

CREATE TRIGGER trg_projects_fill_org
  BEFORE INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION fill_org_id_from_user();
