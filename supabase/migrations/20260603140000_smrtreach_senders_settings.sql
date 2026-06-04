-- ============================================================
-- smrtReach — Senders + Settings (app-managed email config)
-- ============================================================
-- Email sending is managed FROM THE APP, not locked to a single hardcoded
-- address: org admins manage a list of verified sender addresses, and the SES
-- region is resolved per content language (en → us-east-1, he → il-central-1
-- by default, both editable). The AWS credentials themselves stay in
-- app_secrets (slug "smrtreach"); only non-secret config lives here.

-- ─── Verified sender addresses (managed in-app) ──────────────
CREATE TABLE IF NOT EXISTS smrtreach_senders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id),
  email      text NOT NULL,
  label      text,
  reply_to   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

ALTER TABLE smrtreach_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_senders_org_members" ON smrtreach_senders
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- ─── Per-org email settings ──────────────────────────────────
-- region_by_language maps a content language to an SES region. Editable in-app.
CREATE TABLE IF NOT EXISTS smrtreach_settings (
  org_id             uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  default_region     text NOT NULL DEFAULT 'us-east-1',
  region_by_language jsonb NOT NULL DEFAULT '{"en":"us-east-1","he":"il-central-1"}',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtreach_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_settings_org_members" ON smrtreach_settings
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE TRIGGER smrtreach_settings_updated_at BEFORE UPDATE ON smrtreach_settings
  FOR EACH ROW EXECUTE FUNCTION smrtreach_set_updated_at();

-- Content language on the email campaign drives region resolution (Reach: en →
-- us-east-1, he → il-central-1). Defaults to Hebrew (primary tenant).
ALTER TABLE smrtreach_campaign_email
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'he' CHECK (language IN ('he','en'));
