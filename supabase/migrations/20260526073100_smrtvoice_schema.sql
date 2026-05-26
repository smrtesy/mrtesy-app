-- ============================================================
-- smrtVoice — Database Schema
-- ============================================================
-- Eight tables, all org-scoped under RLS:
--   characters, voice_profiles, projects, lines, jobs, voice_samples,
--   pronunciation_lexicon, settings.

-- ─── 1. CHARACTERS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_characters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  name            text NOT NULL,
  display_name    text,
  description     text,
  notes           text,

  resemble_voice_id      text,
  resemble_model         text DEFAULT 'chatterbox',
  chatterbox_sample_path text,

  language        text NOT NULL DEFAULT 'he' CHECK (language IN ('he','en')),
  voice_type      text NOT NULL DEFAULT 'pro' CHECK (voice_type IN ('rapid','pro')),
  age_group       text CHECK (age_group IN ('child','teen','adult','elderly')),
  gender          text CHECK (gender IN ('male','female','neutral')),

  default_exaggeration  numeric DEFAULT 0.5 CHECK (default_exaggeration BETWEEN 0 AND 2),
  default_pitch         numeric DEFAULT 0 CHECK (default_pitch BETWEEN -10 AND 10),
  default_pace          text DEFAULT 'normal' CHECK (default_pace IN ('slow','normal','fast')),

  personality_prompt text,

  is_active       boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_characters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_characters_org_members" ON smrtvoice_characters
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_characters_org_idx    ON smrtvoice_characters(org_id);
CREATE INDEX IF NOT EXISTS smrtvoice_characters_active_idx ON smrtvoice_characters(org_id, is_active);


-- ─── 2. VOICE_PROFILES ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_voice_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  character_id    uuid NOT NULL REFERENCES smrtvoice_characters(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  profile_name    text NOT NULL,

  exaggeration    numeric NOT NULL DEFAULT 0.5 CHECK (exaggeration BETWEEN 0 AND 2),
  pitch           numeric NOT NULL DEFAULT 0 CHECK (pitch BETWEEN -10 AND 10),
  speaking_pace   text NOT NULL DEFAULT 'normal' CHECK (speaking_pace IN ('slow','normal','fast')),
  resemble_prompt text,
  context         text,
  is_default      boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (character_id, profile_name)
);

ALTER TABLE smrtvoice_voice_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_voice_profiles_org_members" ON smrtvoice_voice_profiles
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_voice_profiles_character_idx ON smrtvoice_voice_profiles(character_id);


-- ─── 3. PROJECTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  name            text NOT NULL,
  description     text,
  language        text NOT NULL DEFAULT 'he' CHECK (language IN ('he','en')),

  google_doc_id      text,
  google_doc_url     text,
  script_imported_at timestamptz,

  generation_mode    text NOT NULL DEFAULT 'sts' CHECK (generation_mode IN ('sts','tts')),
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
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_projects_org_members" ON smrtvoice_projects
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_projects_org_idx    ON smrtvoice_projects(org_id);
CREATE INDEX IF NOT EXISTS smrtvoice_projects_status_idx ON smrtvoice_projects(org_id, status);


-- ─── 4. LINES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES smrtvoice_projects(id) ON DELETE CASCADE,

  line_number     integer NOT NULL,
  scene_title     text,

  speaker_name    text NOT NULL,
  character_id    uuid REFERENCES smrtvoice_characters(id),

  text_raw        text NOT NULL,
  text_clean      text NOT NULL,
  text_pointed    text,
  text_for_tts    text,

  directions      text[],

  llm_processed     boolean NOT NULL DEFAULT false,
  llm_processed_at  timestamptz,
  emotion           text,
  emotion_profile_id uuid REFERENCES smrtvoice_voice_profiles(id),
  resemble_prompt text,

  final_exaggeration numeric,
  final_pitch        numeric,
  final_pace         text,
  final_model        text,

  input_audio_path        text,
  output_audio_path       text,
  output_duration_seconds numeric,

  status              text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','processing','completed','failed','skipped'
  )),
  attempt_count       integer NOT NULL DEFAULT 0,
  error_message       text,
  generation_cost_usd numeric,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_lines_org_members" ON smrtvoice_lines
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_lines_project_idx   ON smrtvoice_lines(project_id, line_number);
CREATE INDEX IF NOT EXISTS smrtvoice_lines_status_idx    ON smrtvoice_lines(project_id, status);
CREATE INDEX IF NOT EXISTS smrtvoice_lines_character_idx ON smrtvoice_lines(character_id);


-- ─── 5. JOBS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES smrtvoice_projects(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  job_type        text NOT NULL CHECK (job_type IN (
    'parse_script','preprocess_lines','generate_audio','regenerate_line','archive_project'
  )),

  voice_engine_job_id text,
  adapter         text NOT NULL DEFAULT 'resemble' CHECK (adapter IN (
    'resemble','chatterbox_local','chatterbox_runpod'
  )),

  status          text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','running','completed','failed','cancelled'
  )),
  progress        integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),

  result          jsonb,
  error_message   text,
  total_cost_usd  numeric,

  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_jobs_org_members" ON smrtvoice_jobs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_jobs_project_idx ON smrtvoice_jobs(project_id);
CREATE INDEX IF NOT EXISTS smrtvoice_jobs_status_idx  ON smrtvoice_jobs(org_id, status);


-- ─── 6. VOICE_SAMPLES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_voice_samples (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  character_id    uuid NOT NULL REFERENCES smrtvoice_characters(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  storage_path     text NOT NULL,
  duration_seconds numeric,
  file_size_bytes  integer,
  notes            text,

  uploaded_to_resemble boolean NOT NULL DEFAULT false,
  resemble_sample_id   text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_voice_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_voice_samples_org_members" ON smrtvoice_voice_samples
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_voice_samples_character_idx ON smrtvoice_voice_samples(character_id);


-- ─── 7. PRONUNCIATION_LEXICON ────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_pronunciation_lexicon (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),

  original_word   text NOT NULL,
  pronounced_as   text NOT NULL,
  category        text DEFAULT 'general' CHECK (category IN (
    'general','chabad','name','theophilic_name','place','foreign'
  )),
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, original_word)
);

ALTER TABLE smrtvoice_pronunciation_lexicon ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_pronunciation_lexicon_org_members" ON smrtvoice_pronunciation_lexicon
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtvoice_pronunciation_lexicon_org_idx ON smrtvoice_pronunciation_lexicon(org_id);


-- ─── 8. SETTINGS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smrtvoice_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

  monthly_budget_usd       numeric NOT NULL DEFAULT 100,
  budget_warning_threshold numeric NOT NULL DEFAULT 0.8,
  budget_block_threshold   numeric NOT NULL DEFAULT 1.0,

  default_adapter text NOT NULL DEFAULT 'resemble' CHECK (default_adapter IN (
    'resemble','chatterbox_local','chatterbox_runpod'
  )),

  default_resemble_model text DEFAULT 'chatterbox',

  archive_after_days       integer NOT NULL DEFAULT 30,
  archive_auto_enabled     boolean NOT NULL DEFAULT true,
  gdrive_archive_folder_id  text,
  gdrive_archive_folder_url text,

  project_folder_template text NOT NULL DEFAULT 'smrtVoice_{project_name}{lang_suffix}',
  audio_file_template     text NOT NULL DEFAULT '{line:03d}_{speaker}',

  notify_on_completion   boolean NOT NULL DEFAULT true,
  notify_on_budget_warn  boolean NOT NULL DEFAULT true,
  notify_via_whatsapp    boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvoice_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtvoice_settings_org_members" ON smrtvoice_settings
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));


-- ─── TRIGGERS ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION smrtvoice_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS smrtvoice_characters_updated_at ON smrtvoice_characters;
CREATE TRIGGER smrtvoice_characters_updated_at BEFORE UPDATE ON smrtvoice_characters
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

DROP TRIGGER IF EXISTS smrtvoice_voice_profiles_updated_at ON smrtvoice_voice_profiles;
CREATE TRIGGER smrtvoice_voice_profiles_updated_at BEFORE UPDATE ON smrtvoice_voice_profiles
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

DROP TRIGGER IF EXISTS smrtvoice_projects_updated_at ON smrtvoice_projects;
CREATE TRIGGER smrtvoice_projects_updated_at BEFORE UPDATE ON smrtvoice_projects
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

DROP TRIGGER IF EXISTS smrtvoice_lines_updated_at ON smrtvoice_lines;
CREATE TRIGGER smrtvoice_lines_updated_at BEFORE UPDATE ON smrtvoice_lines
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

DROP TRIGGER IF EXISTS smrtvoice_jobs_updated_at ON smrtvoice_jobs;
CREATE TRIGGER smrtvoice_jobs_updated_at BEFORE UPDATE ON smrtvoice_jobs
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

DROP TRIGGER IF EXISTS smrtvoice_pronunciation_lexicon_updated_at ON smrtvoice_pronunciation_lexicon;
CREATE TRIGGER smrtvoice_pronunciation_lexicon_updated_at BEFORE UPDATE ON smrtvoice_pronunciation_lexicon
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();

DROP TRIGGER IF EXISTS smrtvoice_settings_updated_at ON smrtvoice_settings;
CREATE TRIGGER smrtvoice_settings_updated_at BEFORE UPDATE ON smrtvoice_settings
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();


-- ─── RPC: increment_project_progress ─────────────────────────
-- Used by the webhook handler after each smrtvoice.line.completed.
CREATE OR REPLACE FUNCTION increment_project_progress(
  p_project_id uuid,
  p_cost       numeric,
  p_duration   numeric
)
RETURNS void AS $$
BEGIN
  UPDATE smrtvoice_projects
     SET completed_lines        = completed_lines + 1,
         total_cost_usd         = COALESCE(total_cost_usd, 0)         + COALESCE(p_cost, 0),
         total_duration_seconds = COALESCE(total_duration_seconds, 0) + COALESCE(p_duration, 0)
   WHERE id = p_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
