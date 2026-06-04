-- ============================================================
-- smrtPlan — Hebrew-calendar blocked days (engine §5.1a)
-- ============================================================
-- Every date the engine computes (backward scheduling, time-splitting,
-- countdowns) MUST skip Shabbat, yom tov, and bein-hazmanim — Maor never sets
-- a deadline or start on a forbidden day. A blocked target rolls back to the
-- nearest valid working day (backwards, since this is backward scheduling).
--
-- Source of truth split:
--   • Shabbat (Saturday)  → computed in the engine code (deterministic).
--   • Yom tov / bein-hazmanim → THIS table (maintained ahead of time, per
--     engine §5.1a option B). Avoids a fragile npm: Hebrew-calendar dependency
--     inside the Deno edge runtime (esm.sh 522 / bundling risk — see CLAUDE.md).
--
-- org_id NULL = a platform-wide block (the fixed Jewish holidays — same for
-- everyone). A non-NULL org_id = an org-specific block (e.g. that org's
-- bein-hazmanim window or a custom no-work day).

CREATE TABLE IF NOT EXISTS smrtplan_blocked_days (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = global
  blocked_date date NOT NULL,
  reason       text,
  kind         text NOT NULL DEFAULT 'yomtov'
               CHECK (kind IN ('yomtov','bein_hazmanim','custom')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS smrtplan_blocked_days_global_uq
  ON smrtplan_blocked_days(blocked_date) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS smrtplan_blocked_days_org_uq
  ON smrtplan_blocked_days(org_id, blocked_date) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS smrtplan_blocked_days_date_idx
  ON smrtplan_blocked_days(blocked_date);

ALTER TABLE smrtplan_blocked_days ENABLE ROW LEVEL SECURITY;
-- Any authenticated user reads global blocks + their own org's blocks.
DROP POLICY IF EXISTS "smrtplan_blocked_days_read" ON smrtplan_blocked_days;
CREATE POLICY "smrtplan_blocked_days_read" ON smrtplan_blocked_days
  FOR SELECT USING (
    org_id IS NULL
    OR org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );
DROP POLICY IF EXISTS "smrtplan_blocked_days_write" ON smrtplan_blocked_days;
CREATE POLICY "smrtplan_blocked_days_write" ON smrtplan_blocked_days
  FOR ALL USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- ─── Seed: fixed yom tov (no-work days) 5786–5787 ────────────
-- Computed from the Hebrew calendar (Intl en-u-ca-hebrew). Global rows.
-- These are the full-yom-tov days only; chol ha-moed is a working period.
INSERT INTO smrtplan_blocked_days (org_id, blocked_date, reason, kind) VALUES
  (NULL, '2026-07-23', 'תשעה באב',            'yomtov'),
  (NULL, '2026-09-12', 'ראש השנה א''',         'yomtov'),
  (NULL, '2026-09-13', 'ראש השנה ב''',         'yomtov'),
  (NULL, '2026-09-21', 'יום כיפור',           'yomtov'),
  (NULL, '2026-09-26', 'סוכות א''',            'yomtov'),
  (NULL, '2026-09-27', 'סוכות ב''',            'yomtov'),
  (NULL, '2026-10-03', 'שמיני עצרת',          'yomtov'),
  (NULL, '2026-10-04', 'שמחת תורה',           'yomtov'),
  (NULL, '2027-04-22', 'פסח א''',              'yomtov'),
  (NULL, '2027-04-23', 'פסח ב''',              'yomtov'),
  (NULL, '2027-04-28', 'שביעי של פסח',        'yomtov'),
  (NULL, '2027-04-29', 'אחרון של פסח',        'yomtov'),
  (NULL, '2027-06-11', 'שבועות א''',           'yomtov'),
  (NULL, '2027-06-12', 'שבועות ב''',           'yomtov'),
  (NULL, '2027-08-12', 'תשעה באב',            'yomtov'),
  (NULL, '2027-10-02', 'ראש השנה א''',         'yomtov'),
  (NULL, '2027-10-03', 'ראש השנה ב''',         'yomtov'),
  (NULL, '2027-10-11', 'יום כיפור',           'yomtov'),
  (NULL, '2027-10-16', 'סוכות א''',            'yomtov'),
  (NULL, '2027-10-17', 'סוכות ב''',            'yomtov'),
  (NULL, '2027-10-23', 'שמיני עצרת',          'yomtov'),
  (NULL, '2027-10-24', 'שמחת תורה',           'yomtov')
ON CONFLICT DO NOTHING;
