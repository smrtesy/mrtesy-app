-- App development status tracker (super-admin only)
-- Stages: רעיון → בניה → טסט → מאור → לקוחות
CREATE TABLE IF NOT EXISTS app_status (
  app_slug    text        PRIMARY KEY REFERENCES apps(slug) ON DELETE CASCADE,
  stage       text        NOT NULL DEFAULT 'רעיון'
                          CHECK (stage IN ('רעיון','בניה','טסט','מאור','לקוחות')),
  summary     text,
  next_steps  text[]      NOT NULL DEFAULT '{}',
  blockers    text[]      NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_status ENABLE ROW LEVEL SECURITY;
-- Client access fully denied — all reads go through requireSuperAdmin API
CREATE POLICY "app_status_deny_all" ON app_status USING (false);

-- Seed existing apps with default status
INSERT INTO app_status (app_slug)
SELECT slug FROM apps
ON CONFLICT (app_slug) DO NOTHING;
