-- ─────────────────────────────────────────────────────────────────────────────
-- Project-only ("lean") worker support for smrtTask.
--
-- A project-only worker is an org member who uses smrtTask ONLY for tasks
-- assigned to them (from a smrtPlan plan or by another user/manager). They never
-- connect Gmail/Drive/Calendar and never run the initial scan. The distinction
-- is stored in the EXISTING `app_user_access` table (access_level 'lite'), the
-- same mechanism smrtPlan already uses.
--
-- This migration:
--   1. Carries an `access_level` on org_invites so the level survives the
--      invite → accept flow.
--   2. Teaches accept_my_invites() to seed `app_user_access` rows at that level
--      for the granted apps when the invite is a 'lite' invite.
--
-- Backwards-compatible & additive: default 'full' preserves every existing
-- member's current behaviour (member with smrttask = full app).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. org_invites.access_level ──────────────────────────────────────────────
ALTER TABLE org_invites
  ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'full'
    CHECK (access_level IN ('full', 'lite'));

-- ── 2. accept_my_invites(): also seed app_user_access for 'lite' invites ─────
-- Same body as before, plus a conditional app_user_access seed. Idempotent —
-- safe to call on every login (ON CONFLICT DO NOTHING everywhere).
CREATE OR REPLACE FUNCTION accept_my_invites()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email  text;
  v_invite record;
BEGIN
  SELECT lower(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN
    RETURN;
  END IF;

  FOR v_invite IN
    SELECT * FROM org_invites
    WHERE lower(email) = v_email
      AND accepted_at IS NULL
      AND expires_at > now()
    ORDER BY created_at
  LOOP
    INSERT INTO org_members (org_id, user_id, role, invited_by)
    VALUES (v_invite.org_id, auth.uid(), v_invite.role, v_invite.invited_by)
    ON CONFLICT (org_id, user_id) DO NOTHING;

    INSERT INTO user_app_access (org_id, user_id, app_id, granted_by)
    SELECT v_invite.org_id, auth.uid(), a.id, v_invite.invited_by
    FROM apps a
    WHERE a.slug = ANY (v_invite.app_slugs)
    ON CONFLICT (org_id, user_id, app_id) DO NOTHING;

    -- Lean/project-only invite → record the per-app access level so smrtTask
    -- (and smrtPlan) enforce the restricted, tasks-only surface. Only the apps
    -- that were actually granted get a row.
    IF v_invite.access_level = 'lite' THEN
      INSERT INTO app_user_access (org_id, user_id, app_id, access_level, granted_by)
      SELECT v_invite.org_id, auth.uid(), a.id, 'lite', v_invite.invited_by
      FROM apps a
      WHERE a.slug = ANY (v_invite.app_slugs)
      ON CONFLICT (org_id, app_id, user_id) DO NOTHING;
    END IF;

    UPDATE org_invites SET accepted_at = now() WHERE id = v_invite.id;
  END LOOP;
END;
$$;

-- Re-assert the locked-down grants (CREATE OR REPLACE preserves them, but be
-- explicit — see 20260707120100_lock_security_definer_functions.sql).
REVOKE EXECUTE ON FUNCTION public.accept_my_invites() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.accept_my_invites() TO authenticated;
