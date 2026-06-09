-- ============================================================
-- org member display name (per-org, manager-editable)
-- ============================================================
-- An org admin can set a short display name for each member, used wherever a
-- person is shown (tasks, assignee chips, …). Org-scoped on purpose — it doesn't
-- touch the user's global auth profile. NULL = fall back to the first name from
-- the auth full_name, then email.
ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS display_name text;
