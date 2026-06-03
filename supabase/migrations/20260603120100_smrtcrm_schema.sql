-- ============================================================
-- smrtCRM — Database Schema
-- ============================================================
-- Org-scoped contact management. Eight tables, all under RLS with an
-- org-members policy (USING + WITH CHECK). Mirrors the smrtVoice schema
-- conventions. See docs/smrtcrm-smrtreach-build-plan.md §2.
--
-- Dedup model (CRM-3): ported from botsite, re-scoped from bot_id to org_id.
-- Partial unique indexes on (org_id, phone) and (org_id, email) back the
-- application-layer upsert (match phone → email → insert, COALESCE update).

-- ─── 1. CONTACTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtcrm_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES auth.users(id),

  first_name    text,
  last_name     text,
  phone         text,                          -- normalized to E.164 before write
  email         text,                          -- normalized to lowercase+trim before write

  source        text NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','csv','bot','api','migration')),
  notes         text,
  custom_fields jsonb NOT NULL DEFAULT '{}',

  -- email preferences (CRM-6: the truth about the person lives in CRM)
  email_unsubscribed boolean NOT NULL DEFAULT false,
  email_frequency    text CHECK (email_frequency IN ('all','weekly','monthly','none')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtcrm_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_contacts_org_members" ON smrtcrm_contacts
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS smrtcrm_contacts_org_idx ON smrtcrm_contacts(org_id);
-- Dedup (CRM-3): uniqueness is per-org, partial (only where the key is non-null).
CREATE UNIQUE INDEX IF NOT EXISTS smrtcrm_contacts_org_phone_uidx
  ON smrtcrm_contacts(org_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS smrtcrm_contacts_org_email_uidx
  ON smrtcrm_contacts(org_id, email) WHERE email IS NOT NULL;


-- ─── 2. TAGS ─────────────────────────────────────────────────
-- kind='manual'  → user-created label
-- kind='project' → auto-created from a smrtBot project (CRM-1); name derived
--                  from the bot, bot_ref holds the source bot identifier
-- kind='source'  → other automatic source labels
CREATE TABLE IF NOT EXISTS smrtcrm_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','project','source')),
  bot_ref    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE smrtcrm_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_tags_org_members" ON smrtcrm_tags
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtcrm_tags_org_idx ON smrtcrm_tags(org_id);


-- ─── 3. TAG ASSIGNMENTS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtcrm_tag_assignments (
  contact_id uuid NOT NULL REFERENCES smrtcrm_contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES smrtcrm_tags(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);

ALTER TABLE smrtcrm_tag_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_tag_assignments_org_members" ON smrtcrm_tag_assignments
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtcrm_tag_assignments_tag_idx ON smrtcrm_tag_assignments(tag_id);


-- ─── 4. GROUPS ───────────────────────────────────────────────
-- A manual static list of contacts (vs. tags which are logical labels and
-- vs. segments which are saved dynamic queries).
CREATE TABLE IF NOT EXISTS smrtcrm_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id),
  name       text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE smrtcrm_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_groups_org_members" ON smrtcrm_groups
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtcrm_groups_org_idx ON smrtcrm_groups(org_id);


-- ─── 5. GROUP MEMBERS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtcrm_group_members (
  group_id   uuid NOT NULL REFERENCES smrtcrm_groups(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES smrtcrm_contacts(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, contact_id)
);

ALTER TABLE smrtcrm_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_group_members_org_members" ON smrtcrm_group_members
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtcrm_group_members_contact_idx ON smrtcrm_group_members(contact_id);


-- ─── 6. SEGMENTS ─────────────────────────────────────────────
-- A saved dynamic query (CRM-1). `filter` is resolved at runtime; this is
-- what smrtReach reads as an "audience". Not a static member list.
CREATE TABLE IF NOT EXISTS smrtcrm_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  name       text NOT NULL,
  filter     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE smrtcrm_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_segments_org_members" ON smrtcrm_segments
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtcrm_segments_org_idx ON smrtcrm_segments(org_id);


-- ─── 7. FIELD DEFINITIONS ────────────────────────────────────
-- Hybrid custom fields (CRM-4): values live in contacts.custom_fields (jsonb);
-- this table defines which fields are shown in the UI and their type.
CREATE TABLE IF NOT EXISTS smrtcrm_field_defs (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key     text NOT NULL,
  label   text NOT NULL,
  type    text NOT NULL CHECK (type IN ('text','number','date','select','boolean')),
  options jsonb NOT NULL DEFAULT '[]',
  sort    int NOT NULL DEFAULT 0,
  UNIQUE (org_id, key)
);

ALTER TABLE smrtcrm_field_defs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_field_defs_org_members" ON smrtcrm_field_defs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));


-- ─── 8. API CONNECTIONS ──────────────────────────────────────
-- An inbound API connection (CRM-1): every contact entering through the
-- connection is auto-tagged with tag_id.
CREATE TABLE IF NOT EXISTS smrtcrm_api_connections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  name       text NOT NULL,
  tag_id     uuid REFERENCES smrtcrm_tags(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtcrm_api_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_api_connections_org_members" ON smrtcrm_api_connections
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));


-- ─── updated_at triggers ─────────────────────────────────────
-- Reuse the platform's shared trigger function if present; otherwise create one.
CREATE OR REPLACE FUNCTION smrtcrm_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER smrtcrm_contacts_updated_at BEFORE UPDATE ON smrtcrm_contacts
  FOR EACH ROW EXECUTE FUNCTION smrtcrm_set_updated_at();
CREATE TRIGGER smrtcrm_segments_updated_at BEFORE UPDATE ON smrtcrm_segments
  FOR EACH ROW EXECUTE FUNCTION smrtcrm_set_updated_at();
