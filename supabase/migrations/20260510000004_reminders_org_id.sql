-- ============================================================================
-- Migration: add organization_id to reminders + auto-fill trigger + backfill.
-- Reminders are tied to tasks (which are now org-scoped) and to a user. This
-- column lets the Express API scope reads/writes by active org.
-- ============================================================================

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_reminders_org ON reminders (organization_id)
  WHERE organization_id IS NOT NULL;

-- Reuse the existing fill_org_id_from_user() function from migration ...0002
DROP TRIGGER IF EXISTS trg_reminders_fill_org ON reminders;
CREATE TRIGGER trg_reminders_fill_org
  BEFORE INSERT ON reminders
  FOR EACH ROW EXECUTE FUNCTION fill_org_id_from_user();

-- Backfill existing rows
UPDATE reminders r
SET organization_id = (
  SELECT org_id FROM org_members om
  WHERE om.user_id = r.user_id
  ORDER BY joined_at ASC
  LIMIT 1
)
WHERE organization_id IS NULL;
