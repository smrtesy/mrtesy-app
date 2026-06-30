-- ============================================================
-- smrtVoice Studio — program code, language tab, emotion-tag
-- transparency, mark-for-redo, and Drive target folder.
-- ============================================================
-- Companion to the voice-engine resemble-ultra rework. All columns are
-- additive; existing rows keep working.

-- ─── PROJECTS ────────────────────────────────────────────────
ALTER TABLE smrtvoice_projects
  -- Short program code, e.g. "BR1" (1-2 letters + number). Output files are
  -- named "{code}_{line:03d}.wav" and archived under a folder named by code.
  ADD COLUMN IF NOT EXISTS code text,
  -- Per-project Drive target folder (overrides the org-wide archive folder).
  ADD COLUMN IF NOT EXISTS gdrive_target_folder_id  text,
  ADD COLUMN IF NOT EXISTS gdrive_target_folder_url text,
  -- Which Google-Doc tab to read (the language tab). NULL → auto-detect Hebrew.
  ADD COLUMN IF NOT EXISTS google_doc_tab_id    text,
  ADD COLUMN IF NOT EXISTS google_doc_tab_title text;

-- Code format guard (NULL allowed; otherwise 1-2 uppercase letters + digits).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smrtvoice_projects_code_format'
  ) THEN
    ALTER TABLE smrtvoice_projects
      ADD CONSTRAINT smrtvoice_projects_code_format
      CHECK (code IS NULL OR code ~ '^[A-Z]{1,2}[0-9]+$');
  END IF;
END $$;

-- One code per org (only when set).
CREATE UNIQUE INDEX IF NOT EXISTS smrtvoice_projects_org_code_idx
  ON smrtvoice_projects(org_id, code) WHERE code IS NOT NULL;

-- New projects default to TTS (the resemble-ultra recipe is TTS, not STS).
ALTER TABLE smrtvoice_projects ALTER COLUMN generation_mode SET DEFAULT 'tts';

-- ─── LINES ───────────────────────────────────────────────────
ALTER TABLE smrtvoice_lines
  -- The exact body sent to Resemble (Hebrew text + embedded emotion tags).
  ADD COLUMN IF NOT EXISTS tts_body text,
  -- Tags applied, each {tag, type: wrap|inline, source: script|llm}.
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the emotion came from: 'script' | 'llm' | 'none'.
  ADD COLUMN IF NOT EXISTS emotion_source text,
  -- Full payload sent to Resemble for this render (for UI transparency).
  ADD COLUMN IF NOT EXISTS resemble_request jsonb,
  -- Mark-for-redo workflow.
  ADD COLUMN IF NOT EXISTS redo_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS redo_reason text,
  ADD COLUMN IF NOT EXISTS redo_instructions text,
  ADD COLUMN IF NOT EXISTS redone_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smrtvoice_lines_emotion_source_chk'
  ) THEN
    ALTER TABLE smrtvoice_lines
      ADD CONSTRAINT smrtvoice_lines_emotion_source_chk
      CHECK (emotion_source IS NULL OR emotion_source IN ('script','llm','none'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS smrtvoice_lines_redo_idx
  ON smrtvoice_lines(project_id) WHERE redo_requested;

-- ─── MODEL DEFAULTS → resemble-ultra ─────────────────────────
-- chatterbox is deprecated; the tested Hebrew recipe is resemble-ultra.
ALTER TABLE smrtvoice_characters ALTER COLUMN resemble_model SET DEFAULT 'resemble-ultra';
ALTER TABLE smrtvoice_settings   ALTER COLUMN default_resemble_model SET DEFAULT 'resemble-ultra';

UPDATE smrtvoice_characters
   SET resemble_model = 'resemble-ultra'
 WHERE resemble_model IS NULL OR resemble_model = 'chatterbox';

UPDATE smrtvoice_settings
   SET default_resemble_model = 'resemble-ultra'
 WHERE default_resemble_model IS NULL OR default_resemble_model = 'chatterbox';

-- Output filename template now leads with the program code.
ALTER TABLE smrtvoice_settings ALTER COLUMN audio_file_template SET DEFAULT '{code}_{line:03d}';
UPDATE smrtvoice_settings
   SET audio_file_template = '{code}_{line:03d}'
 WHERE audio_file_template = '{line:03d}_{speaker}';
