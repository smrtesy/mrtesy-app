-- ============================================================
-- smrtVault — App Registration
-- ============================================================
-- Adds the app to the platform registry so requireApp("smrtvault")
-- can resolve it, and app_memberships rows can be inserted per org.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtvault',
  'smrtVault',
  'Personal credential vault: store website/service logins encrypted at rest in Supabase Vault, import from a Chrome CSV export, and autofill via the smrtVault browser extension'
)
ON CONFLICT (slug) DO NOTHING;

-- Initial status row for the admin dashboard. Optional — only insert if
-- the app_status table exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_status'
  ) THEN
    INSERT INTO app_status (app_slug, stage, summary)
    VALUES (
      'smrtvault',
      'בניה',
      'כספת סיסמאות אישית — יסוד: אחסון מוצפן ב-Vault, ניהול (הוסף/ערוך/מחק), ייבוא CSV מכרום. הבא: תוסף דפדפן למילוי-אוטומטי מוגן.'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
