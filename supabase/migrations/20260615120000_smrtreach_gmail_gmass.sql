-- ============================================================
-- smrtReach — Gmail sending + GMass inbox test (botsite parity)
-- ============================================================
-- Email can now be sent either via Amazon SES (default) or via the org's
-- connected Gmail accounts (the platform's existing per-user Google OAuth,
-- service='gmail', scope gmail.modify which permits messages.send). Gmail sends
-- are round-robined across the org's connected accounts with a per-account
-- daily cap (botsite used 2000/account/day).

-- ─── Per-campaign provider choice ────────────────────────────
ALTER TABLE smrtreach_campaign_email
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'ses'
    CHECK (provider IN ('ses','gmail'));

-- ─── Per-account daily send counter (Gmail quota) ────────────
CREATE TABLE IF NOT EXISTS smrtreach_gmail_quota (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email  text NOT NULL,                 -- the sending Gmail address
  day    date NOT NULL DEFAULT CURRENT_DATE,
  sent   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, email, day)
);

ALTER TABLE smrtreach_gmail_quota ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_gmail_quota_org_members" ON smrtreach_gmail_quota
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- Atomic per-account daily increment (the send-service runs as service-role).
CREATE OR REPLACE FUNCTION smrtreach_gmail_quota_inc(p_org uuid, p_email text)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v int;
BEGIN
  INSERT INTO public.smrtreach_gmail_quota (org_id, email, day, sent)
  VALUES (p_org, p_email, CURRENT_DATE, 1)
  ON CONFLICT (org_id, email, day)
    DO UPDATE SET sent = public.smrtreach_gmail_quota.sent + 1
  RETURNING sent INTO v;
  RETURN v;
END $$;
