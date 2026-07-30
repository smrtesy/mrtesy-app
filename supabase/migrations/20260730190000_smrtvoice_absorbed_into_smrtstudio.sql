-- Stage G of docs/studio-build-plan.md: smrtVoice is absorbed into smrtStudio.
--
-- The entitlement moves, the data does not: smrtvoice_projects/scripts/lines/
-- takes all stay exactly where they are, served by the same routes — those
-- routes now sit behind requireApp("smrtstudio") (same deploy as this
-- migration). Here we only make sure no org LOSES access in the swap:
--
--   1. every org that had smrtvoice gets smrtstudio (if it didn't already);
--   2. every MEMBER with a per-user smrtvoice grant (user_app_access) gets
--      the matching smrtstudio grant — requireApp demands the per-user row
--      for role='member', so skipping this would 403 voice-only members;
--   3. the smrtvoice rows are removed from both tables, which is what clears
--      the voice section out of sidebars and settings tabs (both are driven
--      by enabled apps, not by code flags).
--
-- The apps row itself is kept: the event bus (platform_events emitted with
-- app slug 'smrtvoice'), admin surfaces (/admin/apps/smrtvoice — env-key
-- status, documents) and historical rows still reference it.

DO $$
DECLARE
  voice_app_id  uuid;
  studio_app_id uuid;
BEGIN
  SELECT id INTO voice_app_id  FROM apps WHERE slug = 'smrtvoice';
  SELECT id INTO studio_app_id FROM apps WHERE slug = 'smrtstudio';

  IF voice_app_id IS NULL THEN
    -- Fresh install that never had smrtvoice — legitimately nothing to move.
    RAISE NOTICE '[smrtvoice absorption] no smrtvoice apps row — nothing to move.';
    RETURN;
  END IF;
  IF studio_app_id IS NULL THEN
    -- FAIL LOUD: voice memberships exist but there is no smrtstudio to move
    -- them to. Returning quietly here would strand every voice org against
    -- routes that now demand the studio entitlement.
    RAISE EXCEPTION '[smrtvoice absorption] smrtvoice exists but smrtstudio apps row is missing — aborting.';
  END IF;

  -- 1. Org entitlements: smrtvoice orgs that lack smrtstudio get it, keeping
  --    the original enabler/enabled_at so the audit trail stays truthful.
  INSERT INTO app_memberships (org_id, app_id, enabled_by, enabled_at)
  SELECT m.org_id, studio_app_id, m.enabled_by, m.enabled_at
  FROM app_memberships m
  WHERE m.app_id = voice_app_id
  ON CONFLICT (org_id, app_id) DO NOTHING;

  -- 2. Per-user grants (role='member' is gated on these in require-app.ts).
  INSERT INTO user_app_access (org_id, user_id, app_id, granted_by, granted_at)
  SELECT g.org_id, g.user_id, studio_app_id, g.granted_by, g.granted_at
  FROM user_app_access g
  WHERE g.app_id = voice_app_id
  ON CONFLICT (org_id, user_id, app_id) DO NOTHING;

  -- 3. Retire the smrtvoice rows from both tables.
  DELETE FROM user_app_access WHERE app_id = voice_app_id;
  DELETE FROM app_memberships WHERE app_id = voice_app_id;

  RAISE NOTICE '[smrtvoice absorption] org memberships + user grants moved to smrtstudio.';
END $$;
