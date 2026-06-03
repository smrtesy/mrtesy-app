-- ============================================================
-- smrtReach — Database Schema
-- ============================================================
-- Multi-channel outreach. Campaign master + per-channel detail tables
-- (Reach-1), plus templates, recipient targets, tracking, send queue and a
-- per-recipient log. All org-scoped under RLS. See
-- docs/smrtcrm-smrtreach-build-plan.md §7.

-- ─── 1. CAMPAIGNS (master) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtreach_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   uuid NOT NULL REFERENCES auth.users(id),

  name         text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('whatsapp','email','both')),
  -- audience references a smrtCRM segment/group/tag, resolved at send time.
  -- shape: { kind: 'segment'|'group'|'tag'|'all', id?: uuid }
  audience     jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','approved','ready','sending','paused','done','failed')),
  scheduled_at timestamptz,
  timezone     text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtreach_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_campaigns_org_members" ON smrtreach_campaigns
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtreach_campaigns_org_idx ON smrtreach_campaigns(org_id);


-- ─── 2. CAMPAIGN — EMAIL detail ──────────────────────────────
CREATE TABLE IF NOT EXISTS smrtreach_campaign_email (
  campaign_id     uuid PRIMARY KEY REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject         text,
  preview         text,
  sender          text,
  reply_to        text,
  html_body       text,
  priority        text CHECK (priority IN ('low','normal','high')),
  send_hours      jsonb NOT NULL DEFAULT '{}',
  exclude_shabbat boolean NOT NULL DEFAULT true,
  rate_limit      int,
  cooldown_seconds int
);

ALTER TABLE smrtreach_campaign_email ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_campaign_email_org_members" ON smrtreach_campaign_email
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));


-- ─── 3. CAMPAIGN — WHATSAPP detail ───────────────────────────
CREATE TABLE IF NOT EXISTS smrtreach_campaign_whatsapp (
  campaign_id     uuid PRIMARY KEY REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_ref         text,                 -- broadcast always picks a bot (= number)
  template        text,
  template_lang   text,
  template_params jsonb NOT NULL DEFAULT '[]',
  recipient_cap   int
);

ALTER TABLE smrtreach_campaign_whatsapp ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_campaign_whatsapp_org_members" ON smrtreach_campaign_whatsapp
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));


-- ─── 4. TEMPLATES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtreach_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id),
  name       text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('whatsapp','email')),
  subject    text,
  body       text,
  variables  jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE smrtreach_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_templates_org_members" ON smrtreach_templates
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));


-- ─── 5. CAMPAIGN TARGETS (resolved recipient snapshot) ───────
CREATE TABLE IF NOT EXISTS smrtreach_campaign_targets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES smrtcrm_contacts(id) ON DELETE SET NULL,
  phone       text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

ALTER TABLE smrtreach_campaign_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_campaign_targets_org_members" ON smrtreach_campaign_targets
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtreach_targets_campaign_idx ON smrtreach_campaign_targets(campaign_id);


-- ─── 6. SEND QUEUE ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtreach_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('whatsapp','email')),
  contact_id  uuid REFERENCES smrtcrm_contacts(id) ON DELETE SET NULL,
  to_address  text NOT NULL,            -- phone or email
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts    int NOT NULL DEFAULT 0,
  error       text,
  scheduled_at timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtreach_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_queue_org_members" ON smrtreach_queue
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtreach_queue_pending_idx ON smrtreach_queue(org_id, status, scheduled_at);


-- ─── 7. TRACKING (open / click — built in, Reach-3) ──────────
CREATE TABLE IF NOT EXISTS smrtreach_tracking (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES smrtcrm_contacts(id) ON DELETE SET NULL,
  event       text NOT NULL CHECK (event IN ('open','click','bounce','complaint')),
  url         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtreach_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_tracking_org_members" ON smrtreach_tracking
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtreach_tracking_campaign_idx ON smrtreach_tracking(campaign_id);


-- ─── 8. RECIPIENT LOG ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtreach_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id    uuid NOT NULL REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES smrtcrm_contacts(id) ON DELETE SET NULL,
  channel        text NOT NULL CHECK (channel IN ('whatsapp','email')),
  status         text NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  wa_message_id  text,
  sent_at        timestamptz,
  read_at        timestamptz,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtreach_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_logs_org_members" ON smrtreach_logs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtreach_logs_campaign_idx ON smrtreach_logs(campaign_id);


-- ─── updated_at triggers ─────────────────────────────────────
CREATE OR REPLACE FUNCTION smrtreach_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER smrtreach_campaigns_updated_at BEFORE UPDATE ON smrtreach_campaigns
  FOR EACH ROW EXECUTE FUNCTION smrtreach_set_updated_at();
CREATE TRIGGER smrtreach_templates_updated_at BEFORE UPDATE ON smrtreach_templates
  FOR EACH ROW EXECUTE FUNCTION smrtreach_set_updated_at();
