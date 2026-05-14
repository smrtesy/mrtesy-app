-- ============================================================================
-- Migration: super_admins — DB-backed platform super-admin role.
--
-- A super-admin can see every org, every user, and toggle any app entitlement
-- for any org. Membership in this table is orthogonal to per-org roles
-- (`owner` / `admin` / `member` in `org_members`).
--
-- Bootstrap: seeds the table from auth.users whose email matches the current
--            ADMIN_EMAIL env list. After this migration runs, additional
--            super-admins are managed via the API (POST /api/admin/users/:id/super-admin).
--
-- Permanent fallback: requireSuperAdmin middleware ALSO accepts users whose
--                     email is in process.env.ADMIN_EMAIL — so even if this
--                     table gets accidentally cleared, env-listed admins keep
--                     working. The DB row is the canonical store; env is the
--                     safety net.
-- ============================================================================

CREATE TABLE IF NOT EXISTS super_admins (
  user_id     uuid          PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by  uuid          REFERENCES auth.users(id),
  granted_at  timestamptz   NOT NULL DEFAULT now(),
  note        text                                          -- e.g. "founder", "support team"
);

CREATE INDEX IF NOT EXISTS idx_super_admins_granted_at ON super_admins (granted_at DESC);

-- ─── Bootstrap from ADMIN_EMAIL env (one-time seed) ─────────────────────────
-- The migration can't read env vars at apply-time, so the list is hardcoded
-- from the current value of ADMIN_EMAIL. ON CONFLICT DO NOTHING makes re-runs
-- safe. If you change ADMIN_EMAIL later, the new admins still work via the
-- env-var fallback in middleware (and you can add them to the DB via the API).

INSERT INTO super_admins (user_id, note)
SELECT u.id, 'bootstrap from ADMIN_EMAIL env'
FROM auth.users u
WHERE lower(u.email) IN (
  'chanoch770@gmail.com',
  'admin@smrtesy.com',
  'dev@maor.org'
)
ON CONFLICT (user_id) DO NOTHING;

-- ─── RLS — fully locked down ────────────────────────────────────────────────
-- All reads/writes go through Express (service-role bypasses RLS). Adding a
-- restrictive policy here so any accidental anon client gets nothing back.

ALTER TABLE super_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "super_admins_no_direct_access" ON super_admins;
CREATE POLICY "super_admins_no_direct_access" ON super_admins
  FOR ALL USING (false) WITH CHECK (false);
