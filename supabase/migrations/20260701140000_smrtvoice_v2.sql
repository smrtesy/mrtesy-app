-- ============================================================
-- smrtVoice v2 — Project=folder, Scripts, per-script casting, voice previews
-- ============================================================
-- Restructure: a project becomes a folder (letter prefix + full name); each
-- script under it is a program auto-numbered {prefix}{seq} (BR1, BR2, ...).
-- Speaker→voice casting is explicit per script (character OR stock voice),
-- replacing the old exact-name match. Safe: no projects/scripts/lines exist yet.

-- ─── PROJECTS → FOLDER ───────────────────────────────────────
ALTER TABLE smrtvoice_projects
  ADD COLUMN IF NOT EXISTS code_prefix text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'smrtvoice_projects_code_prefix_format') THEN
    ALTER TABLE smrtvoice_projects
      ADD CONSTRAINT smrtvoice_projects_code_prefix_format
      CHECK (code_prefix IS NULL OR code_prefix ~ '^[A-Z]{1,3}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS smrtvoice_projects_org_prefix_idx
  ON smrtvoice_projects(org_id, code_prefix) WHERE code_prefix IS NOT NULL;

-- ─── SCRIPTS (new) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_scripts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES smrtvoice_projects(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  seq             integer NOT NULL,
  code            text NOT NULL,          -- {project.code_prefix}{seq}, e.g. BR1
  name            text,
  language        text NOT NULL DEFAULT 'he' CHECK (language IN ('he','en')),

  google_doc_id        text,
  google_doc_url       text,
  google_doc_tab_id    text,
  google_doc_tab_title text,
  script_imported_at   timestamptz,

  generation_mode text NOT NULL DEFAULT 'tts' CHECK (generation_mode IN ('sts','tts')),
  input_recording_path text,

  status          text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','parsed','ready','queued','processing',
    'audio_ready','completed','archiving','archived','failed'
  )),

  total_lines     integer NOT NULL DEFAULT 0,
  completed_lines integer NOT NULL DEFAULT 0,
  failed_lines    integer NOT NULL DEFAULT 0,
  total_cost_usd  numeric NOT NULL DEFAULT 0,
  total_duration_seconds numeric NOT NULL DEFAULT 0,

  archive_gdrive_folder_id  text,
  archive_gdrive_folder_url text,
  archived_at     timestamptz,
  audio_ready_at  timestamptz,
  completed_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (project_id, seq),
  UNIQUE (org_id, code)
);

ALTER TABLE smrtvoice_scripts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtvoice_scripts_org_members" ON smrtvoice_scripts;
CREATE POLICY "smrtvoice_scripts_org_members" ON smrtvoice_scripts
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_scripts_project_idx ON smrtvoice_scripts(project_id, seq);
CREATE INDEX IF NOT EXISTS smrtvoice_scripts_org_idx     ON smrtvoice_scripts(org_id);

DROP TRIGGER IF EXISTS smrtvoice_scripts_updated_at ON smrtvoice_scripts;
CREATE TRIGGER smrtvoice_scripts_updated_at BEFORE UPDATE ON smrtvoice_scripts
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

-- ─── LINES: project_id → script_id ───────────────────────────
ALTER TABLE smrtvoice_lines
  ADD COLUMN IF NOT EXISTS script_id uuid REFERENCES smrtvoice_scripts(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS smrtvoice_lines_project_idx;
DROP INDEX IF EXISTS smrtvoice_lines_status_idx;
DROP INDEX IF EXISTS smrtvoice_lines_redo_idx;
ALTER TABLE smrtvoice_lines DROP COLUMN IF EXISTS project_id;
ALTER TABLE smrtvoice_lines ALTER COLUMN script_id SET NOT NULL;  -- table is empty
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'smrtvoice_lines_script_line_uniq') THEN
    ALTER TABLE smrtvoice_lines
      ADD CONSTRAINT smrtvoice_lines_script_line_uniq UNIQUE (script_id, line_number);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS smrtvoice_lines_script_idx ON smrtvoice_lines(script_id, line_number);
CREATE INDEX IF NOT EXISTS smrtvoice_lines_status_idx ON smrtvoice_lines(script_id, status);
CREATE INDEX IF NOT EXISTS smrtvoice_lines_redo_idx   ON smrtvoice_lines(script_id) WHERE redo_requested;

-- ─── SCRIPT SPEAKERS (per-script casting) ────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_script_speakers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  script_id       uuid NOT NULL REFERENCES smrtvoice_scripts(id) ON DELETE CASCADE,

  speaker_name    text NOT NULL,
  -- Cast to one of your characters OR directly to a stock Resemble voice.
  character_id       uuid REFERENCES smrtvoice_characters(id) ON DELETE SET NULL,
  resemble_voice_id  text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (script_id, speaker_name)
);

ALTER TABLE smrtvoice_script_speakers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtvoice_script_speakers_org_members" ON smrtvoice_script_speakers;
CREATE POLICY "smrtvoice_script_speakers_org_members" ON smrtvoice_script_speakers
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_script_speakers_script_idx ON smrtvoice_script_speakers(script_id);

DROP TRIGGER IF EXISTS smrtvoice_script_speakers_updated_at ON smrtvoice_script_speakers;
CREATE TRIGGER smrtvoice_script_speakers_updated_at BEFORE UPDATE ON smrtvoice_script_speakers
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

-- ─── VOICE PREVIEWS (stored samples) ─────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_voice_previews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resemble_voice_id text NOT NULL,
  storage_path    text NOT NULL,
  sample_text     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, resemble_voice_id)
);

ALTER TABLE smrtvoice_voice_previews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtvoice_voice_previews_org_members" ON smrtvoice_voice_previews;
CREATE POLICY "smrtvoice_voice_previews_org_members" ON smrtvoice_voice_previews
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- ─── JOBS: add script_id ─────────────────────────────────────
ALTER TABLE smrtvoice_jobs
  ADD COLUMN IF NOT EXISTS script_id uuid REFERENCES smrtvoice_scripts(id) ON DELETE CASCADE;

-- ─── SETTINGS: preview sentence ──────────────────────────────
ALTER TABLE smrtvoice_settings
  ADD COLUMN IF NOT EXISTS sample_text text
    DEFAULT 'שלום, זו דוגמה קצרה לקול. נעים מאוד להכיר!';
