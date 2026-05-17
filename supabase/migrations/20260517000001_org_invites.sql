-- Invite-only registration: pending email invitations per org.
-- New users are blocked from creating accounts unless they have a valid invite.
CREATE TABLE IF NOT EXISTS org_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  token       UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS org_invites_token_idx ON org_invites(token);
CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites(LOWER(email));

-- RLS: super admins and org owners/admins can manage invites for their org.
ALTER TABLE org_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admins_all_invites" ON org_invites
  USING (auth.uid() IN (SELECT user_id FROM super_admins));

CREATE POLICY "org_admins_read_own_invites" ON org_invites
  FOR SELECT USING (
    auth.uid() IN (
      SELECT user_id FROM org_members
      WHERE org_id = org_invites.org_id AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "org_admins_create_invites" ON org_invites
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT user_id FROM org_members
      WHERE org_id = org_invites.org_id AND role IN ('owner', 'admin')
    )
  );
